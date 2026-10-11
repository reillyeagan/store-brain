/**
 * Event Log — every action by every worker, one row each.
 * Mission Control draws only from this table, so the map can never show activity
 * that didn't happen.
 */
import { nowIso } from "./time.js";
import { isKnownActor } from "../config/agents.js";

const SECRET_KEY = /(secret|token|password|passwd|api[_-]?key|authorization|cookie|hmac|signature)/i;

/** Remove anything that looks like a credential before it is stored. */
export function redact(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * @param {D1Database} db
 * @param {{actor:string, kind:string, summary:string, store?:string, target?:string,
 *          ticketId?:number, data?:object, costUsd?:number, at?:string}} e
 * @returns {Promise<number>} event id
 */
export async function logEvent(db, e) {
  if (!e || !e.actor || !e.kind || !e.summary) {
    throw new Error("logEvent: actor, kind and summary are required");
  }
  let data = e.data == null ? null : redact(e.data);
  if (!isKnownActor(e.actor)) {
    // Not fatal: unknown actors still get logged, but flagged so the map can show them.
    data = data && typeof data === "object" && !Array.isArray(data)
      ? { ...data, _unknownActor: true }
      : { value: data, _unknownActor: true };
  }
  const res = await db
    .prepare(
      `INSERT INTO events (at, actor, kind, store, target, ticket_id, summary, data, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      e.at || nowIso(),
      e.actor,
      e.kind,
      e.store ?? null,
      e.target ?? null,
      e.ticketId ?? null,
      String(e.summary).slice(0, 500),
      data == null ? null : JSON.stringify(data),
      Number.isFinite(e.costUsd) ? e.costUsd : 0
    )
    .run();
  return res.meta && res.meta.last_row_id;
}

/** Most recent events first. */
export async function recentEvents(db, { limit = 200, sinceIso = null } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
  const stmt = sinceIso
    ? db.prepare(`SELECT * FROM events WHERE at >= ? ORDER BY id DESC LIMIT ?`).bind(sinceIso, lim)
    : db.prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`).bind(lim);
  const { results } = await stmt.all();
  return (results || []).map((r) => ({ ...r, data: r.data ? safeJson(r.data) : null }));
}

/** Total AI cost logged since a moment (for Mission Control's cost tile). */
export async function costSince(db, sinceIso) {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM events WHERE at >= ?`)
    .bind(sinceIso)
    .first();
  return row ? Number(row.total) : 0;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return { _unparsed: String(s).slice(0, 200) }; }
}
