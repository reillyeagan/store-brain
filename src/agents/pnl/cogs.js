/**
 * COGS Matcher (pnl.cogs) — plain code, L2, shadow-safe (reads the ledger, writes only the
 * ledger: cogs_matches, pnl_days via the normal P&L recompute, events, and an approval when a
 * cost looks too good to be true).
 *
 * What it does: matches KFB bill lines to Shopify orders and gives the P&L the ACTUAL cost of
 * each matched order, replacing the estimate for that order (src/lib/pnl.js actualCosts).
 * Rules (docs/specs/pnl-finance.md, COGS Matcher):
 *   - Store attribution by KFB shop code, never by order number (19 numbers are shared
 *     across stores). A line whose shop code isn't a known store is left unmatched.
 *   - Cost = parent + ALL suborders, including fees and shipping. Never filtered by price > 0.
 *     An order's cost is always summed from EVERY line for it on EVERY bill, never from one
 *     batch of lines, so an order split across bills can't be booked part-billed.
 *   - EUR → USD at the EXACT card rate (decision 3): the bill's `usd_charged` ÷ its EUR total.
 *     A bill without the card amount leaves its orders "waiting_fx": still an estimate in the
 *     P&L, never converted at a guessed rate.
 *   - Good news gets more scrutiny (rule 5): an actual cost under half the estimate usually
 *     means a suborder isn't billed yet. It is held (`low_hold`, the P&L keeps the estimate)
 *     until a later bill raises it, or Reilly confirms that exact amount (one approval).
 * Work per run is bounded: only bills that are new or changed since they were last matched
 * (kfb_bills.matched_sig), BILLS_PER_RUN at a time.
 * Inputs: kfb_bills, kfb_bill_lines (empty until the KFB morning session can read bills),
 * orders, the Core COGS rate. Outputs: cogs_matches, recomputed pnl_days rows, cogs.* events.
 * Today: the engine is built; with no bills it reports "waiting on KFB bills" and does nothing.
 */
import { STORES, STORE_IDS } from "../../config/stores.js";
import { logEvent } from "../../lib/eventlog.js";
import { createApproval, getApproval } from "../../lib/approvals.js";
import { nowIso } from "../../lib/time.js";
import { computeStoreDay, writePnlRow, cogsRate, orderGross } from "../../lib/pnl.js";
import { r2, r4, normRef } from "../core/shared.js";

const ACTOR = "pnl.cogs";
export const BILLS_PER_RUN = 50;       // new/changed bills matched per run
export const APPLY_DAYS_PER_RUN = 10;  // P&L days recomputed per run (bounded work)
export const HOLD_ASKS_PER_RUN = 5;    // approvals about low costs per run
export const LOW_VS_ESTIMATE = 0.5;

const storeByCode = (code) => STORE_IDS.find((id) => STORES[id].kfbShopCode && STORES[id].kfbShopCode === String(code || "").trim()) || null;
const lineEur = (l) => (Number(l.cost_eur) || 0) + (Number(l.fees_eur) || 0) + (Number(l.shipping_eur) || 0);
const marks = (n) => Array.from({ length: n }, () => "?").join(", ");

/** Pure: the exact EUR→USD rate of one bill, or null (no card amount, or no EUR total). */
export function billRate(bill, linesEur) {
  const eur = Number(bill.total_eur) > 0 ? Number(bill.total_eur) : linesEur;
  const usd = Number(bill.usd_charged);
  return eur > 0 && usd > 0 ? usd / eur : null;
}

/**
 * Pure: group bill lines into per-order costs.
 * @param lines rows of kfb_bill_lines joined with their bill (code, usd_charged, total_eur)
 * @param billEurTotals optional Map bill_id → EUR sum of ALL that bill's lines (when `lines`
 *        holds only part of a bill); defaults to the sum of the lines given
 */
