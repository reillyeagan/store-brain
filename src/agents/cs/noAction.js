/**
 * "Nothing to do" guard — plain code. Live 2026-10-14: a customer's "Thankyou" to a shipping
 * update and a "thanks, I'll reply once it arrives" both reached Reilly as WAITING ON YOU.
 * Mail like that is closed quietly as `no_action` (logged, listed on the CS page under its own
 * heading), never escalated and never drafted.
 *
 * Two parts, both needed to close a ticket:
 *   1. A positive sign that the email is only an acknowledgement: the classifier said
 *      no_action, OR its summary says "no action requested/raised/needed" / "no question", OR
 *      the email itself is a short thank-you with nothing else in it.
 *   2. The fail-safe, which always wins: a question mark, an order problem, a request, anger,
 *      or a money/refund/return word anywhere in the subject or body means it is NOT
 *      no_action, whatever the classifier said. A wrong close hides a customer from Reilly; a
 *      wrong escalation only costs him a glance, so every doubt goes to Reilly.
 */
import { safeJson } from "./util.js";

/** The classifier's own words for "nothing asked". */
export const SUMMARY_NO_ACTION = /\bno (?:further )?(?:action|question|request)s?(?: or (?:action|question|request)s?)?(?: (?:is|was|were|being))? (?:requested|raised|needed|required|asked|made)\b|\bnothing (?:requested|asked)\b|\bno reply needed\b/i;

/** The fail-safe vetoes. Each one alone keeps the ticket with the normal flow. */
const VETOES = [
  ["question", /\?/],
  ["refund or money", /\b(refund\w*|money|reimburs\w*|charge\w*|chargeback|dispute\w*|paypal|bank|credit card|compensat\w*|discount|coupon|price|cost|paid|pay)\b/i],
  ["return or exchange", /\b(return\w*|exchang\w*|replac\w*|swap|send (it|them) back|cancel\w*)\b/i],
  ["order problem", /\b(wrong|damaged?|broken|faulty|defect\w*|missing|lost|stolen|torn|ripped|stain\w*|hole|late|delay\w*|never (arrived|came|received|got)|still (waiting|not|hasn|haven|no)|where is|where's|size|fit|fits|too (small|big|large|tight|loose|short|long)|colou?r|address|stuck|problem|issue|mistake|error)\b/i],
  ["order problem", /(not|n't|nt)\s+(yet\s+)?(arrived|come|received|got|here|delivered|fit|fits|right|work\w*|updat\w*|mov\w*|show\w*)\b|\btracking (says|shows|hasn|isn|is not|not)\b/i],
  ["request", /\b(please|pls|plz|can you|could you|would you|will you|can i|could i|i want|i'd like|i would like|i need|need (to|a|an|the|it|my)|help|let me know|update me|tell me|send me|asap|urgent\w*|when will|how long|any update|waiting (for|on))\b/i],
  ["anger", /\b(scam\w*|fraud\w*|fake|ridiculous|unacceptable|terrible|awful|worst|disgust\w*|angry|furious|upset|disappoint\w*|unhappy|not happy|complain\w*|report(ing)? you|bbb|lawyer|legal|police|never (again|order\w*))\b|!!/i],
];

/** Words a thank-you/acknowledgement is made of (anything else = not a bare thank-you). */
const ACK_WORDS = new Set(("thank thanks thankyou thx ty tysm many much so very you u a lot lots great " +
  "ok okay okey k cool perfect awesome amazing wonderful lovely brilliant nice good excellent appreciate appreciated " +
  "it this that the for your update updates info information message email note noted received got " +
  "will i ll i'll we we'll reply respond get back to once when item items order parcel package arrives arrive " +
  "comes come is in here have has had receive receiving it's its all sounds sound looks look fine well " +
  "hi hello hey dear team sir madam best regards kind cheers sincerely sent from my iphone android phone mobile " +
  "and again too also just really yes yep sure").split(" "));

/** The customer's words only: quoted history and sign-off lines dropped, lower-case. */
function words(text) {
  return String(text || "").toLowerCase().replace(/[^a-z' ]+/g, " ").split(/\s+/).filter(Boolean);
}

/** True when the email is nothing but a short thank-you / acknowledgement. */
export function isBareThanks(body) {
  const w = words(body);
  if (!w.length || w.length > 40) return false;
  if (!w.some((x) => /^(thank|thanks|thankyou|thx|ty|tysm|appreciate|appreciated|noted|cheers|great|perfect|ok|okay)$/.test(x))) return false;
  // Names in a greeting or sign-off are fine; anything else that isn't an ack word is not.
  const unknown = w.filter((x) => !ACK_WORDS.has(x));
  return unknown.length <= 3;
}

/** The first fail-safe that fires, or null. Checks the customer's own subject and words. */
export function noActionVeto({ subject = "", body = "" } = {}) {
  // "Re: Your order is on the way" / "Order #1253 shipped" are the store's own subjects:
  // only the customer's body is checked for questions and problems, plus a subject that
  // the customer typed (no Re:/Fwd: prefix).
  const subj = /^\s*(re|fw|fwd)\s*:/i.test(String(subject)) ? "" : String(subject);
  const text = `${subj}\n${body || ""}`;
  for (const [why, re] of VETOES) if (re.test(text)) return why;
  return null;
}

/**
 * Should this ticket be closed quietly as no_action?
 * @param t       the cs_tickets row (subject, body, summary, triage JSON)
 * @param triage  the validated classification (optional; read from t.triage when absent)
 * @returns {{close:boolean, reason:string}}
 */
export function noActionCheck(t, triage = null) {
  const tri = triage || safeJson(t && t.triage, {}) || {};
  const veto = noActionVeto({ subject: t && t.subject, body: t && t.body });
  if (veto) return { close: false, reason: `not closed: ${veto}` };
  if (tri.angry || tri.wants_refund) return { close: false, reason: "not closed: classifier saw anger or a refund" };
  const cat = (t && t.category) || tri.category || "other";
  // Only "other" can be a bare acknowledgement; every real category has something to do.
  if (cat !== "other") return { close: false, reason: `not closed: category ${cat}` };
  const summary = String((t && t.summary) || tri.summary || "");
  if (tri.no_action === true) return { close: true, reason: "the classifier said nothing was asked, and no question, request, problem or refund word is in the email" };
  if (SUMMARY_NO_ACTION.test(summary)) return { close: true, reason: `the classifier's summary says so ("${summary.slice(0, 120)}"), and no question, request, problem or refund word is in the email` };
  if (isBareThanks(t && t.body)) return { close: true, reason: "the email is only a thank-you, with no question, request, problem or refund word" };
  return { close: false, reason: "not closed: no sign it is only an acknowledgement" };
}

/**
 * An earlier email in the same conversation that was replaced (superseded) by this one before
 * anyone dealt with it, and wasn't itself just a thank-you? Then this email is the only open
 * handle on that conversation and must not be closed quietly.
 */
export async function earlierUnansweredAsk(db, t) {
  if (!t || !t.thread_id) return false;
  const { results } = await db.prepare(
    `SELECT * FROM cs_tickets WHERE slot = ? AND thread_id = ? AND id < ? AND status = 'superseded'
       AND escalated_at IS NULL AND replied_at IS NULL ORDER BY id DESC LIMIT 10`
  ).bind(t.slot, t.thread_id, t.id).all();
  return (results || []).some((e) => !noActionCheck(e).close);
}
