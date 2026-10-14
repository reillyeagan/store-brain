/**
 * Claims & Credits (sup.claims) — plain code, SHADOW.
 *
 * What it does: keeps the list of money KFB owes back (cancelled-but-billed orders, defective,
 * wrong or missing items), ages it, and flags credits still unpaid after 14 days (once a week
 * per credit). It never contacts KFB; Relay will carry the claim message later.
 *
 * Reilly, 2026-10-11: "i never return things to KFB." So a claim is always for a CREDIT, never
 * a return: there is no "return" kind, and the claim text never proposes sending goods back.
 *
 * Inputs:  kfb_credits (addCredit() by hand / CS; detectCancelledBilled() from KFB bill lines of
 *          orders cancelled in Shopify; markCredited() when a credit shows on a KFB bill).
 * Outputs: aging in supplierState, flag events.
 * Unknown amounts stay null ("not known yet"), never 0.
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { STORES } from "../../config/stores.js";
import { money } from "./common.js";

const ACTOR = "sup.claims";
export const CREDIT_KINDS = Object.freeze(["cancelled_billed", "defective", "wrong_item", "missing_item", "other"]);
export const FLAG_AFTER_DAYS = 14;
export const REFLAG_EVERY_DAYS = 7;

export async function addCredit(db, c, { source = "manual", nowMs = Date.now() } = {}) {
  if (!c || !STORES[c.store] || !STORES[c.store].live) throw new Error("addCredit: a live store is required");
  if (!CREDIT_KINDS.includes(c.kind)) {
    throw new Error(`addCredit: kind must be one of ${CREDIT_KINDS.join(", ")} (credits only: Reilly never returns things to KFB)`);
  }
  const amount = c.amount == null || c.amount === "" ? null : Number(c.amount);
  if (amount != null && !(amount > 0)) throw new Error("addCredit: amount must be positive, or null when not known yet");
  const res = await db.prepare(
    `INSERT OR IGNORE INTO kfb_credits (store, kind, order_name, order_id, amount, currency, opened_at, note, source)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(c.store, c.kind, c.order_name ?? null, c.order_id ?? null, amount, amount == null ? (c.currency ?? null) : String(c.currency || "EUR").toUpperCase(),
    c.opened_at || nowIso(nowMs), c.note ?? null, source).run();
  const id = res.meta && res.meta.changes ? res.meta.last_row_id : null;
  if (id) {
    await logEvent(db, { actor: ACTOR, kind: "credit.opened", store: c.store, target: "sys.kfb", at: nowIso(nowMs),
      summary: `${STORES[c.store].name}${c.order_name ? ` ${c.order_name}` : ""}: KFB owes ${amount == null ? "an amount not known yet" : money(amount, `${String(c.currency || "EUR").toUpperCase()} `)} (${c.kind.replace(/_/g, " ")})`,
      data: { creditId: id } });
  }
  return id;
}

/** A credit appeared on a KFB bill. */
export async function markCredited(db, id, { creditRef = null, nowMs = Date.now() } = {}) {
  const r = await db.prepare(`UPDATE kfb_credits SET status = 'credited', credited_at = ?, credit_ref = ? WHERE id = ? AND status IN ('open','claimed')`)
    .bind(nowIso(nowMs), creditRef, id).run();
  return !!(r.meta && r.meta.changes);
}

/** Pure: age buckets of open credits. Totals per currency; unknown amounts counted, not summed. */
export function creditAging(rows, nowMs = Date.now()) {
  const buckets = { "0-7": 0, "8-14": 0, "15-30": 0, "30+": 0 };
  const totals = {}; let unknownAmount = 0; let oldestDays = null;
  for (const r of rows || []) {
    if (!["open", "claimed"].includes(r.status)) continue;
    const days = Math.floor((nowMs - Date.parse(r.opened_at)) / 86400000);
    buckets[days <= 7 ? "0-7" : days <= 14 ? "8-14" : days <= 30 ? "15-30" : "30+"]++;
    if (r.amount == null) unknownAmount++;
    else totals[r.currency || "EUR"] = Math.round(((totals[r.currency || "EUR"] || 0) + Number(r.amount)) * 100) / 100;
    oldestDays = oldestDays == null ? days : Math.max(oldestDays, days);
  }
  return { buckets, totals, unknownAmount, oldestDays };
}

/** KFB bills older than this are not scanned for cancelled orders (an old one is history, not a claim). */
export const CANCELLED_BILLED_LOOKBACK_DAYS = 60;

