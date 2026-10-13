/**
 * Risk & Disputes — small helpers shared by the four Risk agents.
 *
 * Why a separate file: each agent stays short and readable, and the rules that must be
 * the same everywhere (how "not wired" is told apart from a fault, how often a repeated
 * error may be logged, how days-left is counted) live in one place.
 */
import { logEvent } from "../../lib/eventlog.js";
import { localDay } from "../../lib/time.js";

export const DEPT = "risk";
export const DAY_MS = 86400000;

/** Money from a Shopify MoneyV2 / MoneyBag. Null when missing (never 0: rule 4). */
export function moneyOf(m) {
  const node = m && (m.shopMoney || m);
  const n = parseFloat(node && node.amount);
  return Number.isFinite(n) ? n : null;
}
export const currencyOf = (m) => {
  const node = m && (m.shopMoney || m);
  return (node && node.currencyCode) || null;
};

export const fmtMoney = (v, cur = "USD") =>
  v == null ? "amount unknown" : `${cur === "USD" || !cur ? "$" : cur + " "}${Number(v).toFixed(2)}`;

/** "2026-10-31" → "Oct 31". */
export function fmtDay(day) {
  if (!day) return "no due date";
  const d = new Date(`${String(day).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(day);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Whole days from today (Eastern) to a due date (YYYY-MM-DD). 0 = due today, negative =
 * overdue. Counted on Eastern calendar days and never rounded up: Shopify gives the due
 * date without a time, so we assume the earliest reading (rule 5: errors run in the
 * flattering direction, so the clock is read against us, not for us).
 */
export function daysLeft(dueDay, nowMs) {
  if (!dueDay) return null;
  const today = localDay(nowMs, "America/New_York");
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${String(dueDay).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(b)) return null;
  return Math.round((b - a) / DAY_MS);
}

/** Store Guard says the store's app credentials aren't pasted in yet. */
export const isNotWired = (err) => !!err && err.code === "NOT_WIRED";

/** Shopify refused for lack of a scope: a wiring gap, not a fault in the world. */
export const isAccessDenied = (err) =>
  !!err && err.code === "GRAPHQL_ERRORS" && /access denied|not approved|required access|scope/i.test(String(err.message));

/**
 * Log an event at most once per window for the same actor + kind + store. Used for errors
 * and "not wired" notes, so a fault that repeats every tick doesn't flood the feed.
 * Returns true if it logged.
 */
export async function logOnce(db, e, { windowMin = 60, nowMs = Date.now() } = {}) {
  const since = new Date(nowMs - windowMin * 60000).toISOString();
  const seen = await db.prepare(
    `SELECT id FROM events WHERE actor = ? AND kind = ? AND COALESCE(store, '') = COALESCE(?, '') AND at >= ? LIMIT 1`
  ).bind(e.actor, e.kind, e.store ?? null, since).first().catch(() => null);
  if (seen) return false;
  await logEvent(db, { ...e, at: e.at || new Date(nowMs).toISOString() });
  return true;
}

/** Record a store/agent problem the right way: "not wired" once a day, faults once an hour. */
export async function logProblem(db, actor, storeId, err, what, nowMs) {
  const msg = String((err && err.message) || err).slice(0, 240);
  if (isNotWired(err) || isAccessDenied(err)) {
    await logOnce(db, {
      actor, kind: "risk.not_wired", store: storeId,
      summary: `${what}: not wired for this store (${msg}). Skipped; nothing assumed.`,
      data: { reason: msg },
    }, { windowMin: 24 * 60, nowMs }).catch(() => {});
    return "not_wired";
  }
  await logOnce(db, {
    actor, kind: "error.risk", store: storeId,
    summary: `${what} failed; it will try again next run (${msg})`,
  }, { windowMin: 60, nowMs }).catch(() => {});
  return "error";
}

/** Short stable fingerprint of a text (dedupe key). SHA-256, first 16 hex chars. */
export async function fingerprint(text) {
  const bytes = new TextEncoder().encode(String(text).toLowerCase().replace(/\s+/g, " ").trim());
  const sig = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(sig)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeJson(s, fallback = null) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/** Does a table exist in the ledger? (Other departments' tables are optional inputs.) */
export async function tableExists(db, name) {
  const r = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).bind(name).first().catch(() => null);
  return !!r;
}
