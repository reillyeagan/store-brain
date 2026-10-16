/**
 * Shopify Payments puller — exact balance, payouts and balance transactions per store.
 *
 * Why: the old tracker ESTIMATED payouts. This reads them from Shopify Payments with each
 * store's own app (scopes read_shopify_payments_payouts + read_shopify_payments_accounts).
 *
 * Rules (docs/specs/pnl-finance.md, "Exact Shopify payouts"):
 *  - Dedupe by id, NEVER by amount: two identical $67.62 payouts are normal.
 *  - Pending (SCHEDULED) and PAID are kept separate (the status column).
 *  - A PAID payout must equal the sum of its balance transactions' net, to the cent.
 *    Otherwise: a `payout.mismatch` event. If we can't be sure we saw every transaction,
 *    the check is "unverified" and retried, never reported as a mismatch (rule 6).
 *
 * Query cost (Shopify refuses anything over 1,000 points), split into small queries:
 *   summary: balance + 20 payouts ≈ 45 points
 *   transactions: 100 per page × ~6 points ≈ 600 points
 * Field names checked against the Admin GraphQL schema (2026-07/2026-10), 2026-10-11.
 *
 * A store without Shopify Payments (account is null, or access denied) is logged ONCE
 * and its payouts feed stays "not wired". It is never shown as failing.
 */
import { LIVE_STORE_IDS, STORES, HISTORY_FROM } from "../config/stores.js";
import { shopifyGraphQL } from "./storeGuard.js";
import { markFeedOk, markFeedFailed } from "./freshness.js";
import { logEvent } from "./eventlog.js";
import { nowIso } from "./time.js";

export const PAYOUTS_SUMMARY = `query PaymentsSummary {
  shopifyPaymentsAccount {
    id
    balance { amount currencyCode }
    payouts(first: 20, sortKey: ISSUED_AT, reverse: true) {
      nodes { id legacyResourceId issuedAt status net { amount currencyCode } }
    }
  }
}`;

export const TXNS_PER_PAGE = 100;
export const BALANCE_TXNS = `query BalanceTxns($first: Int!, $after: String, $query: String) {
  shopifyPaymentsAccount {
    balanceTransactions(first: $first, after: $after, query: $query, sortKey: PROCESSED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id type test transactionDate
        amount { amount currencyCode } fee { amount } net { amount }
        associatedPayout { id status }
        associatedOrder { id }
        sourceOrderTransactionId
      }
    }
  }
}`;

/** Paid payouts checked per run, and pages read per payout (bounds the cost of one run). */
export const CHECKS_PER_RUN = 5;
export const MAX_PAGES_PER_PAYOUT = 5;

/** The payout's own movement out of the balance, not part of what it is made of. */
const PAYOUT_MECHANICS = new Set(["TRANSFER", "TRANSFER_FAILURE", "TRANSFER_CANCEL", "TRANSFER_REFUND"]);

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const cents = (v) => Math.round(Number(v) * 100);

export function txnFromNode(n) {
  return {
    txn_id: n.id,
    type: n.type || null,
    date: n.transactionDate || null,
    amount: num(n.amount && n.amount.amount),
    fee: num(n.fee && n.fee.amount),
    net: num(n.net && n.net.amount),
    currency: (n.amount && n.amount.currencyCode) || null,
    payout_id: (n.associatedPayout && n.associatedPayout.id) || null,
    payout_status: (n.associatedPayout && n.associatedPayout.status) || null,
    order_id: (n.associatedOrder && n.associatedOrder.id) || null,
    test: n.test ? 1 : 0,
  };
}

/**
 * Pure: does a paid payout equal the sum of its transactions, to the cent?
 * Works in integer cents so float noise can't hide (or invent) a one-cent gap.
 */
export function checkPayout(payoutNet, txns) {
  const parts = txns.filter((t) => !t.test && !PAYOUT_MECHANICS.has(t.type));
  const sum = parts.reduce((s, t) => s + cents(t.net || 0), 0);
  const diff = cents(payoutNet) - sum;
  return { ok: diff === 0, payoutCents: cents(payoutNet), sumCents: sum, diffCents: diff, count: parts.length };
}

/** Is this error Shopify telling us the store has no Payments access (rather than a fault)? */
function noPaymentsError(err) {
  // Narrow on purpose: a schema or query error must show as failing, not hide as "no Payments".
  return err && err.code === "GRAPHQL_ERRORS" && /access denied|shopify payments (is )?not (enabled|available|set up)/i.test(err.message);
}

async function upsertTxn(db, storeId, t, at) {
  await db.prepare(
    `INSERT INTO balance_txns (store, txn_id, type, date, amount, fee, net, currency, payout_id, payout_status, order_id, test, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(store, txn_id) DO UPDATE SET type = excluded.type, date = excluded.date, amount = excluded.amount,
       fee = excluded.fee, net = excluded.net, currency = excluded.currency, payout_id = excluded.payout_id,
       payout_status = excluded.payout_status, order_id = excluded.order_id, test = excluded.test, fetched_at = excluded.fetched_at`
  ).bind(storeId, t.txn_id, t.type, t.date, t.amount, t.fee, t.net, t.currency, t.payout_id, t.payout_status, t.order_id, t.test, at).run();
}

