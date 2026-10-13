/**
 * Analyst (pnl.analyst) — code computes, AI only words it. L2, shadow-safe (writes only the
 * ledger: pnl_analysis, events).
 *
 * What it does, once a day after the day close: for each live store and the group, from the
 * P&L ledger (pnl_days), CODE computes what moved profit
 *   - day over day: yesterday vs the day before;
 *   - week over week: the last 7 closed days vs the 7 before;
 * as deltas of revenue, refunds, COGS, ads, Guy's fee and Shopify fees (each with its effect
 * on profit), the biggest driver, ROAS against the refund-adjusted break-even, and caveats
 * (estimated COGS, incomplete days, missing inputs). A delta with an unknown side is null,
 * never computed from half the data (rule 4).
 * Rule 5, good news gets more scrutiny: when profit went UP, every caveat is listed first.
 * Then, optionally, ONE short AI paragraph per day (all stores in one call, capped tokens).
 * The paragraph is kept only if every $/%/ROAS figure in it is one the code computed
 * (brief.js unverifiedNumbers); otherwise it is rejected and the code figures stand alone.
 * Inputs: pnl_days. Outputs: pnl_analysis rows, `analyst.daily` event.
 */
import { LIVE_STORE_IDS, STORES } from "../../config/stores.js";
import { logEvent } from "../../lib/eventlog.js";
import { localDay, nowIso } from "../../lib/time.js";
import { minusDays } from "../../lib/adsSpend.js";
import { rowsBetween, sumRows, storeTz, breakevenRoas } from "../../lib/pnl.js";
import { askClaude } from "../../lib/ai.js";
import { briefWhitelist, unverifiedNumbers } from "../../lib/brief.js";
import { r2 } from "../core/shared.js";

const ACTOR = "pnl.analyst";
export const ANALYST_MAX_TOKENS = 400;

/** Each P&L line and its sign in profit. */
export const DRIVERS = Object.freeze([
  { key: "revenue", sign: +1, label: "revenue" },
  { key: "refunds", sign: -1, label: "refunds" },
  { key: "cogs", sign: -1, label: "COGS" },
  { key: "ads", sign: -1, label: "ad spend" },
  { key: "guy_fee", sign: -1, label: "Guy's fee" },
  { key: "fees", sign: -1, label: "Shopify fees" },
]);

/**
 * Pure: compare two periods (sums or single rows shaped like pnl_days / sumRows).
 * Returns the profit change, each driver's effect on profit, the biggest known driver, and caveats.
 */
export function explainChange(cur, prev) {
  if (!cur || !prev) return { profit_change: null, drivers: [], top_driver: null, caveats: ["no data for one of the periods"] };
  const drivers = DRIVERS.map((d) => {
    const a = cur[d.key], b = prev[d.key];
    const delta = a == null || b == null ? null : r2(a - b);
    return { key: d.key, label: d.label, now: a ?? null, before: b ?? null, delta, profit_effect: delta == null ? null : r2(d.sign * delta) };
  });
  const profitChange = cur.profit == null || prev.profit == null ? null : r2(cur.profit - prev.profit);
  const known = drivers.filter((d) => d.profit_effect != null && d.profit_effect !== 0);
  const top = known.sort((x, y) => Math.abs(y.profit_effect) - Math.abs(x.profit_effect))[0] || null;
  const caveats = [];
  const unknown = drivers.filter((d) => d.delta == null).map((d) => d.label);
  if (unknown.length) caveats.push(`unknown in one period: ${unknown.join(", ")}`);
  if (!cur.complete) caveats.push("the latest period is not complete");
  if (!prev.complete) caveats.push("the earlier period is not complete");
  if (cur.cogs_estimated_share != null && cur.cogs_estimated_share > 0) caveats.push(`COGS is ${Math.round(cur.cogs_estimated_share * 100)}% estimated`);
  if (cur.cogs_assumed) caveats.push("COGS uses the ASSUMED 33% rate");
  if (cur.refunds_pending) caveats.push(`$${Number(cur.refunds_pending).toFixed(2)} of refunds still PENDING`);
  const roas = cur.roas ?? null;
  const be = cur.breakeven_roas ?? breakevenRoas(cur.margin ?? null);
  return {
    profit_now: cur.profit ?? null, profit_before: prev.profit ?? null, profit_change: profitChange,
    // Profit up = good news: it gets the caveats up front (rule 5).
    direction: profitChange == null ? "unknown" : profitChange > 0 ? "up" : profitChange < 0 ? "down" : "flat",
    scrutiny: profitChange != null && profitChange > 0 && caveats.length ? "profit is up, but check: " + caveats.join("; ") : null,
    drivers, top_driver: top ? { key: top.key, label: top.label, profit_effect: top.profit_effect } : null,
    roas, breakeven_roas: be, roas_vs_breakeven: roas != null && be != null ? r2(roas - be) : null,
    above_breakeven: roas != null && be != null ? roas >= be : null,
    caveats,
  };
}

