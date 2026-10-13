/** Small shared helpers for the CS agents. */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";

/**
 * One tick's allowance of outside calls (Gmail, Shopify, Claude). Every agent takes from the
 * same allowance, so a busy inbox can't push the whole Worker past its subrequest limit.
 */
export class Budget {
  constructor(n) { this.left = n; }
  take(n = 1) {
    if (this.left < n) return false;
    this.left -= n;
    return true;
  }
}

/**
 * Log an event at most once per window for the same actor + kind (+ optional key), so a
 * fault that repeats every 15 minutes doesn't flood the activity feed.
 */
export async function logOnce(db, e, { windowMin = 60, key = null, nowMs = Date.now() } = {}) {
  const since = nowIso(nowMs - windowMin * 60000);
  const like = key ? `%"_k":"${String(key).replace(/["%_]/g, "")}"%` : "%";
  const recent = await db
    .prepare(`SELECT id FROM events WHERE actor = ? AND kind = ? AND at >= ? AND COALESCE(data, '') LIKE ? LIMIT 1`)
    .bind(e.actor, e.kind, since, like)
    .first()
    .catch(() => null);
  if (recent) return null;
  const data = key ? { ...(e.data || {}), _k: String(key).replace(/["%_]/g, "") } : e.data;
  return logEvent(db, { ...e, data, at: e.at || nowIso(nowMs) });
}

export function safeJson(s, fallback = null) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

export const clip = (s, n) => (s == null ? s : String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