/**
 * Read every transaction of one payout. Returns { txns, complete }.
 * `complete` is false if Shopify's filter didn't narrow to this payout (we'd see other
 * payouts' rows) or there were more pages than we read. Then we can't judge the payout.
 */
async function txnsForPayout(env, storeId, payout, opts) {
  const all = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES_PER_PAYOUT; page++) {
    const data = await shopifyGraphQL(env, storeId, BALANCE_TXNS, {
      first: TXNS_PER_PAGE, after, query: `payments_transfer_id:${payout.legacyResourceId}`,
    }, opts);
    const conn = data && data.shopifyPaymentsAccount && data.shopifyPaymentsAccount.balanceTransactions;
    if (!conn) return { txns: all, complete: false };
    const nodes = (conn.nodes || []).map(txnFromNode);
    if (nodes.some((t) => t.payout_id !== payout.id)) return { txns: all, complete: false };
    all.push(...nodes);
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) return { txns: all, complete: all.length > 0 };
    after = conn.pageInfo.endCursor;
  }
  return { txns: all, complete: false };
}

/** Pull one store. Returns a result object; throws only on a real fault. */
export async function pullStorePayouts(env, storeId, opts = {}) {
  const store = STORES[storeId];
  const at = opts.at || nowIso();
  let data;
  try {
    data = await shopifyGraphQL(env, storeId, PAYOUTS_SUMMARY, {}, opts);
  } catch (err) {
    if (noPaymentsError(err)) return { store: storeId, ok: false, noPayments: true, reason: err.message };
    throw err;
  }
  const acct = data && data.shopifyPaymentsAccount;
  if (!acct) return { store: storeId, ok: false, noPayments: true, reason: "no Shopify Payments account" };

  // Balance: one row per currency in Shopify; we keep the store's main (first) one.
  const bal = Array.isArray(acct.balance) ? acct.balance : acct.balance ? [acct.balance] : [];
  if (bal.length) {
    await env.DB.prepare(
      `INSERT INTO money_balances (source, store, amount, currency, as_of) VALUES ('shopify_payments', ?, ?, ?, ?)
       ON CONFLICT(source, store) DO UPDATE SET amount = excluded.amount, currency = excluded.currency, as_of = excluded.as_of`
    ).bind(storeId, num(bal[0].amount) ?? 0, bal[0].currencyCode || null, at).run();
  }

  // Payouts, by id.
  const payouts = (acct.payouts && acct.payouts.nodes) || [];
  let newPayouts = 0;
  for (const p of payouts) {
    const before = await env.DB.prepare(`SELECT status FROM payouts WHERE store = ? AND payout_id = ?`).bind(storeId, p.id).first();
    await env.DB.prepare(
      `INSERT INTO payouts (store, payout_id, issued_at, status, net, currency, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(store, payout_id) DO UPDATE SET issued_at = excluded.issued_at, status = excluded.status,
         net = excluded.net, currency = excluded.currency, fetched_at = excluded.fetched_at,
         check_result = CASE WHEN payouts.status = excluded.status THEN payouts.check_result ELSE NULL END`
    ).bind(storeId, p.id, p.issuedAt || null, p.status || null, num(p.net && p.net.amount), (p.net && p.net.currencyCode) || null, at).run();
    if (!before) newPayouts++;
  }

  // Recent transactions (the newest page) so the ledger sees charges/fees before payout.
  const recent = await shopifyGraphQL(env, storeId, BALANCE_TXNS, { first: TXNS_PER_PAGE, after: null, query: null }, opts);
  const recentNodes = (recent && recent.shopifyPaymentsAccount && recent.shopifyPaymentsAccount.balanceTransactions &&
    recent.shopifyPaymentsAccount.balanceTransactions.nodes) || [];
  for (const n of recentNodes) await upsertTxn(env.DB, storeId, txnFromNode(n), at);

  // History: page back through every older transaction until the store's history start, a
  // couple of pages per run (live 2026-10-16: fees were only known from 2026-09-26, so every
  // earlier day's profit was blank). Pages go back from the newest without gaps, so the
  // ledger's "fees known from" date (the oldest transaction) stays honest.
  const history = await backfillTxns(env, storeId, opts, at).catch((err) => ({ error: String(err && err.message).slice(0, 120) }));

  // Check PAID payouts not yet matched (newest first, a few per run).
  const toCheck = [];
  for (const p of payouts) {
    if (p.status !== "PAID") continue;
    const row = await env.DB.prepare(`SELECT check_result FROM payouts WHERE store = ? AND payout_id = ?`).bind(storeId, p.id).first();
    if (row && (row.check_result === "match" || row.check_result === "mismatch")) continue;
    toCheck.push(p);
    if (toCheck.length >= CHECKS_PER_RUN) break;
  }
  const checks = [];
  for (const p of toCheck) {
    const { txns, complete } = await txnsForPayout(env, storeId, p, opts);
    for (const t of txns) await upsertTxn(env.DB, storeId, t, at);
    const net = num(p.net && p.net.amount);
    let result = "unverified";
    let c = null;
    if (complete && net != null) {
      c = checkPayout(net, txns);
      result = c.ok ? "match" : "mismatch";
    }
    await env.DB.prepare(`UPDATE payouts SET check_result = ?, checked_at = ? WHERE store = ? AND payout_id = ?`)
      .bind(result, at, storeId, p.id).run();
    if (result === "mismatch") {
      await logEvent(env.DB, {
        actor: "pnl.money_map", kind: "payout.mismatch", store: storeId, target: "sys.shopify",
        summary: `${store.name}: payout of ${(c.payoutCents / 100).toFixed(2)} on ${String(p.issuedAt || "").slice(0, 10)} doesn't match its ${c.count} transactions (they add up to ${(c.sumCents / 100).toFixed(2)}, off by ${(c.diffCents / 100).toFixed(2)})`,
        data: { payoutId: p.id, payoutCents: c.payoutCents, sumCents: c.sumCents, diffCents: c.diffCents }, at,
      });
    }
    checks.push({ payout: p.id, result });
  }
  return {
    store: storeId, ok: true, at,
    balance: bal.length ? { amount: num(bal[0].amount), currency: bal[0].currencyCode } : null,
    payouts: payouts.length, newPayouts, txns: recentNodes.length, checks, history,
  };
}