export function groupLines(lines, billEurTotals = null) {
  const billEur = billEurTotals || new Map();
  if (!billEurTotals) for (const l of lines) billEur.set(l.bill_id, (billEur.get(l.bill_id) || 0) + lineEur(l));
  const rates = new Map();
  for (const l of lines) if (!rates.has(l.bill_id)) rates.set(l.bill_id, billRate(l, billEur.get(l.bill_id) || 0));
  const orders = new Map();
  const unmatched = [];
  for (const l of lines) {
    const store = storeByCode(l.code);
    const ref = normRef(l.order_ref);
    if (!store || !ref) { unmatched.push({ bill_id: l.bill_id, line_no: l.line_no, reason: !store ? `unknown KFB shop code "${l.code || ""}"` : "no order number" }); continue; }
    const k = `${store}|${ref}`;
    if (!orders.has(k)) orders.set(k, { store, ref, code: String(l.code).trim(), cost_eur: 0, usd_parts: [], bill_ids: new Set(), lines: 0 });
    const o = orders.get(k);
    const eur = lineEur(l);
    o.cost_eur += eur;
    o.usd_parts.push(rates.get(l.bill_id) == null ? null : eur * rates.get(l.bill_id));
    o.bill_ids.add(l.bill_id);
    o.lines++;
  }
  for (const o of orders.values()) {
    o.cost_eur = r2(o.cost_eur);
    o.cost_usd = o.usd_parts.some((x) => x == null) ? null : r2(o.usd_parts.reduce((s, x) => s + x, 0));
    o.bill_ids = [...o.bill_ids].sort();
    delete o.usd_parts;
  }
  return { orders, unmatched };
}

/** Pure: an order's status from its cost, its estimate and what Reilly confirmed. */
export function matchStatus(costUsd, estimateUsd, confirmedUsd = null) {
  if (costUsd == null) return "waiting_fx";
  if (estimateUsd && costUsd < LOW_VS_ESTIMATE * estimateUsd) {
    return confirmedUsd != null && Math.abs(Number(confirmedUsd) - costUsd) < 0.005 ? "matched" : "low_hold";
  }
  return "matched";
}

const LINE_SELECT = `SELECT l.*, COALESCE(l.kfb_shop_code, b.kfb_shop_code) AS code, b.usd_charged, b.total_eur
  FROM kfb_bill_lines l JOIN kfb_bills b ON b.bill_id = l.bill_id`;

/** Every bill's current signature; the ones that differ from what was last matched. */
async function changedBills(db) {
  const { results } = await db.prepare(
    `SELECT b.bill_id, b.matched_sig, COALESCE(b.usd_charged, '') || '|' || COALESCE(b.total_eur, '') || '|' || COALESCE(b.kfb_shop_code, '') || '|' ||
            COUNT(l.line_no) || '|' || ROUND(COALESCE(SUM(COALESCE(l.cost_eur,0) + COALESCE(l.fees_eur,0) + COALESCE(l.shipping_eur,0)), 0), 4) || '|' ||
            COALESCE(GROUP_CONCAT(COALESCE(l.kfb_shop_code,'') || ':' || COALESCE(l.order_ref,''), ','), '') AS sig
       FROM kfb_bills b LEFT JOIN kfb_bill_lines l ON l.bill_id = b.bill_id GROUP BY b.bill_id ORDER BY b.bill_id`
  ).all();
  return (results || []).filter((b) => b.matched_sig !== b.sig);
}

/**
 * Match new/changed bills to their orders, store each touched order's full cost, then
 * recompute the P&L days whose costs changed (a few per run; the rest next run).
 */
