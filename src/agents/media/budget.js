/**
 * media.budget — Budget Strategist. SHADOW / WATCH ONLY. No API calls.
 *
 * Does: once a day, for every watched store, works out (in code) what it WOULD do with each
 *   enabled campaign's budget if it ran the accounts, and keeps those calls as proposals —
 *   never applied (Guy runs the accounts; Reilly, 2026-10-11). The calls are the start of a
 *   track record Reilly asked for before he can drop Guy ("we need more data").
 *
 * Calls (last 7 closed days, ENABLED campaigns with at least MIN_CAMPAIGN_COST spend;
 * paused and removed campaigns get no call at all):
 *    - cut 20%   when ROAS < 0.8 × break-even,
 *    - raise 20% when ROAS ≥ 1.3 × break-even,
 *    - hold      in between,
 *    - a "move" line (cut amount → best campaign) when a store has both; it is a summary of
 *      the cut and the raise, never scored on its own (no double counting).
 *   ROAS = Google's conversion value capped at the store's total Shopify revenue. If that cap
 *   can't be computed (no P&L revenue for the window), the store gets NO calls: falling back
 *   to Google's raw numbers would flatter (rule 5). Break-even comes from the P&L margin; when
 *   COGS is estimated, every title says so.
 *
 * One call per campaign and direction: while the same call still holds it is refreshed, not
 *   re-made, so a campaign is not counted seven times a week. When the condition changes the
 *   call is closed and a new one (new day in its key) may open.
 *
 * Scoring — once per call, 7 days after it was made, against a NO-CHANGE baseline:
 *   compare the 7 days before the call with the 7 days after.
 *    - If spend moved the way the call said (Guy did the same thing): "guy_did_same", not
 *      counted as right or wrong (we can't tell what the call would have changed).
 *    - Otherwise spend stayed about the same (the no-change path): a cut is "right" if the
 *      campaign still returned under break-even (the cut would have saved money), a raise is
 *      "right" if it stayed at or above 1.0 × break-even, a hold is "right" if it stayed at or
 *      above 0.8 × break-even. No data after → "unclear".
 *   This is early and crude: weak campaigns tend to stay weak, so "right" partly measures
 *   persistence. The page shows n, distinct campaigns and this caveat; it is not yet evidence
 *   that the brain beats Guy.
 *
 * Inputs: media_campaign_days, pnl_days. Outputs: media_proposals (agent media.budget),
 *   media_reads (one Claude paragraph a day, optional), one media.proposed event per run.
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso, localDay } from "../../lib/time.js";
import { STORES } from "../../config/stores.js";
import {
  mediaStoreIds, minusDays, r2, storeBreakeven, revenueCap, breakevenLabel, CAP_LABEL, storeName, money, ratio,
} from "./common.js";
import { dailyRead } from "./reads.js";

export const AGENT = "media.budget";
export const BUDGET_DAYS = 7;
export const MIN_CAMPAIGN_COST = 50;
export const CUT_BELOW = 0.8;
export const RAISE_ABOVE = 1.3;
export const STEP = 0.2;
export const SPEND_MOVE = 0.15; // spend change of 15%+ week on week = "someone changed it"
export const SCORED_KINDS = Object.freeze(["budget_cut", "budget_raise", "budget_hold"]);
export const TRACK_RECORD_NOTE =
  "Early and crude: each call scored once, 7 days later, against leaving spend unchanged. Weak campaigns tend to stay weak, so 'right' partly measures persistence. Not yet evidence the brain beats Guy.";

/**
 * Pure: campaigns [{campaign_id, name, status, cost, value, days}] → calls.
 * `cap` = revenue cap (≤ 1). Null cap or null break-even → no calls.
 */