/** Code figures for one store (or the group) for the day just closed. */
export async function figuresFor(db, ids, yesterday) {
  const dayBefore = minusDays(yesterday, 1);
  const wFrom = minusDays(yesterday, 6), pwTo = minusDays(yesterday, 7), pwFrom = minusDays(yesterday, 13);
  const rowsAll = [];
  for (const id of ids) rowsAll.push(...(await rowsBetween(db, id, pwFrom, yesterday)));
  const pick = (from, to) => rowsAll.filter((r) => r.day >= from && r.day <= to);
  // A period is summed only when every store has every day in it; otherwise it's unknown.
  const period = (from, to) => {
    const rows = pick(from, to);
    let n = 0; for (let d = from; d <= to; d = minusDays(d, -1)) n++;
    if (rows.length !== n * ids.length) return null;
    return sumRows(rows, `${from}..${to}`);
  };
  return {
    day: yesterday,
    day_over_day: explainChange(period(yesterday, yesterday), period(dayBefore, dayBefore)),
    week_over_week: explainChange(period(wFrom, yesterday), period(pwFrom, pwTo)),
    periods: { day: yesterday, day_before: dayBefore, week: [wFrom, yesterday], week_before: [pwFrom, pwTo] },
  };
}

const SYSTEM = `You explain to Reilly, in one short paragraph per store, why profit moved, for his Shopify stores.
Use ONLY the figures in the JSON you are given; never compute, round differently or invent a number.
Plain, short, concise; name the biggest driver; say when profit is unknown and why; if profit is up, say the caveats first.
No headings, no bullet lists, max 120 words in total.`;

/** The AI paragraph, kept only when every number in it is in the figures. */
export async function wordFigures(env, figures, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const r = await askClaude(env, { system: SYSTEM, user: JSON.stringify(figures), maxTokens: ANALYST_MAX_TOKENS, actor: ACTOR, label: "Analyst daily words" }, { fetchImpl, nowMs });
  if (r.skipped) return { words: null, skipped: r.skipped };
  const bad = unverifiedNumbers(r.text, figures, briefWhitelist(figures));
  if (bad.length) return { words: null, rejected: bad, model: r.model };
  return { words: r.text.trim(), model: r.model };
}

/** The daily run: figures for every live store and the group, then (optionally) the words. */
export async function runAnalyst(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const yesterday = minusDays(localDay(nowMs, storeTz(LIVE_STORE_IDS[0])), 1);
  const all = {};
  for (const id of LIVE_STORE_IDS) all[id] = await figuresFor(db, [id], yesterday);
  all.all = await figuresFor(db, [...LIVE_STORE_IDS], yesterday);
  for (const [store, fig] of Object.entries(all)) {
    await db.prepare(
      `INSERT INTO pnl_analysis (store, day, figures, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(store, day) DO UPDATE SET figures = excluded.figures, updated_at = excluded.updated_at`
    ).bind(store, yesterday, JSON.stringify(fig), at, at).run();
  }
  let ai = { words: null, skipped: "AI words switched off (ANALYST_AI = 0)" };
  if (env.ANALYST_AI !== "0") {
    try { ai = await wordFigures(env, all, { nowMs, fetchImpl }); } catch (err) { ai = { words: null, error: String(err && err.message).slice(0, 200) }; }
    await db.prepare(`UPDATE pnl_analysis SET words = ?, words_model = ?, words_rejected = ? WHERE store = 'all' AND day = ?`)
      .bind(ai.words || null, ai.model || null, ai.rejected ? JSON.stringify(ai.rejected) : null, yesterday).run();
  }
  const line = LIVE_STORE_IDS.map((id) => {
    const d = all[id].day_over_day;
    return `${STORES[id].name} ${d.profit_change == null ? "profit change unknown" : `${d.profit_change >= 0 ? "+" : "−"}$${Math.abs(d.profit_change).toFixed(2)}`}${d.top_driver ? ` (mostly ${d.top_driver.label})` : ""}`;
  }).join("; ");
  await logEvent(db, {
    actor: ACTOR, kind: "analyst.daily", target: "core.briefer",
    summary: `Why profit moved on ${yesterday} vs the day before: ${line}${ai.rejected ? ` — AI wording rejected (${ai.rejected.length} unverified number${ai.rejected.length === 1 ? "" : "s"})` : ""}`,
    data: { day: yesterday, words: !!ai.words, rejected: ai.rejected || null, skipped: ai.skipped || ai.error || null }, at,
  });
  return { day: yesterday, stores: Object.keys(all).length, words: !!ai.words, rejected: ai.rejected || null, skipped: ai.skipped || ai.error || null };
}

export async function analystState(db) {
  const latest = await db.prepare(`SELECT day FROM pnl_analysis ORDER BY day DESC LIMIT 1`).first();
  if (!latest) return { day: null, note: "No analysis yet: runs daily after the day close." };
  const { results } = await db.prepare(`SELECT * FROM pnl_analysis WHERE day = ?`).bind(latest.day).all();
  const out = { day: latest.day, stores: {} };
  for (const r of results || []) {
    out.stores[r.store] = { figures: JSON.parse(r.figures), words: r.words, words_rejected: r.words_rejected ? JSON.parse(r.words_rejected) : null };
  }
  return out;
}

