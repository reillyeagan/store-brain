/**
 * "Similar ones" QC (sup.similar_qc) — plain code, SHADOW.
 *
 * Reilly, 2026-10-11 (spec Q4, "when is similar OK, and when must the listing change or be
 * drafted?"): "q4 always fine".
 *
 * So a QUOTE that KFB returns with an "only similar ones" remark is accepted automatically and
 * priced like an exact match (the Quote Desk does the pricing). What his rule does NOT cover is
 * a customer's ORDER being filled with a similar item: the standing rule there is "Never send
 * a customer a 'similar' item without asking; offer it with a photo." Those are flagged for
 * Reilly, never accepted.
 *
 * Inputs:  kfb_similar_offers (filled by the KFB Morning Session, planned, or recordSimilarOffer()).
 * Outputs: a verdict on each offer (accepted | ask_reilly), events.
 * The spec's photo comparison (AI vision) is not built: Q4 made it unnecessary for quotes.
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { STORES } from "../../config/stores.js";
import { handleFrom } from "./common.js";

const ACTOR = "sup.similar_qc";
export const SIMILAR_RULE = Object.freeze({ words: "q4 always fine", at: "2026-10-11", means: "a similar quote is treated exactly like an exact match: priced by the rules, never drafted for being similar" });

/** Pure: the verdict for one offer. */
export function judgeSimilar(offer) {
  if (offer.context === "quote") {
    return { verdict: "accepted", reason: `Reilly: "${SIMILAR_RULE.words}": priced like an exact match, never drafted for being similar` };
  }
  if (offer.context === "order") {
    return { verdict: "ask_reilly", reason: "A customer's order filled with a similar item: never sent without asking the customer (offer it with a photo). Reilly's \"q4 always fine\" covers quotes, not orders." };
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
  const { results } = await db.prepare(`SELECT * FROM kfb_similar_offers WHERE verdict IS NULL ORDER BY id LIMIT 100`).all();
  let accepted = 0; const asks = [];
  for (const o of results || []) {
    const j = judgeSimilar(o);
    await db.prepare(`UPDATE kfb_similar_offers SET verdict = ?, verdict_reason = ?, judged_at = ? WHERE id = ?`).bind(j.verdict, j.reason, at, o.id).run();
    if (j.verdict === "accepted") accepted++; else asks.push(o);
  }
  if (accepted) {
    await logEvent(db, { actor: ACTOR, kind: "similar.accepted", at,
      summary: `${accepted} "only similar ones" quote${accepted === 1 ? "" : "s"} accepted per Reilly's rule ("q4 always fine")` });
  }
  for (const o of asks) {
    await logEvent(db, { actor: ACTOR, kind: "similar.flagged", store: o.store, target: "core.approvals", at,
      summary: `${STORES[o.store] ? STORES[o.store].name : o.store} ${o.order_name || o.product_handle}: KFB offers a similar item for a customer's order: ask the customer first (with a photo)`,
      data: { offerId: o.id, remark: o.remark, photo: o.photo_url } });
  }
  return { judged: (results || []).length, accepted, flagged: asks.length };
}
