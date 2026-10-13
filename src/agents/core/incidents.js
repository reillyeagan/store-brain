/**
 * Incident Desk (core.incidents) — plain code today, L1, shadow-safe (reads events and
 * job_runs, writes only its own table, events and at most ONE approval per incident).
 *
 * What it does: groups `error.*` events by actor + kind into incidents and decides, per group,
 * whether it is still going on:
 *   - recovered: the job that failed has since run and reported "ok" (job_runs, matched by the
 *     error kind: a department step "pnl.funnel" logs its failures as "error.pnl_funnel");
 *   - quiet:     no error for longer than the job's own rhythm. Without a job_runs match the
 *     rhythm is learned from the errors themselves: 1.5 × the gap between its last two errors,
 *     and never less than QUIET_MIN. So a job that logs a failure hourly is quiet after 2 h, a
 *     daily job that fails every day stays open (gap 24 h → quiet only after 36 h; gaps over
 *     MAX_RHYTHM_H are not a rhythm), and a job
 *     that has a job_runs row stays open until it succeeds (or nothing for 8 days);
 *   - ongoing:   otherwise.
 * An incident's errors are the chain of errors back from the latest one whose gaps all fit
 * that rhythm, so a daily job failing day after day adds up instead of starting over.
 * Rule 6 ("a failed probe is evidence about the probe, not the world"): one failure is never
 * an alarm. Reilly is asked only when an incident is ongoing, has failed at least MIN_ERRORS
 * times and started more than OPEN_AFTER_MIN ago, i.e. the job's own retries haven't fixed
 * it. Then exactly ONE approval ("seen") is raised for that incident; none while it's open.
 * Only the desk's own step failures (kind error.core_incidents) are ignored, so failed API
 * requests and department crashes (logged under core.incidents by the Worker) still count.
 * Inputs: events, job_runs. Outputs: incidents rows, incident.* events, approvals (dept core).
 */
import { logEvent } from "../../lib/eventlog.js";
import { createApproval } from "../../lib/approvals.js";
import { nowIso } from "../../lib/time.js";

const ACTOR = "core.incidents";
const OWN_KIND = "error.core_incidents"; // this desk's own step failures (shared.guarded)
export const WINDOW_H = 24;              // the page's "last 24 h" list
export const LOOKBACK_H = 8 * 24;        // how far back incidents are traced
export const QUIET_MIN = 120;
export const OPEN_AFTER_MIN = 120;
export const MIN_ERRORS = 2;
export const MAX_RHYTHM_H = 26;          // the longest error rhythm learned from the errors (a daily job, with slack)

/**
 * Pure: an incident from one group's error times (newest first). Returns the chain of errors
 * that belong together and how long a silence must be before it counts as quiet.
 */
export function chainOf(timesMs) {
  if (!timesMs.length) return null;
  // A gap longer than a day isn't a rhythm (two unrelated failures days apart), so it's ignored.
  const raw = timesMs.length > 1 ? timesMs[0] - timesMs[1] : null;
  const gap = raw != null && raw <= MAX_RHYTHM_H * 3600000 ? raw : null;
  const quietMs = Math.max(QUIET_MIN * 60000, gap ? 1.5 * gap : 0);
  let start = timesMs[0], count = 1;
  for (let i = 1; i < timesMs.length; i++) {
    if (timesMs[i - 1] - timesMs[i] > quietMs) break;
    start = timesMs[i];
    count++;
  }
  return { first_seen: nowIso(start), last_seen: nowIso(timesMs[0]), count, quiet_ms: quietMs };
}

/** Pure: recovered | quiet | ongoing. */
export function classify(chain, job, nowMs) {
  const lastMs = Date.parse(chain.last_seen);
  if (job) {
    if (job.last_run_at && Date.parse(job.last_run_at) > lastMs && /^ok/i.test(String(job.last_result || ""))) return "recovered";
    return nowMs - lastMs > LOOKBACK_H * 3600000 ? "quiet" : "ongoing";
  }
  return nowMs - lastMs >= chain.quiet_ms ? "quiet" : "ongoing";
}

/** The job_runs row behind an error kind, if any ("error.pnl_funnel" ↔ job "pnl.funnel"). */
async function jobFor(db, kind) {
  const suffix = String(kind).slice("error.".length);
  return db.prepare(`SELECT job, last_run_at, last_result FROM job_runs WHERE job = ? OR replace(job, '.', '_') = ? LIMIT 1`)
    .bind(suffix, suffix).first().catch(() => null);
}

/** Error groups since a moment, each traced into an incident and classified. */
export async function errorGroups(db, nowMs = Date.now(), windowH = WINDOW_H) {
  const since = nowIso(nowMs - windowH * 3600000);
  const { results } = await db.prepare(
    `SELECT actor, kind, COUNT(*) AS n FROM events WHERE kind LIKE 'error.%' AND kind != ? AND at >= ? GROUP BY actor, kind ORDER BY MAX(at) DESC LIMIT 50`
  ).bind(OWN_KIND, since).all();
  const out = [];
  const back = nowIso(nowMs - LOOKBACK_H * 3600000);
  for (const g of results || []) {
    const { results: times } = await db.prepare(`SELECT at, summary FROM events WHERE actor = ? AND kind = ? AND at >= ? ORDER BY at DESC LIMIT 200`)
      .bind(g.actor, g.kind, back).all();
    const chain = chainOf((times || []).map((t) => Date.parse(t.at)));
    if (!chain) continue;
    const job = await jobFor(db, g.kind);
    out.push({ actor: g.actor, kind: g.kind, ...chain, last_summary: times[0].summary, job: job ? job.job : null, status: classify(chain, job, nowMs) });
  }
  return out;
}

