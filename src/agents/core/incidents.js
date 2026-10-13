/**
 * Incident Desk (core.incidents) — plain code today, L1, shadow-safe (reads events, writes
 * only its own table, events and at most ONE approval per incident).
 *
 * What it does: groups `error.*` events of the last 24 h by actor + kind and decides, per group:
 *   - transient: no error for QUIET_MIN. Jobs retry every 15-60 min and log a repeating error
 *     at most once an hour, so 2 h without one means the retries are getting through.
 *   - ongoing:   an error within QUIET_MIN.
 * A success logged by the same agent after its last error is shown ("recovered at"), but is
 * not enough on its own to close an incident: an agent runs several jobs, and a success from
 * one of them says nothing about the one that is failing (errors run in the flattering
 * direction, rule 5).
 * Rule 6 ("a failed probe is evidence about the probe, not the world"): one failure is never
 * an alarm. Reilly is asked only when an incident is ongoing, has failed at least MIN_ERRORS
 * times, and started more than OPEN_AFTER_MIN ago, i.e. the job's own retries haven't fixed
 * it. Then exactly ONE approval ("seen") is raised for that episode; no second one while it is
 * open. When it goes quiet, `incident.resolved` says so.
 * Inputs: events. Outputs: incidents rows, incident.* events, approvals (dept core).
 */
import { logEvent } from "../../lib/eventlog.js";
import { createApproval } from "../../lib/approvals.js";
import { nowIso } from "../../lib/time.js";

const ACTOR = "core.incidents";
export const WINDOW_H = 24;
export const QUIET_MIN = 120;
export const OPEN_AFTER_MIN = 120;
export const MIN_ERRORS = 2;

/** Pure: ongoing while the last error is younger than QUIET_MIN. */
export const isOngoing = (lastSeenIso, nowMs) => nowMs - Date.parse(lastSeenIso) < QUIET_MIN * 60000;

/** Error groups of the last 24 h (the Incident Desk's own errors excluded). */
export async function errorGroups(db, nowMs = Date.now()) {
  const since = nowIso(nowMs - WINDOW_H * 3600000);
  const { results } = await db.prepare(
    `SELECT actor, kind, COUNT(*) AS count, MIN(at) AS first_seen, MAX(at) AS last_seen
       FROM events WHERE kind LIKE 'error.%' AND at >= ? AND actor != ? GROUP BY actor, kind ORDER BY last_seen DESC LIMIT 50`
  ).bind(since, ACTOR).all();
  const out = [];
  for (const g of results || []) {
    const last = await db.prepare(`SELECT summary FROM events WHERE actor = ? AND kind = ? ORDER BY id DESC LIMIT 1`).bind(g.actor, g.kind).first();
    const ok = await db.prepare(
      `SELECT at FROM events WHERE actor = ? AND at > ? AND kind NOT LIKE 'error.%' AND kind != 'ai.call' ORDER BY id DESC LIMIT 1`
    ).bind(g.actor, g.last_seen).first();
    out.push({ ...g, last_summary: last ? last.summary : null, status: isOngoing(g.last_seen, nowMs) ? "ongoing" : "transient", recovered_at: ok ? ok.at : null });
  }
  return out;
}

/** Errors of one actor+kind after a moment: the size of the current episode. */
async function episode(db, actor, kind, afterIso) {
  return db.prepare(`SELECT COUNT(*) AS count, MIN(at) AS first_seen, MAX(at) AS last_seen FROM events WHERE actor = ? AND kind = ? AND at > ?`)
    .bind(actor, kind, afterIso).first();
}

