/**
 * COGS Matcher (pnl.cogs) — plain code, L2, shadow-safe (reads the ledger, writes only the
 * ledger: cogs_matches, pnl_days via the normal P&L recompute, events).
 *
 * What it does: matches KFB bill lines to Shopify orders and gives the P&L the ACTUAL cost of
 * each matched order, replacing the estimate for that order (src/lib/pnl.js actualCosts).
 * Rules (docs/specs/pnl-finance.md, COGS Matcher):
 *   - Store attribution by KFB shop code, never by order number (19 numbers are shared
 *     across stores). A line whose shop code isn't a known store is left unmatched.
 *   - Cost = parent + ALL suborders, including fees and shipping. Never filtered by price > 0.
 *   - EUR → USD at the EXACT card rate (decision 3): the bill's `usd_charged` ÷ its EUR total.
 *     A bill without the card amount leaves its orders "waiting_fx": still an estimate in the
 *     P&L, never converted at a guessed rate.
 *   - An actual cost under half the estimate is flagged (good news gets more scrutiny): it
 *     usually means a suborder hasn't been billed yet.
 * Inputs: kfb_bills, kfb_bill_lines (empty until the KFB morning session can read bills),
 * orders, the Core COGS rate. Outputs: cogs_matches, recomputed pnl_days rows, cogs.* events.
 * Today: the engine is built; with no bills it reports "waiting on KFB bills" and does nothing.
 */
import { STORES, STORE_IDS } from "../../config/stores.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { computeStoreDay, writePnlRow, cogsRate, orderGross } from "../../lib/pnl.js";
import { r2, r4, normRef } from "../core/shared.js";

const ACTOR = "pnl.cogs";
export const MAX_LINES = 5000;         // bill lines read per run
export const APPLY_DAYS_PER_RUN = 10;  // P&L days recomputed per run (bounded work)
export const LOW_VS_ESTIMATE = 0.5;

const storeByCode = (code) => STORE_IDS.find((id) => STORES[id].kfbShopCode && STORES[id].kfbShopCode === String(code || "").trim()) || null;
const lineEur = (l) => (Number(l.cost_eur) || 0) + (Number(l.fees_eur) || 0) + (Number(l.shipping_eur) || 0);

/** Pure: the exact EUR→USD rate of one bill, or null (no card amount, or no EUR total). */
export function billRate(bill, linesEur) {
  const eur = Number(bill.total_eur) > 0 ? Number(bill.total_eur) : linesEur;
  const usd = Number(bill.usd_charged);
  return eur > 0 && usd > 0 ? usd / eur : null;
}

/**
 * Pure: group bill lines into per-order costs.
 * @param lines rows of kfb_bill_lines joined with their bill (code, usd_charged, total_eur)
 * @returns {{orders: Map<string, {store, ref, cost_eur, cost_usd|null, bill_ids, lines}>, unmatched: object[]}}
 */
