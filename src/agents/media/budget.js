/**
 * media.budget — Budget Strategist. SHADOW / WATCH ONLY. No API calls.
 *
 * Does: once a day, for every watched store, works out (in code) what it WOULD do with
 *   budgets if it ran the accounts, and stores those calls as proposals — never applied
 *   (Guy runs the accounts; Reilly, 2026-10-11). Each day's calls are kept separately and,
 *   7 days later, scored against what actually happened. That score is the track record
 *   Reilly asked for before he can drop Guy ("we need more data").
 *   Rules (last 7 closed days, campaigns with at least MIN_CAMPAIGN_COST spend):
 *    - cut 20% when ROAS (Google value marked down to Shopify reality) < 0.8 × break-even,
 *    - raise 20% when ROAS ≥ 1.3 × break-even and the campaign is enabled,
 *    - a "move" line when a store has both: shift the cut amount to the best campaign.
 *   Break-even comes from the P&L (pnl_days margin), never invented.
 *   Claude writes ONE short paragraph of rationale a day for all stores (optional).
 * Scoring (crude on purpose, stated on the page): a cut was "right" if the campaign stayed
 *   under break-even in the 7 days after; a raise was "right" if it stayed at or above it.
 *   No data after → "unclear". Guy's own changes in that week can muddy it.
 * Inputs: media_campaign_days, pnl_days. Outputs: media_proposals (agent media.budget),
 *   media_reads (rationale), one media.proposed event per run.
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso, localDay } from "../../lib/time.js";
import { STORES } from "../../config/stores.js";
import { mediaStoreIds, minusDays, r2, storeBreakeven, realityFactor, upsertProposal, storeName, money, ratio } from "./common.js";
import { dailyRead } from "./reads.js";

export const AGENT = "media.budget";
export const BUDGET_DAYS = 7;
export const MIN_CAMPAIGN_COST = 50;
export const CUT_BELOW = 0.8;
export const RAISE_ABOVE = 1.3;
export const STEP = 0.2;

/** Pure: campaigns [{campaign_id, name, status, cost, value, days}] → proposals. */
export function budgetCalls(campaigns, { breakeven, factor = 1, minCost = MIN_CAMPAIGN_COST }) {
  if (breakeven == null) return [];
  const f = factor == null ? 1 : factor;
  const calls = [];
  for (const c of campaigns) {
    if (c.cost < minCost) continue;
    const roas = (c.value * f) / c.cost;
    const daily = c.cost / Math.max(1, c.days);
    if (roas < breakeven * CUT_BELOW) {
      calls.push({ kind: "budget_cut", campaign_id: c.campaign_id, name: c.name, roas: r2(roas), daily: r2(daily), amount: r2(daily * STEP) });
    } else if (roas >= breakeven * RAISE_ABOVE && (!c.status || c.status === "ENABLED")) {
      calls.push({ kind: "budget_raise", campaign_id: c.campaign_id, name: c.name, roas: r2(roas), daily: r2(daily), amount: r2(daily * STEP) });
    }
  }
  const cuts = calls.filter((c) => c.kind === "budget_cut").sort((a, b) => a.roas - b.roas);
  const raises = calls.filter((c) => c.kind === "budget_raise").sort((a, b) => b.roas - a.roas);
  if (cuts.length && raises.length) {
    calls.push({ kind: "budget_move", from_id: cuts[0].campaign_id, from: cuts[0].name, to_id: raises[0].campaign_id, to: raises[0].name,
      amount: cuts[0].amount, from_roas: cuts[0].roas, to_roas: raises[0].roas });
  }
  return calls;
}

/** Pure: was a call right, given the campaign's ROAS in the 7 days after? */
export function scoreCall(kind, after, breakeven) {
  if (!after || after.roas == null || breakeven == null) return "unclear";
  if (kind === "budget_cut") return after.roas < breakeven ? "right" : "wrong";
  if (kind === "budget_raise") return after.roas >= breakeven ? "right" : "wrong";
  if (kind === "budget_move") return after.roas >= breakeven ? "right" : "wrong"; // judged on the receiving campaign
  return "unclear";
}

async function campaignTotals(db, storeId, from, to) {
  const { results } = await db.prepare(
    `SELECT campaign_id, MAX(campaign_name) AS name, MAX(status) AS status, COUNT(*) AS days, SUM(cost) AS cost, SUM(conv_value) AS value
     FROM media_campaign_days WHERE store = ? AND day >= ? AND day <= ? GROUP BY campaign_id`
  ).bind(storeId, from, to).all();
  return (results || []).map((r) => ({ campaign_id: String(r.campaign_id), name: r.name || String(r.campaign_id), status: r.status,
    days: Number(r.days), cost: r2(r.cost), value: r2(r.value) }));
}