export const BACKFILL_PAGES_PER_RUN = 2;
const backfillJob = (storeId) => `payouts.txn_history.${storeId}`;

/**
 * Older balance transactions, newest to oldest, BACKFILL_PAGES_PER_RUN pages a run. The cursor
 * lives in job_runs (last_result = JSON {after, done, oldest}). Done when Shopify has no more
 * pages or the page reaches HISTORY_FROM.
 */
export async function backfillTxns(env, storeId, opts, at) {
  const db = env.DB;
  const job = backfillJob(storeId);
  const row = await db.prepare(`SELECT last_result FROM job_runs WHERE job = ?`).bind(job).first().catch(() => null);
  let st = {};
  try { st = row && row.last_result ? JSON.parse(row.last_result) : {}; } catch { st = {}; }
  if (st.done) return { done: true, oldest: st.oldest || null };
  let after = st.after || null, pages = 0, read = 0, oldest = st.oldest || null, done = false;
  while (pages < BACKFILL_PAGES_PER_RUN) {
    const data = await shopifyGraphQL(env, storeId, BALANCE_TXNS, { first: TXNS_PER_PAGE, after, query: null }, opts);
    const conn = data && data.shopifyPaymentsAccount && data.shopifyPaymentsAccount.balanceTransactions;
    if (!conn) break;
    pages++;
    for (const n of conn.nodes || []) {
      const t = txnFromNode(n);
      await upsertTxn(db, storeId, t, at);
      read++;
      if (t.date && (!oldest || t.date < oldest)) oldest = t.date;
    }
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage || (oldest && oldest.slice(0, 10) < HISTORY_FROM)) { done = true; break; }
    after = conn.pageInfo.endCursor;
  }
  const state = JSON.stringify({ after, done, oldest });
  await db.prepare(
    `INSERT INTO job_runs (job, last_run_at, last_result) VALUES (?, ?, ?) ON CONFLICT(job) DO UPDATE SET last_run_at = excluded.last_run_at, last_result = excluded.last_result`
  ).bind(job, at, state).run();
  return { done, pages, read, oldest };
}

/** The 6-hourly job across every live store. One store's failure never stops the others. */
export async function pullPayouts(env, opts = {}) {
  const out = [];
  for (const id of LIVE_STORE_IDS) {
    const store = STORES[id];
    const feed = `shopify.payouts.${id}`;
    const at = nowIso(opts.nowMs);
    try {
      const r = await pullStorePayouts(env, id, { ...opts, at });
      if (r.noPayments) {
        // Log once per store, then stay quiet: no Payments is a fact about the store, not a fault.
        const seen = await env.DB.prepare(`SELECT 1 AS x FROM events WHERE kind = 'payouts.unavailable' AND store = ? LIMIT 1`).bind(id).first();
        if (!seen) {
          await logEvent(env.DB, {
            actor: "pnl.money_map", kind: "payouts.unavailable", store: id, target: "sys.shopify",
            summary: `${store.name}: no Shopify Payments data (${String(r.reason).slice(0, 150)}). Payouts stay "not wired" for this store; if it does use Shopify Payments, check the app's payouts scopes`,
            at,
          });
        }
        out.push(r);
        continue;
      }
      await markFeedOk(env.DB, feed, at);
      out.push(r);
    } catch (err) {
      if (err.code === "NOT_WIRED") { out.push({ store: id, ok: false, skipped: "not wired" }); continue; }
      await markFeedFailed(env.DB, feed, err.message, at).catch(() => {});
      out.push({ store: id, ok: false, error: err.message });
    }
  }
  return out;
}
