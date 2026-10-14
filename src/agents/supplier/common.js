/**
 * Small shared helpers for the Supplier Relations agents.
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";

export const DEPT = "sup";

/** Why most supplier inputs are empty today. Shown on the page and in the digest. */
export const WAITING_ON_KFB = "waiting on KFB session: KFB has no API and a CAPTCHA login; the KFB morning import (log in, click the bookmarklet, #/import/kfb) fills this";

/**
 * Log an event at most once per `withinMin` for the same actor + kind (+ target), so a
 * condition that holds every 15-minute tick doesn't flood the activity feed.
 */
export async function logOnce(db, e, { withinMin = 60, nowMs = Date.now() } = {}) {
  const since = nowIso(nowMs - withinMin * 60000);
  const seen = await db.prepare(
    `SELECT id FROM events WHERE actor = ? AND kind = ? AND COALESCE(target,'') = ? AND at >= ? LIMIT 1`
  ).bind(e.actor, e.kind, e.target || "", since).first().catch(() => null);
  if (seen) return null;
  return logEvent(db, { at: nowIso(nowMs), ...e });
}

/** An agent's error: logged once an hour per agent, never thrown. */
export function logAgentError(db, actor, err, nowMs) {
  return logOnce(db, {
    actor, kind: "error.supplier",
    summary: `${actor} failed this run and will try again (${String(err && err.message).slice(0, 200)})`,
  }, { withinMin: 60, nowMs }).catch(() => null);
}

/** Normalise a size label: "Medium" → "M", "XXL" → "2XL", "xxxl" → "3XL". Null if not a letter size. */
export function normSize(s) {
  if (s == null) return null;
  let v = String(s).trim().toUpperCase().replace(/\s+/g, "");
  const words = { SMALL: "S", MEDIUM: "M", LARGE: "L", "X-LARGE": "XL", XLARGE: "XL", "XX-LARGE": "2XL", "XXX-LARGE": "3XL", "EXTRALARGE": "XL" };
  if (words[v]) return words[v];
  const xs = /^(X{2,5})L$/.exec(v);
  if (xs) return `${xs[1].length}XL`;
  const nx = /^([2-6])X$/.exec(v);
  if (nx) return `${nx[1]}XL`;
  return SIZE_ORDER.includes(v) ? v : null;
}

export const SIZE_ORDER = Object.freeze(["XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "6XL"]);
export const sizeIndex = (s) => SIZE_ORDER.indexOf(normSize(s));

/** A handle from a store product link ("https://x.com/products/navy-blazer?variant=1" → "navy-blazer"). */
export function handleFrom(value) {
  if (value == null) return null;
  const s = String(value).trim();
  const m = /\/products\/([a-z0-9][a-z0-9-]*)/i.exec(s);
  if (m) return m[1].toLowerCase();
  return /^[a-z0-9][a-z0-9-]*$/i.test(s) ? s.toLowerCase() : null;
}

export const money = (x, cur = "$") => (x == null || !Number.isFinite(Number(x)) ? "n/a" : `${cur}${Number(x).toFixed(2)}`);