export function budgetCalls(campaigns, { breakeven, cap, minCost = MIN_CAMPAIGN_COST }) {
  if (breakeven == null || cap == null) return [];
  const calls = [];
  for (const c of campaigns) {
    if (c.status !== "ENABLED") continue; // paused / removed: nothing to cut or raise
    if (c.cost < minCost) continue;
    const roas = (c.value * cap) / c.cost;
    const daily = c.cost / Math.max(1, c.days);
    const base = { campaign_id: c.campaign_id, ident: c.campaign_id, name: c.name, roas: r2(roas), daily: r2(daily) };
    if (roas < breakeven * CUT_BELOW) calls.push({ ...base, kind: "budget_cut", amount: r2(daily * STEP) });
    else if (roas >= breakeven * RAISE_ABOVE) calls.push({ ...base, kind: "budget_raise", amount: r2(daily * STEP) });
    else calls.push({ ...base, kind: "budget_hold", amount: 0 });
  }
  const cuts = calls.filter((c) => c.kind === "budget_cut").sort((a, b) => a.roas - b.roas);
  const raises = calls.filter((c) => c.kind === "budget_raise").sort((a, b) => b.roas - a.roas);
  if (cuts.length && raises.length) {
    calls.push({ kind: "budget_move", ident: `${cuts[0].campaign_id}>${raises[0].campaign_id}`, from_id: cuts[0].campaign_id, from: cuts[0].name,
      to_id: raises[0].campaign_id, to: raises[0].name, amount: cuts[0].amount, from_roas: cuts[0].roas, to_roas: raises[0].roas });
  }
  return calls;
}

/**
 * Pure: score one call against the no-change baseline.
 * before/after: { daily, roas } over the 7 days before / after the call (roas capped), or null.
 */
export function scoreCall(kind, before, after, breakeven) {
  if (!SCORED_KINDS.includes(kind)) return { outcome: "not_scored" };
  if (!before || !after || after.roas == null || before.daily == null || !(before.daily > 0) || breakeven == null) return { outcome: "unclear" };
  const change = after.daily / before.daily - 1;
  const moved = Math.abs(change) >= SPEND_MOVE;
  const sameWay = (kind === "budget_cut" && change <= -SPEND_MOVE) || (kind === "budget_raise" && change >= SPEND_MOVE);
  const base = { spend_change: Math.round(change * 1000) / 1000, roas_before: before.roas, roas_after: after.roas };
  if (sameWay) return { ...base, outcome: "guy_did_same" };
  if (kind === "budget_hold" && moved) return { ...base, outcome: "unclear" }; // someone changed spend: the hold wasn't tested
  if (kind === "budget_cut") return { ...base, outcome: after.roas < breakeven ? "right" : "wrong" };
  if (kind === "budget_raise") return { ...base, outcome: after.roas >= breakeven ? "right" : "wrong" };
  return { ...base, outcome: after.roas >= breakeven * CUT_BELOW ? "right" : "wrong" };
}

/** Campaign totals over a window; status is the campaign's status on its LATEST stored day. */
async function campaignTotals(db, storeId, from, to) {
  const { results } = await db.prepare(
    `SELECT d.campaign_id, MAX(d.campaign_name) AS name, COUNT(*) AS days, SUM(d.cost) AS cost, SUM(d.conv_value) AS value,
       (SELECT s.status FROM media_campaign_days s WHERE s.store = d.store AND s.campaign_id = d.campaign_id ORDER BY s.day DESC LIMIT 1) AS status
     FROM media_campaign_days d WHERE d.store = ? AND d.day >= ? AND d.day <= ? GROUP BY d.campaign_id`
  ).bind(storeId, from, to).all();
  return (results || []).map((r) => ({ campaign_id: String(r.campaign_id), name: r.name || String(r.campaign_id), status: r.status,
    days: Number(r.days), cost: r2(r.cost), value: r2(r.value) }));
}

/** One campaign over [from, to], ROAS capped at that window's store revenue. Null if no data. */
async function campaignWindow(db, storeId, campaignId, from, to) {
  const r = await db.prepare(`SELECT COUNT(*) AS n, SUM(cost) AS cost, SUM(conv_value) AS value FROM media_campaign_days WHERE store = ? AND campaign_id = ? AND day >= ? AND day <= ?`)
    .bind(storeId, String(campaignId), from, to).first();
  if (!r || !Number(r.n)) return null;
  const cap = await revenueCap(db, storeId, from, to);
  const cost = Number(r.cost);
  return { days: Number(r.n), cost: r2(cost), daily: r2(cost / 7), cap, roas: cost > 0 && cap != null ? r2((Number(r.value) * cap) / cost) : null };
}

function titleFor(c, beText) {
  if (c.kind === "budget_cut") return `Would cut "${c.name}" by ${money(c.amount)}/day (${CAP_LABEL} ${ratio(c.roas)} vs ${beText})`;
  if (c.kind === "budget_raise") return `Would raise "${c.name}" by ${money(c.amount)}/day (${CAP_LABEL} ${ratio(c.roas)} vs ${beText})`;
  if (c.kind === "budget_hold") return `Would hold "${c.name}" (${CAP_LABEL} ${ratio(c.roas)} vs ${beText})`;
  return `Would move ${money(c.amount)}/day from "${c.from}" (${ratio(c.from_roas)}) to "${c.to}" (${ratio(c.to_roas)}); ${beText}`;
}

