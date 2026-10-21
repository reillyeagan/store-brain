/**
 * Draft or escalate? Plain code, one place. Also the independent check of every AI draft
 * (rule 9: the author never audits its own work — the reply writer's model writes, this code checks).
 */
import { ESCALATE_CATEGORIES, DRAFT_CATEGORIES } from "./config.js";
import { clip } from "./util.js";
import { sizeUpMention } from "./sizeUpGate.js";

/**
 * @returns {{action:"escalate"|"draft", reason:string}}
 */
/**
 * The customer says the parcel shows delivered (or was delivered somewhere wrong) but they don't
 * have it. A "delivered" with a negation right before it ("hasn't been delivered", "not
 * delivered yet") is an ordinary where-is-my-order.
 */
const DELIVERED_CLAIM = /\b(delivered|delivery (was )?(confirmed|complete))\b/gi;
const NEGATED = /(\bnot\b|\bnever\b|n['’]?t\b|\byet to be\b|\bstill\b)[^.?!]{0,20}$/i;
const FUTURE = /\b(would|will|should|supposed to|going to|expected to|estimated)\b[^.?!]{0,20}$/i;
const QUESTION_START = /^\s*(has|have|is|was|did|does|when|will|can|could|would|should|why|how)\b/i;
// The customer doesn't have it: a "delivered" claim alone ("it was delivered, thank you!") isn't enough.
const MISSING_WORDS = /\b(not|never|nothing|missing|where|cannot|lost|stolen|nowhere|no sign)\b|n['’]?t\b/i;
const NOT_THERE = /\bchecked (all|every|the|around)\b.{0,30}\b(locations?|places?|spots?|door|mailbox|porch)|\bnothing (was )?there\b|\bnot (anywhere|at my door|in my mailbox)\b|\bdelivered to (the )?wrong\b|\bwrong (address|house|door)\b|\bno (package|parcel)\b(?!\s+tracking)/i;
export function isMissingParcel(text) {
  const t = String(text || "");
  if (NOT_THERE.test(t)) return true;
  if (!MISSING_WORDS.test(t)) return false;
  for (const m of t.matchAll(DELIVERED_CLAIM)) {
    const before = t.slice(Math.max(0, m.index - 40), m.index);
    const sentenceStart = (t.slice(0, m.index).split(/[.!?\n]/).pop() || "");
    if (QUESTION_START.test(sentenceStart)) continue; // "has it been delivered?" asks, it doesn't claim
    if (NEGATED.test(before) || FUTURE.test(before)) continue;
    if (/\b(says?|said|shows?|showing|shown|marked|listed|status|tracking|usps|ups|fedex|carrier|been|was)\b/i.test(before)) return true;
  }
  return false;
}
export const MISSING_PARCEL = { test: isMissingParcel };

export function routeTicket(t, triage, ctx) {
  const cat = t.category || "other";
  // The order number written belongs to someone else's email: never answer from it.
  if (t.order_mismatch) return { action: "escalate", reason: `order #${t.order_ref || "?"} belongs to a different email; confirm the customer's order email before sharing anything` };
  if (ESCALATE_CATEGORIES.includes(cat)) return { action: "escalate", reason: cat === "other" ? "not covered by the playbook" : cat.replace(/_/g, " ") };
  if (triage && triage.angry) return { action: "escalate", reason: "customer is angry" };
  if (triage && triage.wants_refund) return { action: "escalate", reason: "asks for a refund" };
  // The item arrived and doesn't fit: an exchange or return follows, which is a replacement or
  // refund decision (Reilly's). Before shipping, a size swap is just a change KFB can make.
  // The carrier says delivered but the customer is asking where it is: a missing parcel (claim,
  // reship or refund), Reilly's call. Live 2026-10-15: "i checked all locations and there was nothing there".
  if (cat === "where_is_order" && ctx && (ctx.shipments || []).some((s) => s.carrier_delivered === true)) return { action: "escalate", reason: "the carrier says delivered but the customer hasn't got it (missing parcel)" };
  // Parcel tracking is off, so the customer's own words are the signal.
  if (cat === "where_is_order" && MISSING_PARCEL.test(String(t.body || ""))) return { action: "escalate", reason: "the customer says it shows delivered or isn't there (missing parcel)" };
  if (cat === "size_complaint") return { action: "escalate", reason: "item doesn't fit (exchange / return is Reilly's call)" };
  if (cat === "exchange" && !(ctx && ctx.shipped === false)) return { action: "escalate", reason: "exchange after shipping (replacement is Reilly's call)" };
  if (!DRAFT_CATEGORIES.includes(cat)) return { action: "escalate", reason: "not covered by the playbook" };
  return { action: "draft", reason: cat.replace(/_/g, " ") };
}

/**
 * What a draft must never do (spec + rules), checked keyword-strict on purpose: a false alarm
 * only sends the email to Reilly, a miss can promise money or a date to a customer.
 * Blocks:
 *   - money / compensation words: refund, money (back), reimburse, credit, discount, coupon,
 *     promo, code, %, $/€/£ amounts, dollars, cents, charge, fee, waive, "on us", "no cost",
 *     cover, postage, labels, free, compensate, "keep it"
 *   - replacements / returns: replace, reship, resend, "another one", "new one", "second",
 *     "send it back", "return it", "sort you out"
 *   - any date: weekday, month name, numeric date, tomorrow, tonight, next week, guarantee
 *   - any time frame ("2 days", "48 hours") except the "N-M business days" delivery range
 *   - any 3+ digit run (spaces/dashes ignored) that isn't the matched order or one of its
 *     Shopify tracking numbers (delivery-time ranges and cm/inch measurements excepted)
 *   - any link (with or without http/www, bare domain.tld) that isn't one of this order's
 *     tracking links, and any email address
 *   - placeholders
 *   - sizing up / factory sizes, unless the customer's own email asked about size or fit
 *     (`sizeAsked`; Reilly 2026-10-13: "no unless they ask")
 * Returns a list of problems (empty = passes).
 */
/**
 * A draft Reilly asked for as his own next step (playbook.js, mail flagged to him): his standard
 * policy wording is allowed (refund to the original payment method, free replacement, keep the
 * product, return address, return shipping paid by the customer, "within the next week or so").
 * Still refused: amounts, percentages, codes, coupons, store credit, labels, dates, links.
 */
function policyPhrases(s) {
  return s
    .replace(/601 S Kings Drive\s*,?\s*Suite F,?\s*PMB #?133\s*,?\s*Charlotte,?\s*NC,?\s*28204/gi, " the return address ")
    .replace(/\breturn shipping is paid (?:for )?by the customer\b/gi, " ")
    .replace(/\b(?:full |the )?refund(?:ed|s|ing)?\b/gi, " ")
    .replace(/\bfree (?:replacement|of charge)\b/gi, " ")
    .replace(/\b(?:feel free to |you can |please )?keep (?:it|them|the (?:item|product|jacket|coat|blazer|sweater|cardigan|order))\b/gi, " ")
    .replace(/\breplacement\b/gi, " ")
    .replace(/\b(?:ship|send|return) (?:it|them|the (?:item|product|\w+)) back\b/gi, " ")
    .replace(/\b(?:ship|send) (?:out )?(?:the |a )?(?:new|larger|smaller|correct) (?:size|one)\b/gi, " ")
    .replace(/\bwithin the next (?:few days|week or so)\b/gi, " ");
}

export function checkDraft(body, { ctx = null, orderRef = null, sizeAsked = false, policy = false } = {}) {
  const raw = String(body || "");
  const problems = [];
  if (raw.trim().length < 20) problems.push("empty draft");
  if (raw.length > 3000) problems.push("too long");
  // A bigger Chinese size shipping is never volunteered (Reilly: "no unless they ask").
  // Defaults to "didn't ask", so a caller that forgets to say fails safe.
  const orderedSizes = ((ctx && ctx.items) || []).map((i) => i.size).filter(Boolean);
  const sizeUp = sizeAsked ? null : sizeUpMention(raw, { orderedSizes });
  if (sizeUp) problems.push(`mentions sizing up ("${sizeUp}") but the customer didn't ask about size or fit`);

  // Harmless set phrases that would otherwise trip the word lists.
  const s0 = raw.replace(/\bfeel free\b/gi, " ").replace(/\b(zip|postal|post)\s*code\b/gi, " ")
    .replace(/\b\d{1,3}\s?%\s+(cotton|wool|polyester|linen|silk|cashmere|viscose|nylon|acrylic|spandex|elastane|rayon|leather|merino|modal|lyocell)\b/gi, " fabric ")
    // Reilly's own step-1 wording (2026-10-20 playbook): asking for photos "then we can continue
    // with the return process" promises nothing.
    .replace(/\b(return|refund|exchange)(\s*\/\s*(return|refund|exchange))?\s+(process|request|policy)\b/gi, " the process ");
  const s = policy ? policyPhrases(s0) : s0;

  const money = s.match(/\b(refund\w*|money|reimburs\w*|credit\w*|discount\w*|coupon\w*|promo\w*|code|compensat\w*|free|keep (it|them|the item|the order)|dollars?|usd|cents?|bucks|charge\w*|fees?|waive\w*|on us|at no (extra )?cost|no cost|cover\w*|postage|(return|shipping|prepaid) label|label|pay(ing)? for)\b|%|[$€£]\s?\d/i);
  if (money) problems.push(`mentions money or compensation ("${money[0]}") — Reilly's call`);
  const repl = s.match(/\b(replac\w*|re-?ship\w*|re-?send\w*|another one|new one|send (you )?another|second|sort (you|it|this) out|send (it|them|the \w+|everything) back|return (it|them|the \w+)|exchange (it|them|the \w+)|swap (it|them|the \w+))\b/i);
  if (repl) problems.push(`mentions a replacement or return ("${repl[0]}") — Reilly's call`);
  // Month abbreviations only count next to a day number, so a name like "Jan" isn't a date.
  const date = s.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thur?s?|fri|sat|january|february|march|april|june|july|august|september|october|november|december|tomorrow|tonight|next week|this week|guarantee\w*)\b|\b(jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?\s*\d{1,2}\b|\b\d{1,2}[/.]\d{1,2}([/.]\d{2,4})?\b|\b\d{1,2}(st|nd|rd|th)\b/i);
  // "May" is a common verb, so it only counts followed by a day number.
  const mayDate = /\bmay\s+\d{1,2}\b/i.test(s);
  if (date || mayDate) problems.push(`mentions a date ("${date ? date[0] : "May"}") — never give dates`);
  // Durations: only the delivery-range phrasing "N-M business days" is allowed.
  const noRange = s.replace(/\b\d{1,2}\s*(?:-|–|to)\s*\d{1,2}\s+(?:business|working)\s+days?\b/gi, " ");
  const dur = noRange.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a few|a couple( of)?|couple of|several|24|48|72)\s*(hours?|hrs?|days?|weeks?|business days?|working days?)\b/i);
  if (dur) problems.push(`gives a time frame ("${dur[0]}") — only "N-M business days" delivery ranges`);
  if (/\[[^\]]{2,40}\]|\{\{|\}\}|<(name|order|tracking)[^>]*>/i.test(s)) problems.push("contains a placeholder");
  // Customers hear from the store, never about Reilly (live 2026-10-15: "Reilly will review").
  if (/\breilly\b/i.test(s)) problems.push("mentions Reilly by name");

  // Links and addresses: only this order's tracking links; no other link, domain or email.
  const shipments = (ctx && ctx.shipments) || [];
  const allowedUrls = shipments.map((x) => String(x.tracking_url || "")).filter(Boolean);
  let rest = s;
  for (const u of allowedUrls) rest = rest.split(u).join(" ");
  const email = rest.match(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i);
  if (email) problems.push(`contains an email address (${clip(email[0], 60)})`);
  const link = rest.match(/\b(?:https?:\/\/|www\.)[^\s<>()]+/i) || rest.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>()]*)?/i);
  if (link && !email) problems.push(`contains a link that isn't this order's tracking link (${clip(link[0].replace(/[.,;:!?)]+$/, ""), 60)})`);

  // Numbers: drop the allowed ones, then no 3+ digit run may remain (spaces/dashes ignored, so
  // a spaced-out number is still caught).
  rest = rest
    .replace(/\b\d{1,2}\s*(?:-|–|to)\s*\d{1,2}\s+(?:business\s+|working\s+)?days?\b/gi, " ")
    .replace(/\b\d{1,3}(?:\.\d)?\s*(?:cm|centimet(?:er|re)s?|in|inch(?:es)?|")(?![a-z])/gi, " ");
  let compact = rest.toUpperCase().replace(/(?<=[A-Z0-9])[\s-]+(?=[A-Z0-9])/g, "");
  for (const tn of shipments.map((x) => String(x.tracking_number || "").toUpperCase().replace(/[\s-]/g, "")).filter(Boolean)) compact = compact.split(tn).join(" ");
  const allowedOrders = [ctx && ctx.name ? String(ctx.name).replace(/^#/, "") : null, orderRef].filter(Boolean);
  for (const o of allowedOrders) compact = compact.replace(new RegExp(`#?(?<!\\d)${o}(?!\\d)`, "g"), " ");
  const stray = compact.match(/\d{3,}/);
  if (stray) problems.push(`quotes a number the code didn't supply (${clip(stray[0], 30)})`);
  return problems;
}
