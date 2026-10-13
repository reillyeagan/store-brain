/**
 * cs.retention — Retention (AI). SHADOW: PROPOSES one way to keep a customer who wants to cancel
 * or return (e.g. an exchange for the right size instead of a refund). Stored on the ticket
 * (cs_tickets.retention) and shown in Reilly's escalation flag. Never sent, never offered.
 * The AI picks from a fixed list of options; it never sets an amount (money is Reilly's).
 * Inputs: cs_tickets (cancel / return_refund) with order context. Outputs: suggestion, event.
 */
import { askJson } from "../../lib/ai.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { CAPS, RETENTION_CATEGORIES, storeName } from "./config.js";
import { safeJson, clip, logOnce } from "./util.js";

const ACTOR = "cs.retention";

/** The only kinds of offer the brain may suggest. Amounts and approvals are Reilly's. */
export const RETENTION_OPTIONS = Object.freeze({
  exchange_size: "Offer an exchange for the size that fits instead of a refund",
  exchange_item: "Offer a different item / colour instead of a refund",
  keep_shipping: "Order is on its way: explain timing and ask them to wait before cancelling",
  partial_credit: "Offer to let them keep it with a partial refund or store credit (Reilly sets the amount)",
  none: "No retention offer fits: process as asked",
});

const SYSTEM = `You help a small online clothing store keep customers who want to cancel or return.
Pick the ONE best option for this customer from: ${Object.entries(RETENTION_OPTIONS).map(([k, v]) => `${k} = ${v}`).join("; ")}.
Do not suggest amounts. If the customer is angry, mentions a chargeback, or the item is faulty, pick "none" (don't push).
Return {"option":"<key>","why":"max 25 words","line":"one sentence Reilly could use in his reply, no amounts, no promises"}`;

export async function proposeRetention(env, { nowMs = Date.now(), fetchImpl = fetch, budget }) {
  const db = env.DB;
  const marks = RETENTION_CATEGORIES.map(() => "?").join(",");
  const { results } = await db.prepare(
    `SELECT * FROM cs_tickets WHERE category IN (${marks}) AND retention_at IS NULL AND context_at IS NOT NULL
       AND status IN ('open','needs_reilly') ORDER BY id LIMIT ?`
  ).bind(...RETENTION_CATEGORIES, CAPS.retentionPerTick).all();
  let proposed = 0;
  for (const t of results || []) {
    if (!budget.take(1)) break;
    const at = nowIso(nowMs);
    const ctx = safeJson(t.context, null);
    const triage = safeJson(t.triage, {});
    const user = [
      `Store: ${storeName(t.order_store || t.store) || "unknown"}`,
      `Category: ${t.category}`,
      `Angry: ${triage.angry ? "yes" : "no"}; fit: ${(triage.size && triage.size.fit) || "n/a"}`,
      ctx ? `Order: ${ctx.name}, shipped: ${ctx.shipped}, items: ${(ctx.items || []).map((i) => `${i.title} ${i.variant || ""}`).join("; ")}` : "Order: not matched",
      `Email:\n${clip(t.body || "", 1500)}`,
    ].join("\n");
    let r;
    try {
      r = await askJson(env, { system: SYSTEM, user, maxTokens: 200, actor: ACTOR, label: "CS retention idea", store: t.store || undefined }, { fetchImpl, nowMs });
    } catch (err) {
      await db.prepare(`UPDATE cs_tickets SET retention = ?, retention_at = ? WHERE id = ?`).bind(JSON.stringify({ option: null, error: clip(err.message, 120) }), at, t.id).run();
      continue;
    }
    if (r.skipped) {
      await logOnce(db, { actor: ACTOR, kind: "cs.ai_waiting", summary: `Retention ideas are waiting: AI is ${r.skipped}.` }, { windowMin: 6 * 60, nowMs });
      break;
    }
    const key = Object.prototype.hasOwnProperty.call(RETENTION_OPTIONS, r.json && r.json.option) ? r.json.option : "none";
    // The suggested line must not carry a number (amounts are Reilly's).
    const line = r.json && typeof r.json.line === "string" && !/\d/.test(r.json.line) ? clip(r.json.line, 240) : null;
    const s = { option: RETENTION_OPTIONS[key], key, why: clip((r.json && r.json.why) || "", 200), line };
    await db.prepare(`UPDATE cs_tickets SET retention = ?, retention_at = ?, updated_at = ? WHERE id = ?`).bind(JSON.stringify(s), at, at, t.id).run();
    proposed++;
    await logEvent(db, { actor: ACTOR, kind: "cs.retention_proposed", store: t.store, target: "cs.escalation", at, summary: `Ticket ${t.id} (${String(t.category).replace(/_/g, " ")}): suggest "${s.option}". Not offered; Reilly decides.`, data: { ticket: t.id, option: key } });
  }
  return { proposed };
}