/**
 * Keep ONE open call per campaign (or move pair) and direction. Returns true if a new call opened.
 * The numbers at the moment the call was made are kept in detail.call; detail.latest refreshes.
 */
async function recordCall(db, storeId, c, { today, at, be, cap, window }) {
  const beText = breakevenLabel(be);
  const now = { roas: c.roas ?? null, daily: c.daily ?? null, amount: c.amount, window, breakeven: be.breakeven, breakeven_estimated: be.estimated, revenue_cap: cap, at };
  const open = await db.prepare(
    `SELECT id, detail FROM media_proposals WHERE store = ? AND agent = ? AND status = 'open' AND kind = ? AND json_extract(detail, '$.ident') = ? LIMIT 1`
  ).bind(storeId, AGENT, c.kind, c.ident).first();
  if (open) {
    const d = JSON.parse(open.detail || "{}");
    await db.prepare(`UPDATE media_proposals SET title = ?, detail = ?, updated_at = ? WHERE id = ?`)
      .bind(titleFor(c, beText), JSON.stringify({ ...d, latest: now }), at, open.id).run();
    return false;
  }
  const detail = { ident: c.ident, campaign_id: c.campaign_id || null, name: c.name || null, from_id: c.from_id || null, to_id: c.to_id || null,
    breakeven: be.breakeven, breakeven_estimated: be.estimated, roas_basis: CAP_LABEL, call: now, latest: now };
  await db.prepare(
    `INSERT INTO media_proposals (store, agent, key, kind, title, detail, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
     ON CONFLICT(store, agent, key) DO UPDATE SET status = 'open', updated_at = excluded.updated_at`
  ).bind(storeId, AGENT, `${c.kind}:${c.ident}:${today}`, c.kind, titleFor(c, beText), JSON.stringify(detail), at, at).run();
  return true;
}

/** Open calls not made again this run: the condition changed, so the call is closed. */
async function closeUnseen(db, storeId, seen, at) {
  const { results } = await db.prepare(`SELECT id, kind, json_extract(detail, '$.ident') AS ident FROM media_proposals WHERE store = ? AND agent = ? AND status = 'open'`)
    .bind(storeId, AGENT).all();
  for (const r of results || []) {
    if (seen.has(`${r.kind}|${r.ident}`)) continue;
    await db.prepare(`UPDATE media_proposals SET status = 'closed', updated_at = ? WHERE id = ?`).bind(at, r.id).run();
  }
}

/** Score each cut/raise/hold call once, 7+ days after it was made. */
export async function scoreOldCalls(db, storeId, today, at = nowIso()) {
  const cutoff = minusDays(today, 8); // the 7 days after the call are closed days
  const { results } = await db.prepare(
    `SELECT id, kind, detail, substr(key, -10) AS day FROM media_proposals
     WHERE store = ? AND agent = ? AND outcome IS NULL AND kind IN ('budget_cut', 'budget_raise', 'budget_hold') AND substr(key, -10) <= ? LIMIT 50`
  ).bind(storeId, AGENT, cutoff).all();
  let n = 0;
  for (const p of results || []) {
    const d = JSON.parse(p.detail || "{}");
    const before = await campaignWindow(db, storeId, d.campaign_id, minusDays(p.day, 7), minusDays(p.day, 1));
    const after = await campaignWindow(db, storeId, d.campaign_id, minusDays(p.day, -1), minusDays(p.day, -7));
    const s = scoreCall(p.kind, before, after, d.breakeven);
    await db.prepare(`UPDATE media_proposals SET outcome = ?, outcome_data = ?, scored_at = ? WHERE id = ?`)
      .bind(s.outcome, JSON.stringify({ ...s, before, after, breakeven: d.breakeven, baseline: "spend left about the same (no change)" }), at, p.id).run();
    n += 1;
  }
  return n;
}

