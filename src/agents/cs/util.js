/** Small shared helpers for the CS agents. */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";

/**
 * One run's allowance of outside calls (Gmail, Shopify, Claude). Every agent takes from the
 * same allowance, so a busy inbox can't push the whole Worker past its subrequest limit.
 */
export class Budget {
  constructor(n) { this.left = n; }
  take(n = 1) {
    if (this.left < n) return false;
    this.left -= n;
    return true;
  }
  /** Count calls already made (never below zero). */
  spend(n) { this.left = Math.max(0, this.left - Math.max(0, n)); }
}

/**
 * Log an event at most once per window for the same actor + kind (+ optional key), so a
 * fault that repeats every 15 minutes doesn't flood the activity feed.
 */
export async function logOnce(db, e, { windowMin = 60, key = null, nowMs = Date.now() } = {}) {
  const since = nowIso(nowMs - windowMin * 60000);
  const like = key ? `%${likeEscape(`"_k":"${cleanKey(key)}"`)}%` : "%";
  const recent = await db
    .prepare(`SELECT id FROM events WHERE actor = ? AND kind = ? AND at >= ? AND COALESCE(data, '') LIKE ? ESCAPE '\\' LIMIT 1`)
    .bind(e.actor, e.kind, since, like)
    .first()
    .catch(() => null);
  if (recent) return null;
  const data = key ? { ...(e.data || {}), _k: cleanKey(key) } : e.data;
  return logEvent(db, { ...e, data, at: e.at || nowIso(nowMs) });
}

const cleanKey = (k) => String(k).replace(/["\\]/g, "");

/** Escape a value for a LIKE pattern used with ESCAPE '\' ("_" and "%" are wildcards otherwise). */
export function likeEscape(s) {
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function safeJson(s, fallback = null) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

export const clip = (s, n) => (s == null ? s : String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
