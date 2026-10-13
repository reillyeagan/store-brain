/**
 * media.performance — Performance Analyst. SHADOW / WATCH ONLY.
 *
 * Does: per store, pulls campaign results per day for the last 14 days (today included, in
 *   the ad account's timezone) and stores them in media_campaign_days. Then, for closed days
 *   only, compares each campaign's ROAS with the store's break-even ROAS from the P&L and
 *   flags campaigns that stayed under break-even for N days in a row.
 * Inputs: Google Ads campaign report (read-only GAQL), pnl_days (margin → break-even).
 * Outputs: media_campaign_days rows, media_findings ("campaign:<id>"), one media.pulled event
 *   per run, one media.flag event when a campaign is newly flagged, and at most one short
 *   Claude-written read per store per day (media_reads).
 * Rule 5: Google's conversion value is marked DOWN to Shopify reality (reality factor ≤ 1)
 *   before it is compared with break-even, never up. Today is never judged (still moving).
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso, localDay } from "../../lib/time.js";
import {
  accountTz, minusDays, micros, int, real, r2, storeBreakeven, realityFactor,
  upsertFinding, clearUnseen, storeName, money, ratio,
} from "./common.js";
import { dailyRead } from "./reads.js";

export const AGENT = "media.performance";
export const PERF_DAYS = 14;              // today + 13 days before
export const UNDER_DAYS_DEFAULT = 3;      // N closed days in a row under break-even → flag
export const MIN_DAY_COST = 5;            // a day with less spend than this doesn't count either way

/** Pure: GAQL rows → one row per (day, campaign). Batches can repeat a key: add, don't overwrite. */
export function parseCampaignRows(rows, { from, to }) {
  const out = new Map();
  for (const r of rows || []) {
    const day = r && r.segments && r.segments.date;
    const c = (r && r.campaign) || {};
    if (!day || day < from || day > to || c.id == null) continue;
    const k = `${day}|${c.id}`;
    const m = r.metrics || {};
    const cur = out.get(k) || {
      day, campaign_id: String(c.id), campaign_name: c.name || null, channel: c.advertisingChannelType || null,
      status: c.status || null, cost: 0, clicks: 0, impressions: 0, conversions: 0, conv_value: 0,
    };
    cur.cost += micros(m.costMicros);
    cur.clicks += int(m.clicks);
    cur.impressions += int(m.impressions);
    cur.conversions += real(m.conversions);
    cur.conv_value += real(m.conversionsValue);
    out.set(k, cur);
  }
  return [...out.values()].map((v) => ({ ...v, cost: r2(v.cost), conv_value: r2(v.conv_value), conversions: Math.round(v.conversions * 100) / 100 }));
}

/**
 * Pure: how many of the most recent closed days in a row this campaign spent at least
 * MIN_DAY_COST and returned less than break-even (after the reality factor).
 * Days with too little spend don't break or extend the streak.
 */
export function underStreak(days, breakeven, factor = 1) {
  const sorted = [...days].sort((a, b) => (a.day < b.day ? 1 : -1));
  let streak = 0; let cost = 0; let value = 0;
  for (const d of sorted) {
    if (d.cost < MIN_DAY_COST) continue;
    const roas = (d.conv_value * factor) / d.cost;
    if (roas < breakeven) { streak += 1; cost += d.cost; value += d.conv_value * factor; } else break;
  }
  return { streak, cost: r2(cost), value: r2(value), roas: cost > 0 ? r2(value / cost) : null };
}