export async function matchBills(db, { nowMs = Date.now() } = {}) {
  const at = nowIso(nowMs);
  const anyBill = await db.prepare(`SELECT bill_id FROM kfb_bills LIMIT 1`).first();
  if (!anyBill) return { status: "waiting on KFB bills", bills: 0, matched: 0, waiting_fx: 0, low_hold: 0, unmatched: 0, applied: 0 };
  const confirmed = await confirmHolds(db, { nowMs });
  const todo = (await changedBills(db)).slice(0, BILLS_PER_RUN);
  let matched = 0, waitingFx = 0, held = 0, changed = 0, notInLedger = 0, asked = 0;
  const unmatched = [];
  if (todo.length) {
    // 1. Every line of the changed bills → the orders they touch.
    const ids = todo.map((b) => b.bill_id);
    const { results: billLines } = await db.prepare(`${LINE_SELECT} WHERE l.bill_id IN (${marks(ids.length)})`).bind(...ids).all();
    const touched = groupLines(billLines || []);
    unmatched.push(...touched.unmatched);
    // 2. For each touched order: EVERY line for it, on every bill (an order can be split across bills).
    const rates = new Map();
    for (const t of touched.orders.values()) {
      const refs = [t.ref, `#${t.ref}`];
      const { results: all } = await db.prepare(
        `${LINE_SELECT} WHERE COALESCE(l.kfb_shop_code, b.kfb_shop_code) = ? AND trim(l.order_ref) IN (?, ?)`
      ).bind(t.code, ...refs).all();
      const billIds = [...new Set((all || []).map((l) => l.bill_id))];
      const { results: sums } = await db.prepare(
        `SELECT bill_id, SUM(COALESCE(cost_eur,0) + COALESCE(fees_eur,0) + COALESCE(shipping_eur,0)) AS eur FROM kfb_bill_lines WHERE bill_id IN (${marks(billIds.length)}) GROUP BY bill_id`
      ).bind(...billIds).all();
      const o = groupLines(all || [], new Map((sums || []).map((s) => [s.bill_id, Number(s.eur) || 0]))).orders.get(`${t.store}|${t.ref}`);
      if (!o) continue;
      const ord = await db.prepare(`SELECT order_id, name, local_day, total, raw FROM orders WHERE store = ? AND (name = ? OR name = ?) LIMIT 2`).bind(o.store, `#${o.ref}`, o.ref).all();
      const found = ord.results || [];
      if (found.length !== 1) { notInLedger++; unmatched.push({ store: o.store, order_ref: o.ref, reason: found.length ? "order number matches more than one order" : "order not in the ledger" }); continue; }
      const row = found[0];
      if (!rates.has(o.store)) rates.set(o.store, await cogsRate(db, o.store));
      const gross = orderGross(row).gross;
      const est = gross != null ? r2(gross * rates.get(o.store).rate) : null;
      const prev = await db.prepare(`SELECT * FROM cogs_matches WHERE store = ? AND order_id = ?`).bind(o.store, row.order_id).first();
      const status = matchStatus(o.cost_usd, est, prev ? prev.confirmed_cost_usd : null);
      if (status === "matched") matched++; else if (status === "waiting_fx") waitingFx++; else held++;
      const same = prev && prev.status === status && Math.abs(Number(prev.cost_eur) - o.cost_eur) < 0.005 &&
        ((prev.cost_usd == null && o.cost_usd == null) || (prev.cost_usd != null && o.cost_usd != null && Math.abs(Number(prev.cost_usd) - o.cost_usd) < 0.005));
      if (same) continue;
      changed++;
      await db.prepare(
        `INSERT INTO cogs_matches (store, order_id, order_name, local_day, cost_eur, cost_usd, fx_rate, status, bill_ids, line_count, matched_at, applied_at, estimate_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(store, order_id) DO UPDATE SET cost_eur = excluded.cost_eur, cost_usd = excluded.cost_usd, fx_rate = excluded.fx_rate,
           status = excluded.status, bill_ids = excluded.bill_ids, line_count = excluded.line_count, matched_at = excluded.matched_at, applied_at = NULL,
           local_day = excluded.local_day, order_name = excluded.order_name, estimate_usd = excluded.estimate_usd`
      ).bind(o.store, row.order_id, row.name, row.local_day, o.cost_eur, o.cost_usd, o.cost_usd != null && o.cost_eur ? r4(o.cost_usd / o.cost_eur) : null,
        status, JSON.stringify(o.bill_ids), o.lines, at, est).run();
      if (status === "low_hold") {
        await logEvent(db, {
          actor: ACTOR, kind: "cogs.low_vs_estimate", store: o.store,
          summary: `${STORES[o.store].name} ${row.name}: KFB cost $${o.cost_usd.toFixed(2)} is under half the estimate ($${est.toFixed(2)}); held as an estimate until a later bill or your OK (a suborder may not be billed yet)`,
          data: { order_id: row.order_id, cost_usd: o.cost_usd, estimate: est, bill_ids: o.bill_ids }, at,
        });
      }
    }
    // 3. Remember what was matched, so these bills aren't re-read until they change.
    for (const b of todo) await db.prepare(`UPDATE kfb_bills SET matched_sig = ? WHERE bill_id = ?`).bind(b.sig, b.bill_id).run();
  }
  asked = await askAboutHolds(db, { nowMs });
  const applied = await applyToPnl(db, { nowMs });
  if (changed) {
    await logEvent(db, {
      actor: ACTOR, kind: "cogs.matched", target: "pnl.ledger",
      summary: `KFB bills: ${changed} order cost${changed === 1 ? "" : "s"} updated (${matched} at the card rate, ${waitingFx} waiting on the card amount, ${held} held as too low, ${unmatched.length} line/order${unmatched.length === 1 ? "" : "s"} unmatched)`,
      data: { changed, matched, waiting_fx: waitingFx, low_hold: held, unmatched: unmatched.slice(0, 20), applied }, at,
    });
  }
  return { status: "running", bills: todo.length, matched, waiting_fx: waitingFx, low_hold: held, unmatched: unmatched.length, not_in_ledger: notInLedger, changed, applied: applied.length, asked, confirmed };
}