/** Score open calls that are 7+ days old. */
export async function scoreOldCalls(db, storeId, today, at = nowIso()) {
  const cutoff = minusDays(today, 8);
  const { results } = await db.prepare(
    `SELECT id, kind, detail, substr(key, 1, 10) AS day FROM media_proposals WHERE store = ? AND agent = ? AND outcome IS NULL AND substr(key, 1, 10) <= ? LIMIT 50`
  ).bind(storeId, AGENT, cutoff).all();
  let n = 0;
  for (const p of results || []) {
    const d = JSON.parse(p.detail || "{}");
    const cid = p.kind === "budget_move" ? d.to_id : d.campaign_id;
    const from = minusDays(p.day, -1); const to = minusDays(p.day, -7);
    const r = await db.prepare(`SELECT COUNT(*) AS n, SUM(cost) AS cost, SUM(conv_value) AS value FROM media_campaign_days WHERE store = ? AND campaign_id = ? AND day >= ? AND day <= ?`)
      .bind(storeId, String(cid), from, to).first();
    const factor = await realityFactor(db, storeId, from, to);
    const after = r && Number(r.n) && Number(r.cost) > 0 ? { roas: r2((Number(r.value) * (factor == null ? 1 : factor)) / Number(r.cost)), cost: r2(r.cost) } : null;
    const outcome = scoreCall(p.kind, after, d.breakeven);
    await db.prepare(`UPDATE media_proposals SET outcome = ?, outcome_data = ?, scored_at = ?, status = 'scored' WHERE id = ?`)
      .bind(outcome, JSON.stringify({ after, window: { from, to }, breakeven: d.breakeven }), at, p.id).run();
    n += 1;
  }
  return n;
}

export async function runBudget(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const summary = [];
  let total = 0; let scored = 0;
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
    const factor = await realityFactor(db, storeId, from, to);
    const camps = await campaignTotals(db, storeId, from, to);
    const calls = budgetCalls(camps, { breakeven: be.breakeven, factor });
    for (const c of calls) {
      const key = `${today}:${c.kind}:${c.campaign_id || `${c.from_id}>${c.to_id}`}`;
      const title = c.kind === "budget_cut" ? `Would cut "${c.name}" by ${money(c.amount)}/day (ROAS ${ratio(c.roas)} vs break-even ${ratio(be.breakeven)})`
        : c.kind === "budget_raise" ? `Would raise "${c.name}" by ${money(c.amount)}/day (ROAS ${ratio(c.roas)} vs break-even ${ratio(be.breakeven)})`
        : `Would move ${money(c.amount)}/day from "${c.from}" (${ratio(c.from_roas)}) to "${c.to}" (${ratio(c.to_roas)})`;
      await upsertProposal(db, { store: storeId, agent: AGENT, key, kind: c.kind, title, at,
        detail: { ...c, breakeven: be.breakeven, breakeven_estimated: be.estimated, reality_factor: factor, window: { from, to } } });
    }
    total += calls.length;
    summary.push({ store: storeId, breakeven: be.breakeven, reality_factor: factor, calls: calls.map((c) => ({ kind: c.kind, name: c.name || `${c.from} → ${c.to}`, amount: c.amount, roas: c.roas ?? null })) });
  }
  if (today && total) {
    await dailyRead(env, {
      store: "all", agent: AGENT, day: today, label: "budget rationale", maxTokens: 260,
      system: "Write ONE short paragraph (max 90 words) explaining, for the store owner, the budget moves a shadow media system WOULD make today and why, using ONLY the numbers given. Make clear nothing was changed: the media buyer runs the accounts.",
      user: JSON.stringify(summary.map((s) => ({ ...s, store: storeName(s.store) }))),
    }, { fetchImpl, nowMs });
  }
  await logEvent(db, {
    actor: AGENT, kind: "media.proposed", target: "sys.ads", at,
    summary: `Budget calls logged in shadow: ${total} (not applied; Guy runs the accounts)${scored ? `; ${scored} older calls scored` : ""}`,
    data: { stores: summary.map((s) => ({ store: s.store, calls: s.calls ? s.calls.length : 0, skipped: s.skipped || null })), scored },
  });
  return `ok: ${total} calls, ${scored} scored`;
}
