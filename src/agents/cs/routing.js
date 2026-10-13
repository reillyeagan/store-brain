/**
 * Draft or escalate? Plain code, one place. Also the independent check of every AI draft
 * (rule 9: the author never audits its own work — the reply writer's model writes, this code checks).
 */
import { ESCALATE_CATEGORIES, DRAFT_CATEGORIES } from "./config.js";

/**
 * @returns {{action:"escalate"|"draft", reason:string}}
 */
export function routeTicket(t, triage, ctx) {
  const cat = t.category || "other";
  if (ESCALATE_CATEGORIES.includes(cat)) return { action: "escalate", reason: cat === "other" ? "not covered by the playbook" : cat.replace(/_/g, " ") };
  if (triage && triage.angry) return { action: "escalate", reason: "customer is angry" };
  if (triage && triage.wants_refund) return { action: "escalate", reason: "asks for a refund" };
  // The item arrived and doesn't fit: an exchange or return follows, which is a replacement or
  // refund decision (Reilly's). Before shipping, a size swap is just a change KFB can make.
  if (cat === "size_complaint") return { action: "escalate", reason: "item doesn't fit (exchange / return is Reilly's call)" };
  if (cat === "exchange" && !(ctx && ctx.shipped === false)) return { action: "escalate", reason: "exchange after shipping (replacement is Reilly's call)" };
  if (!DRAFT_CATEGORIES.includes(cat)) return { action: "escalate", reason: "not covered by the playbook" };
  return { action: "draft", reason: cat.replace(/_/g, " ") };
}

/**
 * What a draft must never do (spec + rules): promise a refund, reship or replacement; give a
 * guaranteed delivery date; quote an order or tracking number the code didn't supply; leave a
 * placeholder. Returns a list of problems (empty = passes).
 */
export function checkDraft(body, { ctx = null, orderRef = null } = {}) {
  const s = String(body || "");
  const problems = [];
  if (s.trim().length < 20) problems.push("empty draft");
  if (s.length > 3000) problems.push("too long");
  if (/\b(we|i)('ll| will| are going to| can| would be happy to)\b[^.!?\n]{0,50}\brefund/i.test(s) || /\brefund\b[^.!?\n]{0,20}\b(has been|will be|is being|was) (issued|processed|sent|approved)/i.test(s) || /\bfull refund\b/i.test(s)) {
    problems.push("promises a refund (refunds are Reilly's)");
  }
  if (/\b(we|i)('ll| will| are going to| can)\b[^.!?\n]{0,50}\b(reship|re-ship|resend|send (you )?(a )?(new|replacement)|replacement)\b/i.test(s)) {
    problems.push("promises a reship or replacement (Reilly's)");
  }
  if (/\bguarantee/i.test(s) || /\b(will|should|is going to)\s+(arrive|be delivered|reach you|get to you)\s+(by|on|before)\b/i.test(s)) {
    problems.push("gives a delivery date (never guaranteed)");
  }
  if (/\[[^\]]{2,40}\]|\{\{|\}\}|<(name|order|tracking)[^>]*>/i.test(s)) problems.push("contains a placeholder");
  // Order numbers: only the matched order's (or the one the customer wrote).
  const allowedOrders = new Set([ctx && ctx.name ? String(ctx.name).replace(/^#/, "") : null, orderRef].filter(Boolean));
  for (const m of s.matchAll(/#\s?(\d{3,6})\b/g)) {
    if (!allowedOrders.has(m[1])) { problems.push(`quotes order #${m[1]} that isn't this customer's`); break; }
  }
  // Tracking numbers: only ones Shopify holds for this order.
  const known = new Set(((ctx && ctx.shipments) || []).map((x) => String(x.tracking_number || "").toUpperCase()).filter(Boolean));
  for (const m of s.matchAll(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z]?)[A-Z0-9]{10,30}\b/g)) {
    if (!known.has(m[0].toUpperCase())) { problems.push(`quotes tracking number ${m[0]} that Shopify doesn't hold for this order`); break; }
  }
  return problems;
}
