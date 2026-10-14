/**
 * "Nothing to do" guard — plain code. Live 2026-10-14: a customer's "Thankyou" to a shipping
 * update and a "thanks, I'll reply once it arrives" both reached Reilly as WAITING ON YOU.
 * Mail like that is closed quietly as `no_action` (logged, listed on the CS page under its own
 * heading), never escalated and never drafted.
 *
 * Code decides, never the model alone (review 2026-10-14: the classifier's flag closed
 * "Gracias, pero el pedido no llegó"; a problem-word list missed "the zipper broke"):
 *   - The email (HTML stripped to text) must be an ALLOWLISTED acknowledgement: after the
 *     greeting ("Hi Jane,"), the sign-off/name line and "Sent from my iPhone" are set aside,
 *     every remaining word must be on the acknowledgement list. One other word, in any
 *     language, and this path does not close. A problem list always misses something; an
 *     allowlist can't.
 *   - On top, the fail-safe vetoes (question mark, request, problem, anger, money/refund/
 *     return word) and the classifier's own anger/refund flags keep it open.
 *   - Only category "other" can close.
 * The classifier's no_action flag and its "no action requested" summary are recorded as
 * supporting signs only. A wrong close hides a customer from Reilly; a wrong escalation only
 * costs him a glance, so every doubt goes to Reilly.
 */
import { safeJson } from "./util.js";

/** The classifier's own words for "nothing asked" (a supporting sign, never enough alone). */
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

/**
 * The ONLY words a closable email may contain (after greeting / sign-off / name line are set
 * aside). Deliberately small: no "but", "not", "no", "too", adjectives that could describe a
 * fault, or anything about the item's condition. A word missing here only sends a harmless
 * thank-you to Reilly.
 */
const ACK_WORDS = new Set((
  "thank thanks thankyou thx ty tysm many much so very you a lot great ok okay cool perfect awesome amazing " +
  "wonderful lovely brilliant nice excellent appreciate appreciated appreciation noted " +
  "for the your this that it it's its update updates info information " +
  "i i'll will reply respond get back to you once when have has received receive arrives arrived item order " +
  "all good sounds again yes"
).split(" "));
/** At least one of these must be there: it is a thank-you / acknowledgement at all. */
const THANKS = /^(thank|thanks|thankyou|thx|ty|tysm|appreciate|appreciated|noted|ok|okay)$/;

// A greeting may address the store, never an arbitrary capitalised word ("Hi Broken").
const GREETING = /^\s*(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))(?:\s+(?:there|team|all|holt\s*(?:&|and)\s*crane|auberlane|marlowe(?:\s+standard)?)(?:\s+team)?)?\s*[,!.:-]*\s*/i;
const SIGNOFF_WORDS = /^(?:(?:best|kind|warm|warmest)\s+regards|regards|best|cheers|sincerely|warmly|thanks|thank you|many thanks|xx?)$/i;
const DEVICE_LINE = /^(?:sent from my\b.*|get outlook for\b.*|sent via\b.*)$/i;

/**
 * A sign-off / name line: "Best," / "Cheers, Jane" / "Jane Doe". A name counts only when
 * every word of it is in the sender's own name (from the From header), so "Thanks\nZipper
 * Broke" can't pass a problem off as a signature.
 */
function isSignoffLine(line, fromName) {
  const l = line.replace(/\s+/g, " ").replace(/[.!]+$/, "").trim();
  const nameWords = new Set(String(fromName || "").toLowerCase().split(/[^a-z'-]+/).filter(Boolean));
  const isName = (s) => {
    const w = s.toLowerCase().split(/\s+/).filter(Boolean);
    return w.length > 0 && w.length <= 3 && w.every((x) => nameWords.has(x));
  };
  if (SIGNOFF_WORDS.test(l.replace(/,$/, ""))) return true;
  const m = /^([^,]+),\s*(.+)$/.exec(l);
  if (m && SIGNOFF_WORDS.test(m[1].trim()) && isName(m[2])) return true;
  return isName(l);
}

/** HTML to plain text: tags dropped, style/script removed, breaks kept, entities decoded. */
export function htmlToText(s) {
  let t = String(s == null ? "" : s);
  if (!/<[a-z!/][^>]*>|&[a-z#0-9]+;/i.test(t)) return t;
  t = t.replace(/<(style|script|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h\d)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  const named = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' };
  t = t.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (named[n.toLowerCase()] ?? m));
  return t.replace(/[ \t]+/g, " ");
}

/** The customer's own lines: quoted history, device footers and blank lines dropped. */
function ownLines(text) {
  return htmlToText(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith(">") && !DEVICE_LINE.test(l));
}

/**
 * True only when the email is nothing but a thank-you / acknowledgement: every word, after the
 * greeting and the sign-off/name line, is on ACK_WORDS. Zero exceptions.
 */
export function isBareThanks(body, { fromName = null } = {}) {
  const lines = ownLines(body);
  if (!lines.length) return false;
  // The sign-off / name line(s) at the end ("Best, Jane" / "Jane Doe"), never the only line.
  while (lines.length > 1 && isSignoffLine(lines[lines.length - 1], fromName)) lines.pop();
  lines[0] = lines[0].replace(GREETING, "");
  const w = lines.join(" ").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean)
    .map((x) => x.replace(/^'+|'+$/g, ""));
  if (!w.length || w.length > 30) return false;
  if (!w.some((x) => THANKS.test(x))) return false;
  return w.every((x) => ACK_WORDS.has(x));
}

/** The first fail-safe that fires, or null. Checks the customer's own subject and words. */
export function noActionVeto({ subject = "", body = "" } = {}) {
  // "Re: Your order is on the way" is the store's own subject: only a subject the customer
  // typed (no Re:/Fwd: prefix) is checked, plus the body.
  const subj = /^\s*(re|fw|fwd)\s*:/i.test(String(subject)) ? "" : htmlToText(subject);
  const text = `${subj}\n${htmlToText(body)}`;
  for (const [why, re] of VETOES) if (re.test(text)) return why;
  return null;
}

/**
 * Should this ticket be closed quietly as no_action? Code decides: the allowlist check must
 * pass, whatever the classifier said.
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
  if (!isBareThanks(t && t.body, { fromName: t && t.from_name })) return { close: false, reason: "not closed: the email has words beyond a plain thank-you" };
  const summary = String((t && t.summary) || tri.summary || "");
  const signs = [
    tri.no_action === true ? "the classifier said nothing was asked" : null,
    SUMMARY_NO_ACTION.test(summary) ? `its summary says "${summary.slice(0, 120)}"` : null,
  ].filter(Boolean);
  return { close: true, reason: `the email is only a thank-you (every word is an acknowledgement; no question, request, problem or refund word)${signs.length ? `; ${signs.join("; ")}` : ""}` };
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