export async function runPerformance(env, { storeId, session, nowMs = Date.now(), fetchImpl = fetch }) {
  const db = env.DB;
  const tz = await accountTz(env, storeId, session);
  const today = localDay(nowMs, tz);
  const from = minusDays(today, PERF_DAYS - 1);
  const rows = await session.query(storeId,
    `SELECT segments.date, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
       metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value
     FROM campaign WHERE segments.date BETWEEN '${from}' AND '${today}'`);
  const days = parseCampaignRows(rows, { from, to: today });
  const at = nowIso(nowMs);
  for (const d of days) {
    await db.prepare(
      `INSERT INTO media_campaign_days (store, day, campaign_id, campaign_name, channel, status, cost, clicks, impressions, conversions, conv_value, currency, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(store, day, campaign_id) DO UPDATE SET campaign_name = excluded.campaign_name, channel = excluded.channel,
         status = excluded.status, cost = excluded.cost, clicks = excluded.clicks, impressions = excluded.impressions,
         conversions = excluded.conversions, conv_value = excluded.conv_value, fetched_at = excluded.fetched_at`
    ).bind(storeId, d.day, d.campaign_id, d.campaign_name, d.channel, d.status, d.cost, d.clicks, d.impressions, d.conversions, d.conv_value, at).run();
  }
  // Google omits campaign-days with no activity. A stored row in the window that Google no
  // longer returns means it now reports nothing for it: restate to zero (the account answered).
  await db.prepare(
    `UPDATE media_campaign_days SET cost = 0, clicks = 0, impressions = 0, conversions = 0, conv_value = 0, fetched_at = ?
     WHERE store = ? AND day >= ? AND day <= ? AND fetched_at <> ?`
  ).bind(at, storeId, from, today, at).run();

  // Judge closed days only.
  const to = minusDays(today, 1);
  const be = await storeBreakeven(db, storeId, from, to);
  const factor = await realityFactor(db, storeId, from, to);
  const N = Math.max(1, parseInt(env.MEDIA_UNDER_DAYS || UNDER_DAYS_DEFAULT, 10) || UNDER_DAYS_DEFAULT);
  const closed = days.filter((d) => d.day <= to);
  const byCampaign = new Map();
  for (const d of closed) {
    if (!byCampaign.has(d.campaign_id)) byCampaign.set(d.campaign_id, []);
    byCampaign.get(d.campaign_id).push(d);
  }
  const totals = closed.reduce((s, d) => ({ cost: s.cost + d.cost, value: s.value + d.conv_value }), { cost: 0, value: 0 });
  const flagged = [];
  const keys = [];
  if (be.breakeven != null) {
    for (const [cid, list] of byCampaign) {
      const s = underStreak(list, be.breakeven, factor == null ? 1 : factor);
      if (s.streak < N) continue;
      const name = list[0].campaign_name || cid;
      const key = `campaign:${cid}`;
      keys.push(key);
      const summary = `${storeName(storeId)}: "${name}" under break-even ${s.streak} days in a row (ROAS ${ratio(s.roas)} vs break-even ${ratio(be.breakeven)}, ${money(s.cost)} spent)`;
      const isNew = await upsertFinding(db, {
        store: storeId, agent: AGENT, key, severity: s.streak >= 7 ? "bad" : "warn", summary, at,
        data: { campaign_id: cid, campaign_name: name, streak: s.streak, cost: s.cost, roas: s.roas, breakeven: be.breakeven,
          reality_factor: factor, basis: factor == null ? "Google's own numbers (not checked against Shopify)" : "Google value × Shopify reality factor" },
      });
      flagged.push({ campaign_id: cid, name, ...s });
      if (isNew) {
        await logEvent(db, { actor: AGENT, kind: "media.flag", store: storeId, target: "sys.ads", summary, data: { campaign_id: cid, streak: s.streak }, at });
      }
    }
    await clearUnseen(db, { store: storeId, agent: AGENT, keys, at });
  }

  const roas = totals.cost > 0 ? r2((totals.value * (factor == null ? 1 : factor)) / totals.cost) : null;
  await logEvent(db, {
    actor: AGENT, kind: "media.pulled", store: storeId, target: "sys.ads", at,
    summary: `${storeName(storeId)}: read ${days.length} campaign-days (${from} to ${today}); closed-day spend ${money(r2(totals.cost))}, ROAS ${ratio(roas)} vs break-even ${ratio(be.breakeven)}${flagged.length ? `, ${flagged.length} campaign(s) under break-even` : ""}`,
    data: { campaign_days: days.length, cost: r2(totals.cost), roas, breakeven: be.breakeven, reality_factor: factor, flagged: flagged.length },
  });

  // At most one short written read per store per day (AI optional: numbers above stand alone).
  if (closed.length) {
    const top = [...byCampaign.entries()].map(([cid, l]) => {
      const c = l.reduce((s, d) => s + d.cost, 0); const v = l.reduce((s, d) => s + d.conv_value, 0);
      return { name: l[0].campaign_name || cid, cost: r2(c), google_roas: c > 0 ? r2(v / c) : null };
    }).sort((a, b) => b.cost - a.cost).slice(0, 8);
    await dailyRead(env, {
      store: storeId, agent: AGENT, day: today, label: `${storeName(storeId)} performance read`, maxTokens: 220,
      system: "You write a 2-3 sentence plain-English read of a store's Google Ads results for its owner. Use ONLY the numbers given; do not invent or recompute numbers. Google's conversion values tend to flatter; say so if the reality factor is below 1. No advice to change anything: this is a watch-only report.",
      user: JSON.stringify({ store: storeName(storeId), window: { from, to }, spend: r2(totals.cost), roas_adjusted: roas, breakeven_roas: be.breakeven,
        breakeven_estimated: be.estimated, reality_factor: factor, campaigns: top, flagged: flagged.map((f) => ({ name: f.name, days: f.streak, roas: f.roas })) }),
    }, { fetchImpl, nowMs });
  }
  return `ok: ${days.length} campaign-days, ${flagged.length} flagged${be.breakeven == null ? ` (break-even unknown: ${be.reason})` : ""}`;
}
