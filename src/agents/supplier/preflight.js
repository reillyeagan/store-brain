/**
 * Supply Pre-flight (sup.preflight) — plain code, SHADOW (flags only).
 *
 * What it does: looks at recent order lines and flags the ones likely to fail at KFB before
 * KFB gets to them:
 *   denied           KFB's latest word on the product is "denied"
 *   drafted          the product is in a batch proposing it for draft
 *   size_complaints  customers complained about this product in the size ordered
 *   no_fit           the Size Checker found no factory size that fits the size ordered
 *   no_quote         selling with no quote on file (cost unknown). Only raised once that store's
 *                    quotes are wired, otherwise every line would be "no quote".
 * Also `preflightProduct()`: the pre-publish gate Catalog calls ("blocks products with no
 * confirmed supply line (quoted, not denied)").
 *
 * Inputs: order_lines, orders, kfb_quotes, supplier_plans, size_complaints, size_recommendations.
 * Output: supply_flags (one per line per kind, never repeated), one event per run with new flags.
 */
import { LIVE_STORE_IDS } from "../../config/stores.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { PRICE_CEILING } from "./pricing.js";

const ACTOR = "sup.preflight";
export const LOOKBACK_DAYS = 3;

/** The latest product-level quote per (store, handle). Reused by the state page. */
export const LATEST_QUOTE_SQL = `SELECT q.* FROM kfb_quotes q
  WHERE q.variant_id = '' AND q.id = (SELECT q2.id FROM kfb_quotes q2 WHERE q2.store = q.store AND q2.product_handle = q.product_handle
     AND q2.variant_id = '' ORDER BY q2.quoted_at DESC, q2.id DESC LIMIT 1)`;

export async function runPreflight(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  if (!LIVE_STORE_IDS.length) return { added: 0 };
  const at = nowIso(nowMs);
  const since = nowIso(nowMs - LOOKBACK_DAYS * 86400000);
  const marks = LIVE_STORE_IDS.map(() => "?").join(",");
  const recent = `SELECT l.*, o.name AS order_name FROM order_lines l JOIN orders o ON o.store = l.store AND o.order_id = l.order_id
     WHERE l.store IN (${marks}) AND o.created_at >= ? AND COALESCE(o.financial_status,'') NOT IN ('refunded','voided')`;
  const args = [...LIVE_STORE_IDS, since];
  const ins = `INSERT OR IGNORE INTO supply_flags (store, order_id, order_name, line_id, product_handle, title, kind, detail, created_at)`;

  const checks = [
    // KFB denied it.
    db.prepare(`${ins} SELECT r.store, r.order_id, r.order_name, r.line_id, r.product_handle, r.title, 'denied',
        'KFB denied this product' || COALESCE(': "' || q.remark || '"', '') || ' (' || substr(q.quoted_at, 1, 10) || ')', ?
        FROM (${recent}) r JOIN (${LATEST_QUOTE_SQL}) q ON q.store = r.store AND q.product_handle = r.product_handle
       WHERE q.status = 'denied'`).bind(at, ...args),
    // Proposed for draft (pending or approved batch).
    db.prepare(`${ins} SELECT DISTINCT r.store, r.order_id, r.order_name, r.line_id, r.product_handle, r.title, 'drafted',
        'Proposed for draft in supplier batch ' || p.batch_id, ?
        FROM (${recent}) r JOIN supplier_plans p ON p.store = r.store AND p.product_handle = r.product_handle AND p.kind = 'draft'
        JOIN supplier_batches b ON b.id = p.batch_id LEFT JOIN approvals a ON a.id = b.approval_id
       WHERE COALESCE(a.status, 'pending') IN ('pending', 'approved', 'executed')`).bind(at, ...args),
    // Complaints for this size.
    db.prepare(`${ins} SELECT r.store, r.order_id, r.order_name, r.line_id, r.product_handle, r.title, 'size_complaints',
        COUNT(c.id) || ' sizing complaint(s) on this product in size ' || r.size, ?
        FROM (${recent}) r JOIN size_complaints c ON c.store = r.store AND c.product_id = r.product_id AND UPPER(c.size_ordered) = UPPER(r.size)
       GROUP BY r.store, r.line_id`).bind(at, ...args),
    // Nothing fits.
    db.prepare(`${ins} SELECT r.store, r.order_id, r.order_name, r.line_id, r.product_handle, r.title, 'no_fit', s.reason, ?
        FROM (${recent}) r JOIN size_recommendations s ON s.store = r.store AND s.line_id = r.line_id WHERE s.verdict = 'no_fit'`).bind(at, ...args),
    // Selling with no quote, only for stores whose quotes are wired (have any rows).
    db.prepare(`${ins} SELECT r.store, r.order_id, r.order_name, r.line_id, r.product_handle, r.title, 'no_quote',
        'Selling with no KFB quote on file (cost unknown)', ?
        FROM (${recent}) r
       WHERE r.product_handle IS NOT NULL
         AND EXISTS (SELECT 1 FROM kfb_quotes w WHERE w.store = r.store)
         AND NOT EXISTS (SELECT 1 FROM kfb_quotes q WHERE q.store = r.store AND q.product_handle = r.product_handle AND q.status = 'quoted')`).bind(at, ...args),
  ];
  let added = 0;
  for (const c of checks) { const r = await c.run(); added += (r.meta && r.meta.changes) || 0; }
  if (added) {
    const { results } = await db.prepare(`SELECT kind, COUNT(*) AS n FROM supply_flags WHERE created_at = ? GROUP BY kind`).bind(at).all();
    await logEvent(db, {
      actor: ACTOR, kind: "preflight.flagged", target: "ful.order_watch", at,
      summary: `Supply pre-flight: ${added} order line${added === 1 ? "" : "s"} likely to have supply trouble (${(results || []).map((x) => `${x.n} ${x.kind.replace(/_/g, " ")}`).join(", ")})`,
      data: { added, kinds: results },
    });
  }
  return { added };
}

/**
 * Pre-publish gate for one product (Catalog's New-Product Check calls this). Pure read.
 * ok only with a confirmed supply line: the latest product quote is "quoted", not denied.
 */
export async function preflightProduct(db, store, handle, { price = null } = {}) {
  const q = await db.prepare(`SELECT * FROM (${LATEST_QUOTE_SQL}) WHERE store = ? AND product_handle = ?`).bind(store, handle).first();
  const reasons = [];
  if (!q) reasons.push("no KFB quote on file: no confirmed supply line");
  else if (q.status === "denied") reasons.push(`KFB denied it${q.remark ? `: "${q.remark}"` : ""}`);
  else if (q.status !== "quoted") reasons.push(`latest KFB status is "${q.status}", not quoted`);
  if (price != null && Number(price) > PRICE_CEILING) reasons.push(`price $${Number(price).toFixed(2)} is above the $${PRICE_CEILING} ceiling`);
  return { ok: reasons.length === 0, reasons, quote: q || null };
}
