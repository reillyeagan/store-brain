/**
 * "Similar ones" QC (sup.similar_qc) — plain code, SHADOW.
 *
 * Reilly, 2026-10-11 (spec Q4, "when is similar OK, and when must the listing change or be
 * drafted?"): "q4 always fine".
 *
 * So a QUOTE that KFB returns with an "only similar ones" remark is accepted automatically and
 * priced like an exact match (the Quote Desk does the pricing).
 *
 * Substitutions on a customer's ORDER: asked 2026-10-13 "does 'similar always fine' also cover
 * substitutions on customer orders?", Reilly: "yes". So a similar substitute on an order is
 * accepted too (it replaces the old spec rule "never send a customer a 'similar' item without
 * asking"). It is still RECORDED: verdict on the offer row plus one event per substitution,
 * so the order's history shows what actually shipped.
 *
 * Inputs:  kfb_similar_offers (filled by the KFB Morning Session, planned, or recordSimilarOffer()).
 * Outputs: a verdict on each offer (accepted | ask_reilly for an unknown context), events.
 * The spec's photo comparison (AI vision) is not built: Q4 made it unnecessary for quotes.
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { STORES } from "../../config/stores.js";
import { handleFrom } from "./common.js";

const ACTOR = "sup.similar_qc";
export const SIMILAR_RULE = Object.freeze({ words: "q4 always fine", at: "2026-10-11", means: "a similar quote is treated exactly like an exact match: priced by the rules, never drafted for being similar" });
/** Reilly's answer that the rule covers order substitutions too (the question is kept with it: the word alone says nothing). */
export const SIMILAR_ORDERS_RULE = Object.freeze({
  question: "does 'similar always fine' cover substitutions on customer orders?", words: "yes", at: "2026-10-14T00:23:00Z",
  means: "a similar substitute on a customer's order is fine: accepted, not flagged, but recorded",
});

/** Pure: the verdict for one offer. */
export function judgeSimilar(offer) {
  if (offer.context === "quote") {
    return { verdict: "accepted", reason: `Reilly: "${SIMILAR_RULE.words}": priced like an exact match, never drafted for being similar` };
  }
  if (offer.context === "order") {
    return { verdict: "accepted", reason: `Similar substitute on a customer's order: fine (Reilly, asked "${SIMILAR_ORDERS_RULE.question}": "${SIMILAR_ORDERS_RULE.words}"). Recorded, not flagged.` };
  }
  return { verdict: "ask_reilly", reason: `unknown context "${offer.context}": not covered by the rule` };
}

/** Record one offer (KFB session or by hand). Duplicates ignored. */
export async function recordSimilarOffer(db, o, { source = "manual", nowMs = Date.now() } = {}) {
  if (!o || !STORES[o.store] || !STORES[o.store].live) throw new Error("recordSimilarOffer: a live store is required");
  if (!["quote", "order"].includes(o.context)) throw new Error('recordSimilarOffer: context must be "quote" or "order"');
  const res = await db.prepare(
    `INSERT OR IGNORE INTO kfb_similar_offers (store, context, product_handle, order_name, remark, photo_url, cost, currency, received_at, source)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(o.store, o.context, handleFrom(o.link ?? o.handle) || "", o.order_name || "", o.remark ?? null, o.photo_url ?? null,
    o.cost ?? null, o.currency ?? null, o.received_at || nowIso(nowMs), source).run();
  return !!(res.meta && res.meta.changes);
}

export async function runSimilarQc(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  // New offers, plus order offers judged "ask_reilly" under the old rule: Reilly's "yes"
  // (2026-10-13) covers them too, so they are re-judged (kept, never deleted).
  const { results } = await db.prepare(
    `SELECT * FROM kfb_similar_offers WHERE verdict IS NULL OR (context = 'order' AND verdict = 'ask_reilly') ORDER BY id LIMIT 100`
  ).all();
  const expired = await expireOldOrderApprovals(db, at);
  let accepted = 0; const substitutes = []; const asks = [];
  for (const o of results || []) {
    const j = judgeSimilar(o);
    const reason = o.verdict ? `Re-judged under Reilly's 2026-10-13 answer (was ${o.verdict}): ${j.reason}` : j.reason;
    await db.prepare(`UPDATE kfb_similar_offers SET verdict = ?, verdict_reason = ?, judged_at = ? WHERE id = ?`).bind(j.verdict, reason, at, o.id).run();
    if (j.verdict !== "accepted") asks.push(o);
    else if (o.context === "order") substitutes.push(o);
    else accepted++;
  }
  if (accepted) {
    await logEvent(db, { actor: ACTOR, kind: "similar.accepted", at,
      summary: `${accepted} "only similar ones" quote${accepted === 1 ? "" : "s"} accepted per Reilly's rule ("q4 always fine")` });
  }
  // One event per order substitution: accepted, but each one stays on the record.
  for (const o of substitutes) {
    await logEvent(db, { actor: ACTOR, kind: "similar.substituted", store: o.store, at,
      summary: `${STORES[o.store] ? STORES[o.store].name : o.store} ${o.order_name || o.product_handle}: KFB fills a customer's order with a similar item: fine per Reilly ("${SIMILAR_ORDERS_RULE.words}"), recorded`,
      data: { offerId: o.id, remark: o.remark, photo: o.photo_url } });
  }
  for (const o of asks) {
    await logEvent(db, { actor: ACTOR, kind: "similar.flagged", store: o.store, target: "core.approvals", at,
      summary: `${STORES[o.store] ? STORES[o.store].name : o.store} ${o.order_name || o.product_handle}: similar offer with an unknown context: not covered by Reilly's rule`,
      data: { offerId: o.id, remark: o.remark, photo: o.photo_url } });
  }
  return { judged: (results || []).length, accepted: accepted + substitutes.length, substituted: substitutes.length, flagged: asks.length, approvalsExpired: expired };
}

/**
 * Any approval still open from the old "ask Reilly about a similar item on an order" rule is
 * answered by his 2026-10-13 "yes": expired with a note saying so (kept as history, not deleted).
 */
async function expireOldOrderApprovals(db, at) {
  const { results } = await db.prepare(`SELECT id FROM approvals WHERE requested_by = ? AND status = 'pending'`).bind(ACTOR).all();
  for (const a of results || []) {
    await db.prepare(`UPDATE approvals SET status = 'expired', decided_at = ?, note = ? WHERE id = ? AND status = 'pending'`)
      .bind(at, `Expired by the brain: covered by Reilly's 2026-10-13 answer ("${SIMILAR_ORDERS_RULE.words}" to "${SIMILAR_ORDERS_RULE.question}"): similar substitutes on orders are fine`, a.id).run();
  }
  if ((results || []).length) {
    await logEvent(db, { actor: ACTOR, kind: "similar.approvals_expired", target: "core.approvals", at,
      summary: `${results.length} open similar-item approval${results.length === 1 ? "" : "s"} expired: Reilly's "yes" (2026-10-13) covers order substitutions`,
      data: { approvalIds: results.map((a) => a.id) } });
  }
  return (results || []).length;
}