/** One approval per held order (none while one is pending for it). */
async function askAboutHolds(db, { nowMs }) {
  const { results } = await db.prepare(`SELECT * FROM cogs_matches WHERE status = 'low_hold' ORDER BY matched_at LIMIT 50`).all();
  let asked = 0;
  for (const m of results || []) {
    if (asked >= HOLD_ASKS_PER_RUN) break;
    if (m.hold_approval_id) {
      const ap = await getApproval(db, m.hold_approval_id);
      if (ap && ap.status === "pending") continue;
      if (ap && ap.status === "rejected" && ap.title.includes(`$${Number(m.cost_usd).toFixed(2)}`)) continue; // already said no to this amount
    }
    const id = await createApproval(db, {
      dept: "pnl", requestedBy: ACTOR, store: m.store,
      title: `${STORES[m.store].name} ${m.order_name}: KFB billed $${Number(m.cost_usd).toFixed(2)}, under half the $${Number(m.estimate_usd).toFixed(2)} estimate. Is that the full cost (no suborder still to come)?`,
      options: [{ id: "use_actual", label: "Yes, use the KFB cost", detail: `The P&L books $${Number(m.cost_usd).toFixed(2)} for this order instead of the estimate.` }],
    });
    await db.prepare(`UPDATE cogs_matches SET hold_approval_id = ? WHERE store = ? AND order_id = ?`).bind(id, m.store, m.order_id).run();
    asked++;
  }
  return asked;
}

/** Reilly said yes to a held cost: that exact amount becomes the actual cost. */
async function confirmHolds(db, { nowMs }) {
  const { results } = await db.prepare(`SELECT * FROM cogs_matches WHERE status = 'low_hold' AND hold_approval_id IS NOT NULL`).all();
  let n = 0;
  for (const m of results || []) {
    const ap = await getApproval(db, m.hold_approval_id);
    if (!ap || ap.status !== "approved" || ap.choice !== "use_actual") continue;
    // The approval names the amount; a cost that changed since isn't what Reilly confirmed.
    if (!ap.title.includes(`$${Number(m.cost_usd).toFixed(2)}`)) continue;
    await db.prepare(`UPDATE cogs_matches SET status = 'matched', confirmed_cost_usd = cost_usd, matched_at = ?, applied_at = NULL WHERE store = ? AND order_id = ?`)
      .bind(nowIso(nowMs), m.store, m.order_id).run();
    n++;
  }
  return n;
}

/** Recompute the P&L days whose matches changed since they were last applied. */
export async function applyToPnl(db, { nowMs = Date.now() } = {}) {
  const at = nowIso(nowMs);
  const { results } = await db.prepare(
    `SELECT DISTINCT store, local_day FROM cogs_matches WHERE applied_at IS NULL OR applied_at < matched_at ORDER BY local_day LIMIT ?`
  ).bind(APPLY_DAYS_PER_RUN).all();
  const out = [];
  for (const r of results || []) {
    if (STORES[r.store] && STORES[r.store].live) {
      const row = await computeStoreDay(db, r.store, r.local_day, { nowMs });
      await writePnlRow(db, row, at);
      out.push({ store: r.store, day: r.local_day, cogs_source: row.cogs_source });
    }
    // A store that isn't live gets no P&L rows; its matches are marked done so they never
    // block the queue (the cost is kept and used once the store goes live and is recomputed).
    await db.prepare(`UPDATE cogs_matches SET applied_at = ? WHERE store = ? AND local_day = ?`).bind(at, r.store, r.local_day).run();
  }
  return out;
}

export async function cogsState(db) {
  const n = async (sql) => ((await db.prepare(sql).first()) || {}).n || 0;
  const bills = await n(`SELECT COUNT(*) AS n FROM kfb_bills`);
  const lines = await n(`SELECT COUNT(*) AS n FROM kfb_bill_lines`);
  const { results: byStatus } = await db.prepare(`SELECT store, status, COUNT(*) AS n, SUM(cost_usd) AS usd FROM cogs_matches GROUP BY store, status`).all();
  const noFx = await n(`SELECT COUNT(*) AS n FROM kfb_bills WHERE usd_charged IS NULL`);
  const { results: holds } = await db.prepare(`SELECT store, order_name, cost_usd, estimate_usd, hold_approval_id FROM cogs_matches WHERE status = 'low_hold' ORDER BY matched_at DESC LIMIT 20`).all();
  return {
    status: bills ? "running" : "waiting on KFB bills",
    why: bills ? null : "KFB bills can't be read yet: the KFB morning session (view only) isn't built. The matching engine is ready.",
    bills, lines, bills_without_card_amount: noFx,
    matches: byStatus || [], held_as_too_low: holds || [],
  };
}
