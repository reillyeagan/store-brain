/**
 * Auditor (core.auditor) — plain code (no AI needed), L2, shadow-safe (reads the ledger,
 * writes only events and its own findings table).
 *
 * Rule 9 at runtime, "the author never audits its own work": every run samples OTHER agents'
 * recent output and checks invariants that must always hold:
 *   1. P&L rows: profit is never a number when an input is missing (rule 4/5), and a row is
 *      never "complete" without a profit.
 *   2. Approvals: never two pending approvals for the same thing (same requester, store, title).
 *   3. Floods: no agent logs more than FLOOD_PER_HOUR events in an hour.
 *   4. AI spend: today's AI cost against the daily budget (warn at 80%, alarm over 100%).
 *   5. The latest morning brief: how many of its numbers were not verified against the data.
 *   6. Feeds: any feed stale or failing for longer than STALE_FEED_HOURS.
 *   7. Events from actors that aren't in the registry.
 * Inputs: pnl_days, approvals, events, briefs, feeds. Outputs: `audit.*` events, rate-limited
 * (each distinct finding at most once every RELOG_HOURS while it persists), and
 * `audit_findings` rows for the page. It never fixes anything: it reports.
 * The Auditor's own events are excluded from the flood check: someone else audits the auditor.
 * The Router's hand-offs are excluded too: after an outage it catches up in bursts by design
 * (one hand-off per routed event, bounded per run), which is not a flood.
 */
import { logEvent, costSince } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { DEFAULT_DAILY_BUDGET_USD } from "../../lib/ai.js";
import { evaluateFeeds } from "../../lib/freshness.js";
import { safeJson } from "./shared.js";

const ACTOR = "core.auditor";

export const AUDIT_DAYS = 14;          // P&L rows checked: the last two weeks
export const FLOOD_PER_HOUR = 120;     // more than this in an hour = flooding the feed
export const STALE_FEED_HOURS = 24;
export const RELOG_HOURS = 6;

const MONEY_INPUTS = ["revenue", "refunds", "cogs", "ads", "guy_fee", "fees"];

/** Pure: findings for a list of pnl_days rows. */
export function auditPnlRows(rows) {
  const out = [];
  for (const r of rows) {
    const notes = safeJson(r.notes, {}) || {};
    const nullInputs = MONEY_INPUTS.filter((k) => r[k] == null);
    const missing = Array.isArray(notes.missing) ? notes.missing : [];
    if (r.profit != null && (nullInputs.length || missing.length)) {
      out.push({ kind: "audit.pnl_profit_without_inputs", subject: "pnl.ledger", store: r.store, key: `${r.store}:${r.day}`,
        summary: `P&L ${r.store} ${r.day} shows profit $${Number(r.profit).toFixed(2)} although ${[...new Set([...nullInputs, ...missing])].join(", ")} ${nullInputs.length + missing.length === 1 ? "is" : "are"} missing`,
        detail: { day: r.day, profit: r.profit, null_inputs: nullInputs, missing } });
    }
    if (Number(r.complete) === 1 && r.profit == null) {
      out.push({ kind: "audit.pnl_complete_without_profit", subject: "pnl.ledger", store: r.store, key: `${r.store}:${r.day}`,
        summary: `P&L ${r.store} ${r.day} is marked complete but has no profit`, detail: { day: r.day } });
    }
  }
  return out;
}