/** Track record for the page: n, distinct campaigns, outcomes per kind, and the caveat. */
export async function trackRecord(db) {
  const { results } = await db.prepare(
    `SELECT kind, outcome, COUNT(*) AS n, COUNT(DISTINCT store || ':' || json_extract(detail, '$.campaign_id')) AS campaigns
     FROM media_proposals WHERE agent = ? AND outcome IS NOT NULL GROUP BY kind, outcome`
  ).bind(AGENT).all();
  const distinct = await db.prepare(
    `SELECT COUNT(DISTINCT store || ':' || json_extract(detail, '$.campaign_id')) AS c, COUNT(*) AS n FROM media_proposals WHERE agent = ? AND outcome IS NOT NULL`
  ).bind(AGENT).first();
  const by = {};
  for (const r of results || []) {
    by[r.kind] = by[r.kind] || {};
    by[r.kind][r.outcome] = Number(r.n);
  }
  const count = (o) => (results || []).filter((r) => r.outcome === o).reduce((s, r) => s + Number(r.n), 0);
  return {
    label: "early / crude", note: TRACK_RECORD_NOTE,
    scored: Number((distinct && distinct.n) || 0), campaigns: Number((distinct && distinct.c) || 0),
    right: count("right"), wrong: count("wrong"), unclear: count("unclear"), guy_did_same: count("guy_did_same"), by_kind: by,
  };
}

export async function runBudget(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const summary = [];
  let total = 0; let opened = 0; let scored = 0;
  let today = null;
  for (const storeId of mediaStoreIds()) {
    const tz = (STORES[storeId] && STORES[storeId].timezone) || "America/New_York";
    today = localDay(nowMs, tz);
    scored += await scoreOldCalls(db, storeId, today, at);
    const to = minusDays(today, 1);
    const from = minusDays(to, BUDGET_DAYS - 1);
    const fresh = await db.prepare(`SELECT MAX(fetched_at) AS f FROM media_campaign_days WHERE store = ?`).bind(storeId).first();
    if (!fresh || !fresh.f || nowMs - Date.parse(fresh.f) > 8 * 3600000) { summary.push({ store: storeId, skipped: "Google campaign data missing or older than 8h" }); continue; }
    const be = await storeBreakeven(db, storeId, minusDays(to, 13), to);
    if (be.breakeven == null) { summary.push({ store: storeId, skipped: `break-even unknown (${be.reason})` }); continue; }
    const cap = await revenueCap(db, storeId, from, to);
    if (cap == null) { summary.push({ store: storeId, skipped: "no Shopify revenue for the window, so Google's numbers can't be capped; no calls" }); continue; }
    const calls = budgetCalls(await campaignTotals(db, storeId, from, to), { breakeven: be.breakeven, cap });
    const seen = new Set();
    for (const c of calls) {
      seen.add(`${c.kind}|${c.ident}`);
      if (await recordCall(db, storeId, c, { today, at, be, cap, window: { from, to } })) opened += 1;
    }
    await closeUnseen(db, storeId, seen, at);
    total += calls.length;
    summary.push({ store: storeId, breakeven: be.breakeven, breakeven_estimated: be.estimated, roas_basis: CAP_LABEL,
      calls: calls.filter((c) => c.kind !== "budget_hold").map((c) => ({ kind: c.kind, name: c.name || `${c.from} → ${c.to}`, amount: c.amount, roas: c.roas ?? null })) });
  }
  if (today && opened) {
    await dailyRead(env, {
      store: "all", agent: AGENT, day: today, label: "budget rationale", maxTokens: 260,
      system: "Write ONE short paragraph (max 90 words) explaining, for the store owner, the budget moves a shadow media system WOULD make today and why, using ONLY the numbers given. The ROAS is Google's claim capped at total store revenue (not verified ad sales); if break-even is estimated, say so. Make clear nothing was changed: the media buyer runs the accounts.",
      user: JSON.stringify(summary.map((s) => ({ ...s, store: storeName(s.store) }))),
    }, { fetchImpl, nowMs });
  }
  await logEvent(db, {
    actor: AGENT, kind: "media.proposed", target: "sys.ads", at,
    summary: `Budget calls (watch only): ${total} standing (${opened} new), not applied; Guy runs the accounts${scored ? `; ${scored} older calls scored (early, crude)` : ""}`,
    data: { stores: summary.map((s) => ({ store: s.store, calls: s.calls ? s.calls.length : 0, skipped: s.skipped || null })), opened, scored },
  });
  return `ok: ${total} standing calls (${opened} new), ${scored} scored`;
}