export async function runIncidents(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const groups = await errorGroups(db, nowMs);
  let opened = 0, resolved = 0, asked = 0;
  for (const g of groups) {
    const key = `${g.actor}|${g.kind}`;
    const inc = await db.prepare(`SELECT * FROM incidents WHERE key = ?`).bind(key).first();
    if (g.status === "ongoing") {
      // The episode starts after the previous one was resolved (if any), so old errors don't count twice.
      const bound = inc && inc.status === "open" ? nowIso(Date.parse(inc.first_seen) - 1) : inc && inc.resolved_at ? inc.resolved_at : nowIso(nowMs - WINDOW_H * 3600000);
      const ep = await episode(db, g.actor, g.kind, bound);
      if (!ep || !ep.count) continue; // the only recent errors belong to an episode already closed
      if (!inc || inc.status !== "open") {
        await db.prepare(
          `INSERT INTO incidents (key, actor, kind, first_seen, last_seen, count, last_summary, status, approval_id, opened_at, resolved_at, resolution)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, NULL, NULL)
           ON CONFLICT(key) DO UPDATE SET first_seen = excluded.first_seen, last_seen = excluded.last_seen, count = excluded.count,
             last_summary = excluded.last_summary, status = 'open', approval_id = NULL, opened_at = excluded.opened_at, resolved_at = NULL, resolution = NULL`
        ).bind(key, g.actor, g.kind, ep.first_seen, ep.last_seen, ep.count, g.last_summary, at).run();
        opened++;
        await logEvent(db, { actor: ACTOR, kind: "incident.opened", target: g.actor,
          summary: `Watching: ${g.actor} ${g.kind} (${ep.count} error${ep.count === 1 ? "" : "s"} since ${ep.first_seen.slice(11, 16)} UTC); its retries come first, no alarm yet`,
          data: { key }, at });
      } else {
        await db.prepare(`UPDATE incidents SET last_seen = ?, count = ?, last_summary = ? WHERE key = ?`).bind(ep.last_seen, ep.count, g.last_summary, key).run();
      }
      const row = await db.prepare(`SELECT * FROM incidents WHERE key = ?`).bind(key).first();
      const age = nowMs - Date.parse(row.first_seen);
      if (!row.approval_id && row.count >= MIN_ERRORS && age >= OPEN_AFTER_MIN * 60000) {
        // Claim the ask first (approval_id = 0) so two overlapping runs can't both ask.
        const claim = await db.prepare(`UPDATE incidents SET approval_id = 0 WHERE key = ? AND approval_id IS NULL`).bind(key).run();
        if (!claim.meta || claim.meta.changes !== 1) continue;
        const id = await createApproval(db, {
          dept: "core", requestedBy: ACTOR,
          title: `Ongoing problem: ${g.actor} (${g.kind}) has failed ${row.count} times since ${row.first_seen.slice(0, 16).replace("T", " ")} UTC and its retries haven't fixed it. Latest: ${String(g.last_summary || "").slice(0, 160)}`,
          options: [{ id: "seen", label: "Seen, I'll look", detail: "The brain keeps watching and says when it goes quiet." }],
        });
        await db.prepare(`UPDATE incidents SET approval_id = ? WHERE key = ?`).bind(id, key).run();
        asked++;
      }
    } else if (inc && inc.status === "open") {
      await resolve(db, inc, g, at);
      resolved++;
    }
  }
  // Open incidents whose errors fell out of the 24 h window are quiet by definition.
  const { results: open } = await db.prepare(`SELECT * FROM incidents WHERE status = 'open'`).all();
  for (const inc of open || []) {
    if (groups.some((g) => `${g.actor}|${g.kind}` === inc.key)) continue;
    await resolve(db, inc, null, at);
    resolved++;
  }
  return { groups: groups.length, opened, resolved, asked };
}

async function resolve(db, inc, g, at) {
  await db.prepare(`UPDATE incidents SET status = 'resolved', resolved_at = ?, resolution = 'quiet' WHERE key = ?`).bind(at, inc.key).run();
  await logEvent(db, { actor: ACTOR, kind: "incident.resolved", target: inc.actor,
    summary: `${inc.actor} ${inc.kind}: no errors for ${QUIET_MIN / 60} h after ${inc.count} error${inc.count === 1 ? "" : "s"}${g && g.recovered_at ? ` (last success ${String(g.recovered_at).slice(11, 16)} UTC)` : ""}${inc.approval_id ? `; approval #${inc.approval_id} can be closed` : ""}`,
    data: { key: inc.key, approvalId: inc.approval_id || null }, at });
}

export async function incidentsState(db, { nowMs = Date.now() } = {}) {
  const { results: open } = await db.prepare(`SELECT * FROM incidents WHERE status = 'open' ORDER BY last_seen DESC LIMIT 50`).all();
  const { results: recent } = await db.prepare(`SELECT * FROM incidents WHERE status = 'resolved' ORDER BY resolved_at DESC LIMIT 20`).all();
  const groups = await errorGroups(db, nowMs);
  return { open: open || [], recently_resolved: recent || [], last_24h: groups.slice(0, 50),
    rules: { quiet_after_min: QUIET_MIN, ask_after_min: OPEN_AFTER_MIN, min_errors: MIN_ERRORS } };
}
