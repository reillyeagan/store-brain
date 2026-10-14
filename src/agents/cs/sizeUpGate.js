/**
 * Size-up gate — plain code, no AI.
 *
 * When the Size Checker decides a bigger Chinese size should ship (#1234 ordered M → send a
 * Chinese L), the customer is NOT told unless they ask. Asked 2026-10-13 whether to tell the
 * customer when a bigger Chinese size ships, Reilly: "no unless they ask".
 *
 * So CS replies only bring sizing up when the customer's own email asks about size or fit, and
 * a draft that talks about sizing up / factory sizes when they didn't ask fails the draft check
 * (it goes to Reilly instead of being used). Relay's KFB message is to the supplier, not the
 * customer, so it is not gated here.
 */

/** Categories the triage gives an email that is itself about size or fit. */
const SIZE_CATEGORIES = new Set(["size_question", "size_complaint"]);
/** Words in the customer's own email that mean they asked about size or fit. */
const ASKS_SIZE_RE = /\b(sizes?|sizing|sized|fits?|fitting|fitted|measurements?|too (small|big|large|tight|loose|short|long)|runs? (small|big|large))\b/i;
/**
 * What a reply must not say proactively: that a bigger / different factory size is being sent,
 * or that the factory sizes run small.
 */
const SIZE_UP_RE = /\b(siz(e|ed|ing) (it |them )?up|(a |one |the )?(bigger|larger|next) size|size (bigger|larger|up)|(chinese|factory|asian) (size|sizing|sizes|m|l|xl|s)|runs? small|sending (you )?(an? )?(l|xl|2xl|large|bigger))\b/i;

/**
 * Did the customer's own email ask about size or fit? Reads only what the customer wrote
 * (subject + body) and the triage category, never the store's own words.
 */
export function emailAsksAboutSize(ticket) {
  const t = ticket || {};
  if (SIZE_CATEGORIES.has(t.category)) return true;
  return ASKS_SIZE_RE.test(`${t.subject || ""}\n${t.body || ""}`);
}

/** The size-up wording a draft contains, or null. */
export function sizeUpMention(body) {
  const m = String(body || "").match(SIZE_UP_RE);
  return m ? m[0] : null;
}