/**
 * Cancelled-but-billed (spec: "#1174, €18.15"): a KFB bill line for an order that is
 * cancelled in Shopify is money KFB owes back. One credit per order (kfb_credits UNIQUE, so
 * re-running adds nothing), amount = every line for that order, EUR. Store by KFB shop code,
 * never by order number. Reads the ledger only; nothing goes to KFB (Relay carries claims later).
 */
export async function detectCancelledBilled(db, { nowMs = Date.now() } = {}) {
  const since = nowIso(nowMs - CANCELLED_BILLED_LOOKBACK_DAYS * 86400000);
  const { results: lines } = await db.prepare(
    `SELECT COALESCE(l.kfb_shop_code, b.kfb_shop_code) AS code, trim(replace(l.order_ref, '#', '')) AS ref,
            SUM(COALESCE(l.cost_eur,0) + COALESCE(l.fees_eur,0) + COALESCE(l.shipping_eur,0)) AS eur, GROUP_CONCAT(DISTINCT l.bill_id) AS bills,
            GROUP_CONCAT(DISTINCT f.cost_basis) AS basis
       FROM kfb_bill_lines l JOIN kfb_bills b ON b.bill_id = l.bill_id LEFT JOIN kfb_bill_flags f ON f.bill_id = l.bill_id
      WHERE l.order_ref IS NOT NULL AND (b.billed_at IS NULL OR b.billed_at >= ?)
      GROUP BY code, ref`
  ).bind(since).all();
  if (!lines || !lines.length) return 0;
  let opened = 0;
  for (const id of Object.keys(STORES)) {
    const s = STORES[id];
    if (!s.live || !s.kfbShopCode) continue;
    const mine = lines.filter((l) => l.code === s.kfbShopCode && l.ref);
    if (!mine.length) continue;
    // Cancelled orders of this store, read once (webhook cancelled_at / GraphQL cancelledAt).
    const { results: orders } = await db.prepare(`SELECT order_id, name, raw FROM orders WHERE store = ? AND raw LIKE '%ancel%'`).bind(id).all();
    const cancelled = new Map();
    for (const o of orders || []) {
      let raw = null; try { raw = JSON.parse(o.raw); } catch { raw = null; }
      if (raw && (raw.cancelled_at || raw.cancelledAt || raw.cancelled === true)) cancelled.set(String(o.name).replace(/^#/, ""), o);
    }
    for (const l of mine) {
      const o = cancelled.get(String(l.ref));
      if (!o) continue;
      const eur = Math.round(Number(l.eur) * 100) / 100;
      const credit = await addCredit(db, {
        store: id, kind: "cancelled_billed", order_name: o.name, order_id: o.order_id,
        amount: eur > 0 ? eur : null, currency: "EUR",
        // KFB's bill cost field isn't confirmed (the import records which field it used), so
        // the amount is an estimate until Reilly checks it on the bill.
        note: `cancelled in Shopify but on KFB bill ${l.bills}; amount is an ESTIMATE` +
          (l.basis ? ` (KFB cost field not confirmed: ${l.basis})` : " (KFB cost field not confirmed)"),
      }, { source: "kfb_bill", nowMs });
      if (credit) opened++;
    }
  }
  return opened;
}

export async function runClaims(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const opened = await detectCancelledBilled(db, { nowMs });
  const old = nowIso(nowMs - FLAG_AFTER_DAYS * 86400000);
  const reflag = nowIso(nowMs - REFLAG_EVERY_DAYS * 86400000);
  const { results } = await db.prepare(
    `SELECT * FROM kfb_credits WHERE status IN ('open','claimed') AND opened_at <= ? AND (last_flagged_at IS NULL OR last_flagged_at <= ?)
      ORDER BY opened_at LIMIT 50`
  ).bind(old, reflag).all();
  for (const c of results || []) {
    const days = Math.floor((nowMs - Date.parse(c.opened_at)) / 86400000);
    await logEvent(db, { actor: ACTOR, kind: "credit.overdue", store: c.store, target: "sys.kfb", at,
      summary: `${STORES[c.store] ? STORES[c.store].name : c.store}${c.order_name ? ` ${c.order_name}` : ""}: KFB credit ${c.amount == null ? "(amount not known)" : money(c.amount, `${c.currency} `)} still unpaid after ${days} days (${c.kind.replace(/_/g, " ")})`,
      data: { creditId: c.id, days } });
    await db.prepare(`UPDATE kfb_credits SET last_flagged_at = ? WHERE id = ?`).bind(at, c.id).run();
  }
  return { flagged: (results || []).length, opened };
}