async function gather(db, nowMs, env) {
  const findings = [];
  const since14 = new Date(nowMs - AUDIT_DAYS * 86400000).toISOString().slice(0, 10);
  const { results: rows } = await db.prepare(`SELECT store, day, profit, complete, notes, ${MONEY_INPUTS.join(", ")} FROM pnl_days WHERE day >= ?`).bind(since14).all();
  findings.push(...auditPnlRows(rows || []));

  // 2. duplicate pending approvals
  const { results: dups } = await db.prepare(
    `SELECT requested_by, COALESCE(store, '') AS store, title, COUNT(*) AS n, GROUP_CONCAT(id) AS ids
       FROM approvals WHERE status = 'pending' GROUP BY requested_by, COALESCE(store, ''), title HAVING COUNT(*) > 1 LIMIT 20`
  ).all();
  for (const d of dups || []) {
    findings.push({ kind: "audit.approval_duplicate", subject: d.requested_by, store: d.store || null, key: `${d.requested_by}:${d.store}:${d.title}`.slice(0, 200),
      summary: `${d.n} identical pending approvals from ${d.requested_by}: "${String(d.title).slice(0, 100)}"`, detail: { ids: String(d.ids).split(",").map(Number) } });
  }

  // 3. floods (the auditor's own events excluded: rule 9)
  const hourAgo = nowIso(nowMs - 3600000);
  const flood = Number(env.AUDIT_FLOOD_PER_HOUR) > 0 ? Number(env.AUDIT_FLOOD_PER_HOUR) : FLOOD_PER_HOUR;
  const { results: busy } = await db.prepare(
    `SELECT actor, COUNT(*) AS n FROM events WHERE at >= ? AND actor NOT IN (?, 'core.router') AND kind != 'route.handoff'
      GROUP BY actor HAVING COUNT(*) > ? ORDER BY n DESC LIMIT 10`
  ).bind(hourAgo, ACTOR, flood).all();
  for (const b of busy || []) {
    findings.push({ kind: "audit.flood", subject: b.actor, key: b.actor,
      summary: `${b.actor} logged ${b.n} events in the last hour (limit ${flood})`, detail: { count: b.n, limit: flood } });
  }

  // 4. AI spend vs budget (UTC day, as ai.js counts it)
  // Same rule as ai.js aiBudgetLeft: a setting that isn't a positive number means the default cap.
  const capRaw = Number(env.AI_DAILY_BUDGET_USD);
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : DEFAULT_DAILY_BUDGET_USD;
  const dayStart = new Date(Math.floor(nowMs / 86400000) * 86400000).toISOString();
  const spent = await costSince(db, dayStart);
  if (cap > 0 && spent > cap) {
    findings.push({ kind: "audit.ai_over_budget", subject: "sys.claude", key: dayStart.slice(0, 10),
      summary: `AI spend today $${spent.toFixed(2)} is over the $${cap.toFixed(2)} daily cap`, detail: { spent, cap } });
  } else if (cap > 0 && spent >= 0.8 * cap) {
    findings.push({ kind: "audit.ai_spend_high", subject: "sys.claude", key: dayStart.slice(0, 10),
      summary: `AI spend today $${spent.toFixed(2)} is ${Math.round((spent / cap) * 100)}% of the $${cap.toFixed(2)} daily cap`, detail: { spent, cap } });
  }

  // 5. latest brief: unverified numbers
  const brief = await db.prepare(`SELECT id, day, checked, unverified FROM briefs WHERE status = 'ready' ORDER BY id DESC LIMIT 1`).first().catch(() => null);
  if (brief && brief.checked === 0) {
    const list = safeJson(brief.unverified, []) || [];
    findings.push({ kind: "audit.brief_unverified", subject: "core.briefer", key: brief.day,
      summary: `Morning brief ${brief.day} has ${list.length || "some"} number${list.length === 1 ? "" : "s"} not found in its data${list.length ? `: ${list.slice(0, 5).join(", ")}` : ""}`,
      detail: { briefId: brief.id, unverified: list.slice(0, 20) } });
  }

  // 6. feeds stale/failing too long
  const feeds = await evaluateFeeds(db, nowMs);
  for (const f of feeds) {
    if (f.current !== "stale" && f.current !== "failing") continue;
    const since = f.last_ok_at ? Date.parse(f.last_ok_at) : null;
    if (since != null && nowMs - since < STALE_FEED_HOURS * 3600000) continue;
    findings.push({ kind: "audit.feed_stale_long", subject: "svc.freshness", store: f.store, key: f.id,
      summary: `${f.label} has been ${f.current} ${since ? `since ${f.last_ok_at.slice(0, 16).replace("T", " ")} UTC` : "with no success ever"} (over ${STALE_FEED_HOURS} h)`,
      detail: { feed: f.id, state: f.current, last_ok_at: f.last_ok_at, last_error: f.last_error } });
  }

  // 7. unknown actors in the last day
  const { results: unknown } = await db.prepare(
    `SELECT actor, COUNT(*) AS n FROM events WHERE at >= ? AND data LIKE '%"_unknownActor":true%' GROUP BY actor LIMIT 10`
  ).bind(nowIso(nowMs - 86400000)).all();
  for (const u of unknown || []) {
    findings.push({ kind: "audit.unknown_actor", subject: u.actor, key: u.actor,
      summary: `${u.n} events in the last day from "${u.actor}", which is not in the agent registry`, detail: { count: u.n } });
  }
  return findings;
}

/**
 * One audit pass. Each finding is upserted in audit_findings; its event is logged when it is
 * new or every RELOG_HOURS while it persists. Findings not seen this pass are closed.
 */
export async function runAuditor(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const findings = await gather(db, nowMs, env);
  let logged = 0;
  const seen = [];
  for (const f of findings) {
    const key = `${f.kind}:${f.key}`;
    seen.push(key);
    const prev = await db.prepare(`SELECT * FROM audit_findings WHERE key = ?`).bind(key).first();
    const due = !prev || !prev.open || !prev.last_logged_at || Date.parse(prev.last_logged_at) <= nowMs - RELOG_HOURS * 3600000;
    await db.prepare(
      `INSERT INTO audit_findings (key, kind, subject_actor, store, summary, detail, first_seen, last_seen, last_logged_at, times_seen, open)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
       ON CONFLICT(key) DO UPDATE SET summary = excluded.summary, detail = excluded.detail, last_seen = excluded.last_seen,
         times_seen = audit_findings.times_seen + 1, open = 1,
         first_seen = CASE WHEN audit_findings.open = 1 THEN audit_findings.first_seen ELSE excluded.first_seen END,
         last_logged_at = COALESCE(?, audit_findings.last_logged_at)`
    ).bind(key, f.kind, f.subject || null, f.store || null, f.summary, JSON.stringify(f.detail || {}), at, at, due ? at : null, due ? at : null).run();
    if (due) {
      await logEvent(db, { actor: ACTOR, kind: f.kind, store: f.store || null, target: f.subject || null, summary: f.summary, data: { ...f.detail, finding: key }, at });
      logged++;
    }
  }
  // Close what is no longer found.
  const { results: open } = await db.prepare(`SELECT key FROM audit_findings WHERE open = 1`).all();
  let closed = 0;
  for (const o of open || []) {
    if (seen.includes(o.key)) continue;
    await db.prepare(`UPDATE audit_findings SET open = 0 WHERE key = ?`).bind(o.key).run();
    closed++;
  }
  return { findings: findings.length, logged, closed };
}

export async function auditorState(db) {
  const { results } = await db.prepare(`SELECT key, kind, subject_actor, store, summary, first_seen, last_seen, times_seen FROM audit_findings WHERE open = 1 ORDER BY last_seen DESC LIMIT 50`).all();
  return { open: results || [], checks: ["P&L profit never shown with inputs missing", "no duplicate pending approvals", `no agent over ${FLOOD_PER_HOUR} events/hour`, "AI spend vs daily cap", "brief numbers verified", `feeds stale over ${STALE_FEED_HOURS} h`, "events only from registered agents"] };
}
