/**
 * media.season — Keyword & Season. SHADOW / WATCH ONLY. Plain code (no AI yet).
 *
 * Does: per store, once a day, reads weekly impressions/clicks/cost per keyword for the last
 *   five weeks and compares the last complete week with the week before for the top keywords.
 *   A keyword whose impressions rose or fell by 30%+ (on at least 100 impressions) is flagged
 *   as rising/falling.
 * Caveat it states itself: impressions move with Guy's budgets and bids, not only with demand.
 *   If the change history shows budget/bid/status changes in those two weeks, every trend
 *   says so. True search volume needs Google's Keyword Planner (not wired).
 * Inputs: Google Ads keyword_view (read-only), media_changes (Guy Monitor).
 * Outputs: media_keyword_weeks rows, media_findings ("kw:<keyword>", severity info), one
 *   media.pulled event per run. Performance Max has no keywords, so PMax-only accounts show none.
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { accountTz, windowFor, minusDays, micros, int, r2, upsertFinding, clearUnseen, storeName, runBatched, MAX_STORED_ROWS } from "./common.js";

export const AGENT = "media.season";
export const TOP_KEYWORDS = 25;
export const MOVE_PCT = 0.3;
export const MIN_IMPRESSIONS = 100;

/** Monday (YYYY-MM-DD) of the week a day falls in (Google's segments.week is Monday-based). */
export function mondayOf(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return minusDays(day, back);
}

/** Pure: GAQL rows → one row per (week, keyword). */
export function parseKeywordRows(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const kw = r && r.adGroupCriterion && r.adGroupCriterion.keyword && r.adGroupCriterion.keyword.text;
    const week = r && r.segments && r.segments.week;
    if (!kw || !week) continue;
    const k = `${week}|${kw.toLowerCase()}`;
    const m = r.metrics || {};
    const cur = out.get(k) || { week, keyword: kw.toLowerCase(), impressions: 0, clicks: 0, cost: 0 };
    cur.impressions += int(m.impressions);
    cur.clicks += int(m.clicks);
    cur.cost += micros(m.costMicros);
    out.set(k, cur);
  }
  return [...out.values()].map((v) => ({ ...v, cost: r2(v.cost) }));
}

/** Pure: compare two weeks for the top keywords. Returns [{keyword, prev, last, change, dir}]. */
export function weekTrends(rows, lastWeek, prevWeek, { top = TOP_KEYWORDS, movePct = MOVE_PCT, minImp = MIN_IMPRESSIONS } = {}) {
  const last = new Map(); const prev = new Map();
  for (const r of rows) {
    if (r.week === lastWeek) last.set(r.keyword, r.impressions);
    if (r.week === prevWeek) prev.set(r.keyword, r.impressions);
  }
  const all = [...new Set([...last.keys(), ...prev.keys()])]
    .map((k) => ({ keyword: k, last: last.get(k) || 0, prev: prev.get(k) || 0 }))
    .sort((a, b) => Math.max(b.last, b.prev) - Math.max(a.last, a.prev))
    .slice(0, top);
  const out = [];
  for (const k of all) {
    if (Math.max(k.last, k.prev) < minImp) continue;
    const change = k.prev > 0 ? (k.last - k.prev) / k.prev : null;
    const dir = change == null ? "new" : change >= movePct ? "rising" : change <= -movePct ? "falling" : null;
    if (dir) out.push({ ...k, change: change == null ? null : Math.round(change * 1000) / 1000, dir });
  }
  return out;
}

export async function runSeason(env, { storeId, session, nowMs = Date.now() }) {
  const db = env.DB;
  const tz = await accountTz(env, storeId, session);
  const { today, to } = windowFor(nowMs, tz, 1);
  const thisWeek = mondayOf(today);
  const lastWeek = minusDays(thisWeek, 7);   // last COMPLETE week
  const prevWeek = minusDays(thisWeek, 14);
  const from = minusDays(thisWeek, 35);
  const rows = await session.query(storeId,
    `SELECT ad_group_criterion.keyword.text, segments.week, metrics.impressions, metrics.clicks, metrics.cost_micros
     FROM keyword_view WHERE segments.date BETWEEN '${from}' AND '${to}' AND metrics.impressions > 0`);
  const weeks = parseKeywordRows(rows);
  const at = nowIso(nowMs);
  // Batched and capped (the busiest keyword-weeks), so a big account can't blow the per-run query limit.
  const keep = [...weeks].sort((a, b) => b.impressions - a.impressions).slice(0, MAX_STORED_ROWS);
  await runBatched(db, keep.map((w) => db.prepare(
    `INSERT INTO media_keyword_weeks (store, week, keyword, impressions, clicks, cost, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(store, week, keyword) DO UPDATE SET impressions = excluded.impressions, clicks = excluded.clicks, cost = excluded.cost, fetched_at = excluded.fetched_at`
  ).bind(storeId, w.week, w.keyword, w.impressions, w.clicks, w.cost, at)));
  const trends = weekTrends(weeks, lastWeek, prevWeek);
  // Did anyone change budgets, bids or statuses in those two weeks? Then impressions aren't pure demand.
  const ch = await db.prepare(
    `SELECT COUNT(*) AS n FROM media_changes WHERE store = ? AND changed_at >= ? AND changed_at < ?
     AND resource_type IN ('CAMPAIGN_BUDGET', 'CAMPAIGN', 'AD_GROUP', 'AD_GROUP_CRITERION', 'CAMPAIGN_CRITERION', 'AD_GROUP_BID_MODIFIER')`
  ).bind(storeId, prevWeek, thisWeek).first();
  const confounded = Number((ch && ch.n) || 0);
  const keys = [];
  for (const t of trends) {
    const key = `kw:${t.keyword}`;
    keys.push(key);
    const pct = t.change == null ? "new" : `${t.change > 0 ? "+" : ""}${Math.round(t.change * 100)}%`;
    await upsertFinding(db, {
      store: storeId, agent: AGENT, key, severity: "info", at,
      summary: `${storeName(storeId)}: "${t.keyword}" ${t.dir} (${t.prev} → ${t.last} impressions, ${pct}, week of ${lastWeek})${confounded ? `; ${confounded} account change(s) in these weeks, so not pure demand` : ""}`,
      data: { ...t, last_week: lastWeek, prev_week: prevWeek, account_changes: confounded },
    });
  }
  await clearUnseen(db, { store: storeId, agent: AGENT, keys, at });
  const up = trends.filter((t) => t.dir === "rising").length;
  const down = trends.filter((t) => t.dir === "falling").length;
  await logEvent(db, {
    actor: AGENT, kind: "media.pulled", store: storeId, target: "sys.ads", at,
    summary: `${storeName(storeId)}: keyword weeks read; week of ${lastWeek} vs ${prevWeek}: ${up} rising, ${down} falling${confounded ? ` (${confounded} account changes in the window)` : ""}`,
    data: { rows: weeks.length, rising: up, falling: down, account_changes: confounded },
  });
  return `ok: ${weeks.length} keyword-weeks, ${up} rising, ${down} falling`;
}