export function groupLines(lines) {
  const billEur = new Map();
  for (const l of lines) billEur.set(l.bill_id, (billEur.get(l.bill_id) || 0) + lineEur(l));
  const rates = new Map();
  for (const l of lines) if (!rates.has(l.bill_id)) rates.set(l.bill_id, billRate(l, billEur.get(l.bill_id)));
  const orders = new Map();
  const unmatched = [];
  for (const l of lines) {
    const store = storeByCode(l.code);
    const ref = normRef(l.order_ref);
    if (!store || !ref) { unmatched.push({ bill_id: l.bill_id, line_no: l.line_no, reason: !store ? `unknown KFB shop code "${l.code || ""}"` : "no order number" }); continue; }
    const k = `${store}|${ref}`;
    if (!orders.has(k)) orders.set(k, { store, ref, cost_eur: 0, usd_parts: [], bill_ids: new Set(), lines: 0 });
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

/**
 * Match every bill line to its order, store the per-order cost, then recompute the P&L days
 * whose costs changed (a few per run; the rest next run).
 */
export async function matchBills(db, { nowMs = Date.now() } = {}) {
  const at = nowIso(nowMs);
  const { results: lines } = await db.prepare(
    `SELECT l.*, COALESCE(l.kfb_shop_code, b.kfb_shop_code) AS code, b.usd_charged, b.total_eur
       FROM kfb_bill_lines l JOIN kfb_bills b ON b.bill_id = l.bill_id ORDER BY l.bill_id, l.line_no LIMIT ?`
  ).bind(MAX_LINES).all();
  if (!lines || !lines.length) return { status: "waiting on KFB bills", lines: 0, matched: 0, waiting_fx: 0, unmatched: 0, applied: 0 };
  const { orders, unmatched } = groupLines(lines);
  let matched = 0, waitingFx = 0, changed = 0, notInLedger = 0;
  const rates = new Map();
  for (const o of orders.values()) {
    const ord = await db.prepare(
      `SELECT order_id, name, local_day, total, raw FROM orders WHERE store = ? AND (name = ? OR name = ?) LIMIT 2`
    ).bind(o.store, `#${o.ref}`, o.ref).all();
    const found = ord.results || [];
    if (found.length !== 1) { notInLedger++; unmatched.push({ store: o.store, order_ref: o.ref, reason: found.length ? "order number matches more than one order" : "order not in the ledger" }); continue; }
    const row = found[0];
    const status = o.cost_usd == null ? "waiting_fx" : "matched";
    if (status === "matched") matched++; else waitingFx++;
    const prev = await db.prepare(`SELECT cost_eur, cost_usd, status FROM cogs_matches WHERE store = ? AND order_id = ?`).bind(o.store, row.order_id).first();
    const same = prev && prev.status === status && Math.abs(Number(prev.cost_eur) - o.cost_eur) < 0.005 &&
      ((prev.cost_usd == null && o.cost_usd == null) || (prev.cost_usd != null && o.cost_usd != null && Math.abs(Number(prev.cost_usd) - o.cost_usd) < 0.005));
    if (same) continue;
    changed++;
    await db.prepare(
      `INSERT INTO cogs_matches (store, order_id, order_name, local_day, cost_eur, cost_usd, fx_rate, status, bill_ids, line_count, matched_at, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(store, order_id) DO UPDATE SET cost_eur = excluded.cost_eur, cost_usd = excluded.cost_usd, fx_rate = excluded.fx_rate,
         status = excluded.status, bill_ids = excluded.bill_ids, line_count = excluded.line_count, matched_at = excluded.matched_at, applied_at = NULL,
         local_day = excluded.local_day, order_name = excluded.order_name`
    ).bind(o.store, row.order_id, row.name, row.local_day, o.cost_eur, o.cost_usd, o.cost_usd != null && o.cost_eur ? r4(o.cost_usd / o.cost_eur) : null,
      status, JSON.stringify(o.bill_ids), o.lines, at).run();
    // Scrutiny for good news: a cost far under the estimate is usually a suborder not billed yet.
    if (status === "matched") {
      if (!rates.has(o.store)) rates.set(o.store, await cogsRate(db, o.store));
      const gross = orderGross(row).gross;
      const est = gross != null ? gross * rates.get(o.store).rate : null;
      if (est && o.cost_usd < LOW_VS_ESTIMATE * est) {
        await logEvent(db, {
          actor: ACTOR, kind: "cogs.low_vs_estimate", store: o.store,
          summary: `${STORES[o.store].name} ${row.name}: KFB cost $${o.cost_usd.toFixed(2)} is under half the estimate ($${est.toFixed(2)}); a suborder may not be billed yet`,
          data: { order_id: row.order_id, cost_usd: o.cost_usd, estimate: r2(est), bill_ids: o.bill_ids }, at,
        });
      }
    }
  }
  const applied = await applyToPnl(db, { nowMs });
  if (changed) {
    await logEvent(db, {
      actor: ACTOR, kind: "cogs.matched", target: "pnl.ledger",
      summary: `KFB bills: ${changed} order cost${changed === 1 ? "" : "s"} updated (${matched} at the card rate, ${waitingFx} waiting on the card amount, ${unmatched.length} line/order${unmatched.length === 1 ? "" : "s"} unmatched)`,
      data: { changed, matched, waiting_fx: waitingFx, unmatched: unmatched.slice(0, 20), applied }, at,
    });
  }
  return { status: "running", lines: lines.length, matched, waiting_fx: waitingFx, unmatched: unmatched.length, not_in_ledger: notInLedger, changed, applied: applied.length };
}

/** Recompute the P&L days whose matches changed since they were last applied. */
export async function applyToPnl(db, { nowMs = Date.now() } = {}) {
  const at = nowIso(nowMs);
  const { results } = await db.prepare(
    `SELECT DISTINCT store, local_day FROM cogs_matches WHERE applied_at IS NULL OR applied_at < matched_at ORDER BY local_day LIMIT ?`
  ).bind(APPLY_DAYS_PER_RUN).all();
  const out = [];
  for (const r of results || []) {
    if (!STORES[r.store] || !STORES[r.store].live) continue; // a store that isn't live gets no P&L rows
    const row = await computeStoreDay(db, r.store, r.local_day, { nowMs });
    await writePnlRow(db, row, at);
    await db.prepare(`UPDATE cogs_matches SET applied_at = ? WHERE store = ? AND local_day = ?`).bind(at, r.store, r.local_day).run();
    out.push({ store: r.store, day: r.local_day, cogs_source: row.cogs_source });
  }
  return out;
}

export async function cogsState(db) {
  const n = async (sql) => ((await db.prepare(sql).first()) || {}).n || 0;
  const bills = await n(`SELECT COUNT(*) AS n FROM kfb_bills`);
  const lines = await n(`SELECT COUNT(*) AS n FROM kfb_bill_lines`);
  const { results: byStatus } = await db.prepare(`SELECT store, status, COUNT(*) AS n, SUM(cost_usd) AS usd FROM cogs_matches GROUP BY store, status`).all();
  const noFx = await n(`SELECT COUNT(*) AS n FROM kfb_bills WHERE usd_charged IS NULL`);
  return {
    status: bills ? "running" : "waiting on KFB bills",
    why: bills ? null : "KFB bills can't be read yet: the KFB morning session (view only) isn't built. The matching engine is ready.",
    bills, lines, bills_without_card_amount: noFx,
    matches: byStatus || [],
  };
}