export async function runIncidents(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const groups = await errorGroups(db, nowMs, LOOKBACK_H);
  let opened = 0, resolved = 0, asked = 0;
  for (const g of groups) {
    const key = `${g.actor}|${g.kind}`;
    const inc = await db.prepare(`SELECT * FROM incidents WHERE key = ?`).bind(key).first();
    if (g.status === "ongoing") {
      if (!inc || inc.status !== "open") {
        // Same chain as an incident already asked about (e.g. it went quiet between two daily
        // failures under an older rule)? Keep its approval: one ask per incident.
        const keepAsk = inc && inc.approval_id && inc.first_seen >= g.first_seen ? inc.approval_id : null;
        await db.prepare(
          `INSERT INTO incidents (key, actor, kind, first_seen, last_seen, count, last_summary, status, approval_id, opened_at, resolved_at, resolution)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL, NULL)
           ON CONFLICT(key) DO UPDATE SET first_seen = excluded.first_seen, last_seen = excluded.last_seen, count = excluded.count,
             last_summary = excluded.last_summary, status = 'open', approval_id = excluded.approval_id, opened_at = excluded.opened_at, resolved_at = NULL, resolution = NULL`
        ).bind(key, g.actor, g.kind, g.first_seen, g.last_seen, g.count, g.last_summary, keepAsk, at).run();
        opened++;
        await logEvent(db, { actor: ACTOR, kind: "incident.opened", target: g.actor,
          summary: `Watching: ${g.actor} ${g.kind} (${g.count} error${g.count === 1 ? "" : "s"} since ${g.first_seen.slice(0, 16).replace("T", " ")} UTC); its retries come first, no alarm yet`,
          data: { key }, at });
      } else {
        await db.prepare(`UPDATE incidents SET first_seen = ?, last_seen = ?, count = ?, last_summary = ? WHERE key = ?`).bind(g.first_seen, g.last_seen, g.count, g.last_summary, key).run();
      }
      const row = await db.prepare(`SELECT * FROM incidents WHERE key = ?`).bind(key).first();
      const age = nowMs - Date.parse(row.first_seen);
      if (row.approval_id == null && row.count >= MIN_ERRORS && age >= OPEN_AFTER_MIN * 60000) {
        // Claim the ask first (approval_id = 0) so two overlapping runs can't both ask.
        const claim = await db.prepare(`UPDATE incidents SET approval_id = 0 WHERE key = ? AND approval_id IS NULL`).bind(key).run();
        if (!claim.meta || claim.meta.changes !== 1) continue;
        let id;
        try {
          id = await createApproval(db, {
            dept: "core", requestedBy: ACTOR,
            title: `Ongoing problem: ${g.actor} (${g.kind}) has failed ${row.count} times since ${row.first_seen.slice(0, 16).replace("T", " ")} UTC and its retries haven't fixed it. Latest: ${String(g.last_summary || "").slice(0, 160)}`,
            options: [{ id: "seen", label: "Seen, I'll look", detail: "The brain keeps watching and says when it recovers." }],
          });
        } catch (err) {
          // Release the claim so the next run can ask (otherwise this incident would never reach Reilly).
          await db.prepare(`UPDATE incidents SET approval_id = NULL WHERE key = ? AND approval_id = 0`).bind(key).run().catch(() => {});
          throw err;
        }
        await db.prepare(`UPDATE incidents SET approval_id = ? WHERE key = ?`).bind(id, key).run();
        asked++;
      }
    } else if (inc && inc.status === "open") {
      await resolve(db, inc, g.status, at);
      resolved++;
    }
  }
  // Open incidents with no error left in the lookback are quiet by definition.
  const { results: open } = await db.prepare(`SELECT * FROM incidents WHERE status = 'open'`).all();
  for (const inc of open || []) {
    if (groups.some((g) => `${g.actor}|${g.kind}` === inc.key)) continue;
    await resolve(db, inc, "quiet", at);
    resolved++;
  }
  return { groups: groups.length, opened, resolved, asked };
}

async function resolve(db, inc, how, at) {
  await db.prepare(`UPDATE incidents SET status = 'resolved', resolved_at = ?, resolution = ? WHERE key = ?`).bind(at, how, inc.key).run();
  await logEvent(db, { actor: ACTOR, kind: "incident.resolved", target: inc.actor,
    summary: `${inc.actor} ${inc.kind}: ${how === "recovered" ? "its job ran OK again" : "no errors for longer than its usual rhythm"} after ${inc.count} error${inc.count === 1 ? "" : "s"}${inc.approval_id ? `; approval #${inc.approval_id} can be closed` : ""}`,
    data: { key: inc.key, resolution: how, approvalId: inc.approval_id || null }, at });
}

export async function incidentsState(db, { nowMs = Date.now() } = {}) {
  const { results: open } = await db.prepare(`SELECT * FROM incidents WHERE status = 'open' ORDER BY last_seen DESC LIMIT 50`).all();
  const { results: recent } = await db.prepare(`SELECT * FROM incidents WHERE status = 'resolved' ORDER BY resolved_at DESC LIMIT 20`).all();
  const groups = await errorGroups(db, nowMs, WINDOW_H);
  return { open: open || [], recently_resolved: recent || [], last_24h: groups.slice(0, 50),
    rules: { min_quiet_min: QUIET_MIN, ask_after_min: OPEN_AFTER_MIN, min_errors: MIN_ERRORS, lookback_h: LOOKBACK_H } };
}
