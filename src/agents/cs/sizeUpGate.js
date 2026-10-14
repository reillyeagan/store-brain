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
import { sizeIndex } from "../supplier/common.js";

/** Categories the triage gives an email that is itself about size or fit. */
const SIZE_CATEGORIES = new Set(["size_question", "size_complaint"]);
/**
 * Phrases in the customer's own email that mean they ASKED about size or fit. The bare word
 * "size" is not enough: "I ordered it in size M, where is it?" or a pasted "Size: M / Navy"
 * line mentions a size without asking about one.
 */
const ASKS_SIZE_RE = new RegExp([
  String.raw`\b(what|which) size\b`,                                   // what size should I get
  String.raw`\bsize (should|would|do|does|will|to)\b`,                 // size should I order / size do you recommend
  String.raw`\b(right|correct|best|true to) size\b`,                  // not "my size": "I ordered my size M" isn't a question
  String.raw`\bsize (chart|guide)\b`,
  String.raw`\bsizing\b`,
  String.raw`\bmeasurements?\b`,
  String.raw`\b(runs?|running|run) (small|large|big|true)\b`,
  String.raw`\btoo (small|big|large|tight|loose|short|long|snug|baggy)\b`,
  // Fit as a question or complaint only, never the bare word: "hope it fits!" is not asking.
  String.raw`\b(doesn'?t|does not|didn'?t|did not|won'?t|will not|don'?t|do not|not|never) fit\b`,
  String.raw`\b(will|would|does|do|did|how will|how does|how do) (it|they|this|these|that) fit\b`,
  String.raw`\bthe fit\b`,
  String.raw`\bfit (me|him|her|them|us|my|a|an|someone|someone's)\b`,  // will the medium fit me / fit a 42 chest
  String.raw`\bfits? (small|large|big|true|tight|loose|snug|well|right)\b`,
  String.raw`\b(fitting|fitted)\b`,
  String.raw`\b(bigger|smaller|larger|different|another) size\b`,      // exchange for a bigger size
  String.raw`\bsize (up|down|bigger|smaller|larger)\b`,
].join("|"), "i");

/**
 * What a reply must not say proactively: that a bigger / different factory size is being sent,
 * or that the factory sizes run small. Keyword-strict on purpose: a false alarm only sends the
 * draft to Reilly.
 */
const SIZE_UP_RE = new RegExp([
  String.raw`\b(size|sized|sizing)[ -](it |them )?up\b`,              // size up, sized it up, one size up
  String.raw`\bup-?siz\w*`,                                            // upsized, upsizing, up-size
  String.raw`\b(bigger|larger|next) (size|one|version)\b`,             // bigger size, sent a larger one
  String.raw`\b(a |one )?size (bigger|larger|above)\b`,
  String.raw`\b(chinese|factory|asian) (size|sizes|sizing|m|l|xl|s)\b`,
  String.raw`\bruns? small\b`,
  String.raw`\b(send|sending|sent|ship|shipping|shipped)( you)? (an? |the )?(l|xl|xxl|2xl|3xl|large|x-?large|bigger|larger)\b`,
  String.raw`\bso (that )?(it|they) (fits?|will fit)\b`,               // sent the XL so it fits
  String.raw`\b(went|go|going|gone) up (one|a|1)( size)?\b`,           // went up one / went up a size
].join("|"), "i");

/** Letter sizes named in a draft: upper-case codes (so "a"/"I" never count) or capitalised words. */
const NAMED_SIZE_RE = /\b(XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL|[2-6]X|Small|Medium|Large|X-Large|XX-Large)\b/g;

/**
 * Did the customer's own email ask about size or fit? Reads only what the customer wrote
 * (subject + body) and the triage category, never the store's own words.
 */
export function emailAsksAboutSize(ticket) {
  const t = ticket || {};
  if (SIZE_CATEGORIES.has(t.category)) return true;
  return ASKS_SIZE_RE.test(`${t.subject || ""}\n${t.body || ""}`);
}

/**
 * The size-up wording a draft contains, or null. When the ordered size(s) are known, a draft
 * naming a letter size LARGER than anything ordered also counts (that's a size-up, said plainly).
 */
export function sizeUpMention(body, { orderedSizes = [] } = {}) {
  const s = String(body || "");
  const m = s.match(SIZE_UP_RE);
  if (m) return m[0];
  const ordered = (orderedSizes || []).map(sizeIndex).filter((i) => i >= 0);
  if (!ordered.length) return null;
  const top = Math.max(...ordered);
  for (const named of s.match(NAMED_SIZE_RE) || []) {
    if (sizeIndex(named) > top) return `names size ${named}, larger than ordered`;
  }
  return null;
}
