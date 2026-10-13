import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";
import { encryptToken, _resetGoogleCacheForTests } from "../src/lib/google.js";
import { minusDays } from "../src/lib/adsSpend.js";

import { runMedia, mediaState, STORE_AGENTS } from "../src/agents/media/index.js";
import { AdsSession, storeBreakeven, revenueCap, mediaStoreIds, runBatched, breakevenLabel } from "../src/agents/media/common.js";
import { parseCampaignRows, underStreak } from "../src/agents/media/performance.js";
import { parseTermRows, wastedTerms } from "../src/agents/media/searchTerms.js";
import { productIdFromItem, judgeProduct, parseProductRows } from "../src/agents/media/products.js";
import { mondayOf, weekTrends, parseKeywordRows } from "../src/agents/media/season.js";
import { describeChange } from "../src/agents/media/guyMonitor.js";
import { compareDays, runConversions } from "../src/agents/media/conversions.js";
import { budgetCalls, scoreCall, runBudget, trackRecord } from "../src/agents/media/budget.js";
import { runPerformance } from "../src/agents/media/performance.js";
import { runSearchTerms } from "../src/agents/media/searchTerms.js";

/* ---------------- fixtures ---------------- */

const NOW = Date.parse("2026-10-13T16:00:00Z"); // noon Eastern
const TODAY = "2026-10-13";
const YDAY = "2026-10-12";
const CID = { "7108143649": "hc", "1481872496": "aub", "7742202674": "mar" };
const j = (b, s = 200) => new Response(JSON.stringify(b), { status: s });

const GENV = (DB, extra = {}) => ({
  DB, GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "GOCSPX-secret",
  APPROVAL_SIGNING_KEY: "k".repeat(48), ...extra,
});

async function connectGoogle(env) {
  const { enc_token, iv } = await encryptToken(env, "1//refresh-xyz");
  await env.DB.prepare(
    `INSERT INTO oauth_tokens (provider, account, scopes, enc_token, iv, created_at) VALUES ('google', 'reillyworking26@gmail.com', 'adwords', ?, ?, '2026-10-01T00:00:00Z')`
  ).bind(enc_token, iv).run();
}

/** Seed the account timezone the spend puller would have stored (so no extra call per store). */
async function seedTz(DB) {
  for (const s of ["hc", "aub", "mar"]) {
    await DB.prepare(`INSERT INTO ad_spend_days (store, day, cost, clicks, impressions, conv_value, currency, account_tz, fetched_at) VALUES (?, ?, 0, 0, 0, 0, 'USD', 'America/New_York', ?)`)
      .bind(s, YDAY, "2026-10-13T15:00:00Z").run();
  }
}

/** P&L rows: revenue + COGS (margin 60% → break-even ≈ 2.02), orders. */
async function seedPnl(DB, store, { days = 14, revenue = 500, cogs = 200, orders = 5 } = {}) {
  for (let i = 1; i <= days; i++) {
    const day = minusDays(TODAY, i);
    await DB.prepare(`INSERT INTO pnl_days (store, day, revenue, cogs, cogs_estimated_share, orders, status, updated_at) VALUES (?, ?, ?, ?, 1, ?, 'closed', ?)`)
      .bind(store, day, revenue, cogs, orders, "2026-10-13T00:00:00Z").run();
  }
}

const campRow = (date, id, name, costUsd, value, conv = 1, status = "ENABLED") => ({
  segments: { date }, campaign: { id, name, status, advertisingChannelType: "SEARCH" },
  metrics: { costMicros: String(Math.round(costUsd * 1e6)), clicks: "10", impressions: "100", conversions: conv, conversionsValue: value },
});

/** Fake Google: token refresh + Ads searchStream routed by the FROM clause. */
function fakeGoogle(handlers = {}, { claude = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return j({ access_token: "ya29.SECRET-ACCESS", expires_in: 3600 });
    if (/anthropic\.com/.test(url)) {
      if (!claude) throw new Error("unexpected Claude call");
      return j({ model: "claude-sonnet-4-5", content: [{ type: "text", text: claude(JSON.parse(init.body)) }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: "end_turn" });
    }
    const m = url.match(/^https:\/\/googleads\.googleapis\.com\/(v\d+)\/customers\/(\d+)\/googleAds:searchStream$/);
    if (!m) throw new Error("unexpected " + url);
    const q = JSON.parse(init.body).query;
    const from = (q.match(/FROM\s+(\w+)/) || [])[1];
    const h = handlers[from];
    if (typeof h === "function") return h(CID[m[2]], q);
    return j([{ results: [] }]);
  };
  const adsCalls = () => calls.filter((c) => c.url.includes("googleads"));
  return { fetchImpl, calls, adsCalls };
}

const evs = async (DB, kind) => (await DB.prepare(`SELECT * FROM events WHERE kind = ? ORDER BY id`).bind(kind).all()).results;

async function setup() {
  _resetGoogleCacheForTests();
  const DB = makeD1();
  const env = GENV(DB);
  return { DB, env };
}

/* ---------------- pure logic ---------------- */

test("media: campaign rows are summed per day+campaign, micros → dollars", () => {
  const rows = parseCampaignRows([
    campRow("2026-10-10", "1", "A", 10, 30), campRow("2026-10-10", "1", "A", 5, 0, 0), campRow("2026-09-01", "1", "A", 99, 0),
  ], { from: "2026-10-01", to: TODAY });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cost, 15);
  assert.equal(rows[0].conv_value, 30);
});

test("media: under-break-even streak counts recent days in a row, skips tiny days, uses the reality factor", () => {
  const days = [
    { day: "2026-10-12", cost: 20, conv_value: 20 },  // 1.0x
    { day: "2026-10-11", cost: 2, conv_value: 0 },    // too small: ignored
    { day: "2026-10-10", cost: 20, conv_value: 30 },  // 1.5x
    { day: "2026-10-09", cost: 20, conv_value: 100 }, // 5x: breaks the streak
    { day: "2026-10-08", cost: 20, conv_value: 0 },
  ];
  assert.equal(underStreak(days, 2).streak, 2);
  // Google says 5x on the 9th, but Shopify reality is a third of it → 1.67x, under 2.
  assert.equal(underStreak(days, 2, 1 / 3).streak, 4);
});

test("media: break-even comes from the P&L and ignores days with unknown COGS (never treats them as free)", async () => {
  const { DB } = await setup();
  await seedPnl(DB, "hc", { days: 3 });
  await DB.prepare(`INSERT INTO pnl_days (store, day, revenue, cogs, status, updated_at) VALUES ('hc', '2026-10-09', 1000, NULL, 'partial', 'x')`).run();
  const be = await storeBreakeven(DB, "hc", "2026-10-01", YDAY);
  assert.equal(be.days, 3);
  assert.equal(be.margin, 0.6);
  assert.equal(be.breakeven, 2.02); // 1 / (0.6 × 0.881 − 0.0334)
  const none = await storeBreakeven(DB, "aub", "2026-10-01", YDAY);
  assert.equal(none.breakeven, null);
});

test("media: revenue cap marks Google DOWN to total store revenue, never up", async () => {
  const { DB } = await setup();
  await seedPnl(DB, "hc", { days: 2, revenue: 100 });
  const ins = (day, v) => DB.prepare(`INSERT INTO media_campaign_days (store, day, campaign_id, cost, clicks, impressions, conversions, conv_value, fetched_at) VALUES ('hc', ?, '1', 10, 1, 1, 1, ?, 'x')`).bind(day, v).run();
  await ins(YDAY, 400); await ins("2026-10-11", 400);
  assert.equal(await revenueCap(DB, "hc", "2026-10-11", YDAY), 0.25);
  await DB.prepare(`UPDATE media_campaign_days SET conv_value = 10`).run();
  assert.equal(await revenueCap(DB, "hc", "2026-10-11", YDAY), 1); // Shopify 200 > Google 20: capped at 1
});

test("media: wasted terms need spend over the threshold, zero conversions, and not already excluded", () => {
  const terms = parseTermRows([
    { searchTermView: { searchTerm: "Free Coat Pattern", status: "NONE" }, campaign: { id: "1", name: "S" }, metrics: { costMicros: "20000000", conversions: 0 } },
    { searchTermView: { searchTerm: "wool coat", status: "ADDED" }, campaign: { id: "1", name: "S" }, metrics: { costMicros: "50000000", conversions: 2 } },
    { searchTermView: { searchTerm: "old excluded", status: "EXCLUDED" }, campaign: { id: "1" }, metrics: { costMicros: "90000000", conversions: 0 } },
    { searchTermView: { searchTerm: "cheap", status: "NONE" }, campaign: { id: "1" }, metrics: { costMicros: "3000000", conversions: 0 } },
  ]);
  const w = wastedTerms(terms, 15);
  assert.deepEqual(w.map((t) => t.term), ["free coat pattern"]);
});

test("media: products — item ids map to Shopify ids; burners and losers judged against break-even", () => {
  assert.equal(productIdFromItem("shopify_US_8123_4456"), "8123");
  assert.equal(productIdFromItem("custom-sku-1"), null);
  const p = parseProductRows([{ segments: { productItemId: "shopify_US_1_2", productTitle: "Coat" }, metrics: { costMicros: "30000000", conversions: 0, conversionsValue: 0 } }])[0];
  assert.equal(judgeProduct(p, { breakeven: 2, factor: 1, minUsd: 20, real: { units: 0, revenue: 0 } }).severity, "bad");
  assert.equal(judgeProduct(p, { breakeven: 2, factor: 1, minUsd: 20, real: null }).severity, "warn"); // Shopify unknown ≠ 0 sold
  const seller = { ...p, conversions: 1, conv_value: 45 };
  assert.equal(judgeProduct(seller, { breakeven: 2, factor: 1, minUsd: 20, real: { units: 1, revenue: 45 } }).kind, "losing");
  assert.equal(judgeProduct(seller, { breakeven: 2, factor: 1, minUsd: 20, real: { units: 1, revenue: 45 } }).severity, "bad");
  assert.equal(judgeProduct({ ...seller, conv_value: 90 }, { breakeven: 2, factor: 1, minUsd: 20, real: null }), null);
  assert.equal(judgeProduct({ ...p, cost: 5 }, { breakeven: 2, factor: 1, minUsd: 20, real: null }), null);
});

test("media: season — weeks are Monday-based; rising and falling need 30% on 100+ impressions", () => {
  assert.equal(mondayOf("2026-10-13"), "2026-10-12");
  assert.equal(mondayOf("2026-10-18"), "2026-10-12");
  const rows = parseKeywordRows([
    { adGroupCriterion: { keyword: { text: "Wool Coat" } }, segments: { week: "2026-09-28" }, metrics: { impressions: "1000" } },
    { adGroupCriterion: { keyword: { text: "wool coat" } }, segments: { week: "2026-10-05" }, metrics: { impressions: "1500" } },
    { adGroupCriterion: { keyword: { text: "linen" } }, segments: { week: "2026-09-28" }, metrics: { impressions: "800" } },
    { adGroupCriterion: { keyword: { text: "linen" } }, segments: { week: "2026-10-05" }, metrics: { impressions: "300" } },
    { adGroupCriterion: { keyword: { text: "tiny" } }, segments: { week: "2026-10-05" }, metrics: { impressions: "60" } },
  ]);
  const t = weekTrends(rows, "2026-10-05", "2026-09-28");
  assert.deepEqual(t.map((x) => [x.keyword, x.dir]), [["wool coat", "rising"], ["linen", "falling"]]);
});

test("media: a change event is described with who, what and old → new (micros as money)", () => {
  const c = describeChange({ changeEvent: {
    resourceName: "customers/1/changeEvents/abc", changeDateTime: "2026-10-10 09:12:00.000", userEmail: "guy@agency.com",
    changeResourceType: "CAMPAIGN_BUDGET", resourceChangeOperation: "UPDATE", changedFields: "amountMicros", campaign: "customers/1/campaigns/55",
    oldResource: { campaignBudget: { amountMicros: "50000000" } }, newResource: { campaignBudget: { amountMicros: "80000000" } },
  } }, new Map([["55", "Shopping - Coats"]]));
  assert.equal(c.campaign_id, "55");
  assert.match(c.summary, /guy@agency\.com: update campaign budget in "Shopping - Coats": amountMicros \$50\.00 → \$80\.00/);
});

test("media: conversion check — overclaim and broken tracking", () => {
  const days = ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"];
  const shop = days.map((day) => ({ day, orders: 5, revenue: 500 }));
  const over = compareDays(days.map((day) => ({ day, conversions: 9, conv_value: 900, cost: 100 })), shop);
  assert.deepEqual(over.flags.map((f) => f.key), ["overclaim_value", "overclaim_orders"]);
  const broken = compareDays(days.map((day, i) => ({ day, conversions: i < 4 ? 3 : 0, conv_value: i < 4 ? 200 : 0, cost: 100 })), shop);
  assert.deepEqual(broken.flags.map((f) => f.key), ["tracking_broken"]);
  const fine = compareDays(days.map((day) => ({ day, conversions: 3, conv_value: 300, cost: 100 })), shop);
  assert.equal(fine.flags.length, 0);
});

test("media: budget calls — enabled campaigns only, cut/raise/hold, a move when both, none without the revenue cap", () => {
  const camps = [
    { campaign_id: "1", name: "Bad", status: "ENABLED", cost: 140, value: 140, days: 7 },     // 1.0x
    { campaign_id: "2", name: "Good", status: "ENABLED", cost: 140, value: 560, days: 7 },    // 4.0x
    { campaign_id: "3", name: "Small", status: "ENABLED", cost: 10, value: 0, days: 7 },
    { campaign_id: "4", name: "Paused bad", status: "PAUSED", cost: 140, value: 0, days: 7 },
    { campaign_id: "5", name: "Removed", status: "REMOVED", cost: 140, value: 0, days: 7 },
    { campaign_id: "6", name: "Okay", status: "ENABLED", cost: 140, value: 280, days: 7 },    // 2.0x: hold
  ];
  const calls = budgetCalls(camps, { breakeven: 2, cap: 1 });
  assert.deepEqual(calls.map((c) => c.kind), ["budget_cut", "budget_raise", "budget_hold", "budget_move"]);
  assert.equal(calls[0].amount, 4); // 20% of $20/day
  assert.ok(!calls.some((c) => c.campaign_id === "4" || c.campaign_id === "5"));
  assert.deepEqual(budgetCalls(camps, { breakeven: null, cap: 1 }), []);
  assert.deepEqual(budgetCalls(camps, { breakeven: 2, cap: null }), []); // never fall back to raw Google numbers
});

test("media: budget scoring is against a no-change baseline; Guy doing the same isn't counted; moves aren't scored", () => {
  const before = { daily: 20, roas: 1.0 };
  assert.equal(scoreCall("budget_cut", before, { daily: 20, roas: 1.1 }, 2).outcome, "right");    // left alone, still losing
  assert.equal(scoreCall("budget_cut", before, { daily: 21, roas: 2.5 }, 2).outcome, "wrong");    // left alone, recovered
  assert.equal(scoreCall("budget_cut", before, { daily: 10, roas: 1.5 }, 2).outcome, "guy_did_same");
  assert.equal(scoreCall("budget_raise", { daily: 20, roas: 3 }, { daily: 20, roas: 1.2 }, 2).outcome, "wrong");
  assert.equal(scoreCall("budget_hold", { daily: 20, roas: 2 }, { daily: 20, roas: 1.8 }, 2).outcome, "right");
  assert.equal(scoreCall("budget_hold", { daily: 20, roas: 2 }, { daily: 40, roas: 1.8 }, 2).outcome, "unclear");
  assert.equal(scoreCall("budget_cut", before, null, 2).outcome, "unclear");
  assert.equal(scoreCall("budget_move", before, { daily: 20, roas: 1 }, 2).outcome, "not_scored");
});

test("media: one open budget call per campaign across days, scored once, track record counts distinct campaigns", async () => {
  const { DB, env } = await setup();
  await seedPnl(DB, "hc", { days: 30 });
  // 30 days of a steady 1.0x campaign (break-even 2.02): a standing "cut".
  for (let i = 1; i <= 30; i++) {
    await DB.prepare(`INSERT INTO media_campaign_days (store, day, campaign_id, campaign_name, status, cost, clicks, impressions, conversions, conv_value, fetched_at) VALUES ('hc', ?, '9', 'Steady', 'ENABLED', 20, 1, 1, 1, 20, 'x')`)
      .bind(minusDays(TODAY, i)).run();
  }
  const noNet = async () => { throw new Error("no network"); };
  const fresh = (t) => DB.prepare(`UPDATE media_campaign_days SET fetched_at = ?`).bind(new Date(t - 3600000).toISOString()).run();
  for (let d = 0; d < 10; d++) {
    const t = NOW - (9 - d) * 86400000;
    await fresh(t);
    await runBudget(env, { nowMs: t, fetchImpl: noNet });
  }
  const calls = (await DB.prepare(`SELECT kind, status, outcome FROM media_proposals WHERE agent = 'media.budget' AND store = 'hc'`).all()).results;
  assert.equal(calls.length, 1); // ten daily runs, still one call
  assert.equal(calls[0].kind, "budget_cut");
  assert.equal(calls[0].status, "open");
  assert.equal(calls[0].outcome, "right"); // scored once (opened 9 days ago): spend unchanged, still under
  const tr = await trackRecord(DB);
  assert.equal(tr.scored, 1);
  assert.equal(tr.campaigns, 1);
  assert.equal(tr.label, "early / crude");
  assert.match(tr.note, /persistence/);
  // Titles say what the ROAS is and that the break-even rests on estimated COGS.
  const t = await DB.prepare(`SELECT title FROM media_proposals WHERE agent = 'media.budget'`).first();
  assert.match(t.title, /capped at total store revenue/);
  assert.match(t.title, /estimated: COGS estimated/);
  // The campaign is paused: the call closes and no new one opens.
  await DB.prepare(`INSERT INTO media_campaign_days (store, day, campaign_id, campaign_name, status, cost, clicks, impressions, conversions, conv_value, fetched_at) VALUES ('hc', ?, '9', 'Steady', 'PAUSED', 0, 0, 0, 0, 0, 'x')`).bind(TODAY).run();
  await fresh(NOW + 86400000);
  await runBudget(env, { nowMs: NOW + 86400000, fetchImpl: noNet });
  const after = (await DB.prepare(`SELECT status FROM media_proposals WHERE agent = 'media.budget'`).all()).results;
  assert.deepEqual(after.map((r) => r.status), ["closed"]);
});

/* ---------------- the cron: wiring, safety, throttling ---------------- */

test("media: Google not connected → no Ads calls, no numbers, one not-wired event a day", async () => {
  const { DB, env } = await setup();
  const g = fakeGoogle();
  const r = await runMedia(env, { nowMs: NOW, fetchImpl: g.fetchImpl });
  assert.equal(g.calls.length, 0);
  assert.match(r["media.performance.hc"], /not wired/);
  assert.match(r["media.guy_monitor.hc"], /not wired/);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM media_campaign_days`).first()).n, 0);
  assert.equal((await evs(DB, "media.not_wired")).length, 1);
  await runMedia(env, { nowMs: NOW + 40 * 60000, fetchImpl: g.fetchImpl });
  assert.equal((await evs(DB, "media.not_wired")).length, 1);
  const st = await mediaState(env, { nowMs: NOW });
  assert.equal(st.google.connected, false);
  const hc = st.stores.find((s) => s.store === "hc");
  assert.equal(hc.spend, null); // unknown, never 0
  assert.equal(st.stores.find((s) => s.store === "tund").reason, "store not live");
});

test("media: only stores that are live with an Ads id are watched", () => {
  assert.deepEqual(mediaStoreIds(), ["hc", "aub", "mar"]);
});

test("media: a full day of ticks — every agent runs, ≤ 6 Ads calls per tick, only SELECTs to searchStream, no approvals", async () => {
  const { DB, env } = await setup();
  await connectGoogle(env);
  await seedTz(DB);
  for (const s of ["hc", "aub", "mar"]) await seedPnl(DB, s);
  const days = Array.from({ length: 13 }, (_, i) => minusDays(YDAY, i));
  const g = fakeGoogle({
    // Campaign "Bleeder" returns 1.0x every day (break-even ≈ 2.02): flagged. "Winner" 4x.
    campaign: (store) => j([{ results: days.flatMap((d) => [campRow(d, "11", "Bleeder", 20, 20), campRow(d, "22", "Winner", 20, 80)]) }]),
    search_term_view: () => j([{ results: [
      { searchTermView: { searchTerm: "free coat pattern", status: "NONE" }, campaign: { id: "11", name: "Bleeder" }, metrics: { costMicros: "25000000", clicks: "9", conversions: 0 } },
    ] }]),
    change_event: () => j([{ results: [{ changeEvent: {
      resourceName: "customers/1/changeEvents/1", changeDateTime: "2026-10-12 10:00:00", userEmail: "guy@agency.com",
      changeResourceType: "CAMPAIGN", resourceChangeOperation: "UPDATE", changedFields: "status", campaign: "customers/1/campaigns/11",
      oldResource: { campaign: { status: "ENABLED" } }, newResource: { campaign: { status: "PAUSED" } } } }] }]),
  });
  let maxPerTick = 0;
  for (let t = 0; t < 6; t++) {
    const before = g.adsCalls().length;
    await runMedia(env, { nowMs: NOW + t * 60 * 60000, fetchImpl: g.fetchImpl }); // Media gets one rotation slot an hour
    maxPerTick = Math.max(maxPerTick, g.adsCalls().length - before);
  }
  assert.ok(maxPerTick <= 6, `max Ads calls per tick ${maxPerTick}`);
  // 3 stores × 5 Ads agents = 15 calls in the first hours, then performance comes due again
  // at 4 hours (+3): every job ran within 6 hourly runs.
  assert.equal(g.adsCalls().length, 18);
  for (const c of g.adsCalls()) {
    assert.match(c.url, /googleAds:searchStream$/);
    assert.match(JSON.parse(c.init.body).query, /^\s*SELECT\s/);
  }
  // Every job ran.
  for (const a of STORE_AGENTS) for (const s of ["hc", "aub", "mar"]) {
    const row = await DB.prepare(`SELECT last_result FROM job_runs WHERE job = ?`).bind(`${a.agent}.${s}`).first();
    assert.match(String(row && row.last_result), /^ok|^can't check/, `${a.agent}.${s}: ${row && row.last_result}`);
  }
  // Performance: stored and flagged.
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM media_campaign_days WHERE store = 'hc'`).first()).n, 26);
  const flag = await DB.prepare(`SELECT * FROM media_findings WHERE store = 'hc' AND agent = 'media.performance' AND cleared_at IS NULL`).all();
  assert.deepEqual(flag.results.map((f) => f.key), ["campaign:11"]);
  // Search terms: proposal stored, not applied; one digest per store.
  const props = (await DB.prepare(`SELECT * FROM media_proposals WHERE agent = 'media.search_terms' AND store = 'hc'`).all()).results;
  assert.equal(props.length, 1);
  assert.equal(props[0].status, "open");
  assert.equal((await evs(DB, "media.search_terms.digest")).length, 3);
  // Guy monitor: one event per change.
  assert.equal((await evs(DB, "media.change")).length, 3);
  // Budget ran in shadow and proposed (Bleeder cut, Winner raise, a move).
  const bud = (await DB.prepare(`SELECT kind FROM media_proposals WHERE agent = 'media.budget' AND store = 'hc' ORDER BY kind`).all()).results.map((r) => r.kind);
  assert.deepEqual(bud, ["budget_cut", "budget_move", "budget_raise"]);
  // Conversions checked: Google claims 1300/7d? (Google 100/day vs Shopify 500/day) → ok.
  const chk = await DB.prepare(`SELECT data FROM media_findings WHERE store = 'hc' AND agent = 'media.conversions' AND key = 'check'`).first();
  assert.equal(JSON.parse(chk.data).status, "ok");
  // Watch only: nothing for Reilly to approve, no AI without a key.
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM approvals`).first()).n, 0);
  assert.equal(g.calls.filter((c) => /anthropic/.test(c.url)).length, 0);

  const st = await mediaState(env, { nowMs: NOW + 2 * 3600000 });
  const hc = st.stores.find((s) => s.store === "hc");
  assert.equal(hc.spend, 520);
  assert.equal(hc.breakeven, 2.02);
  assert.equal(hc.flagged_campaigns.length, 1);
  assert.equal(hc.wasted_terms.length, 1);
  assert.equal(hc.guy_changes.length, 1);
  assert.equal(hc.conversions.status, "ok");
  assert.ok(hc.budget_calls.length >= 3);
  assert.equal(hc.reads.performance.status, "skipped"); // no key: waiting on AI
  // A second run of the same day doesn't re-log the change.
  await DB.prepare(`UPDATE job_runs SET last_run_at = '2026-01-01T00:00:00Z' WHERE job LIKE 'media.guy_monitor.%'`).run();
  await runMedia(env, { nowMs: NOW + 3 * 3600000, fetchImpl: g.fetchImpl });
  assert.equal((await evs(DB, "media.change")).length, 3);
});

test("media: an Ads error → error event (once an hour), no rows written, retried in 30 minutes", async () => {
  const { DB, env } = await setup();
  await connectGoogle(env);
  await seedTz(DB);
  const g = fakeGoogle({
    campaign: () => j({ error: { code: 403, status: "PERMISSION_DENIED", message: "User doesn't have permission. Bearer ya29.LEAK" } }, 403),
  });
  const r = await runMedia(env, { nowMs: NOW, fetchImpl: g.fetchImpl });
  assert.match(r["media.performance.hc"], /^error/);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM media_campaign_days`).first()).n, 0);
  const errs = await evs(DB, "error.media");
  assert.ok(errs.length >= 1);
  assert.ok(!errs.some((e) => /ya29\.LEAK|SECRET-ACCESS/.test(e.summary)));
  const n = (await evs(DB, "error.media")).length;
  // 15 minutes later: not due yet (retry in 30); 30 minutes later: retried, but no second event within the hour.
  const r2 = await runMedia(env, { nowMs: NOW + 15 * 60000, fetchImpl: g.fetchImpl });
  assert.equal(r2["media.performance.hc"], "not due");
  const r3 = await runMedia(env, { nowMs: NOW + 31 * 60000, fetchImpl: g.fetchImpl });
  assert.match(r3["media.performance.hc"], /^error/);
  const hcErrs = (await evs(DB, "error.media")).filter((e) => e.store === "hc" && e.actor === "media.performance");
  assert.equal(hcErrs.length, 1);
  assert.ok((await evs(DB, "error.media")).length >= n);
  // State: spend unknown, not zero.
  const st = await mediaState(env, { nowMs: NOW });
  assert.equal(st.stores.find((s) => s.store === "hc").spend, null);
});

test("media: a failed Google sign-in is tried once per tick, logged once, and nothing is written", async () => {
  const { DB, env } = await setup();
  await connectGoogle(env);
  await seedTz(DB);
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) { tokenCalls += 1; return j({ error: "invalid_grant" }, 400); }
    throw new Error("unexpected " + url);
  };
  const r = await runMedia(env, { nowMs: NOW, fetchImpl });
  assert.equal(tokenCalls, 1);
  assert.match(r["media.performance.hc"], /^error/);
  assert.match(r["media.performance.aub"], /sign-in failed/);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM media_campaign_days`).first()).n, 0);
});

test("media: the session refuses anything but SELECT and stops at its call cap", async () => {
  const { DB, env } = await setup();
  await connectGoogle(env);
  const g = fakeGoogle();
  const s = new AdsSession(env, { fetchImpl: g.fetchImpl, nowMs: NOW, maxCalls: 1 });
  await assert.rejects(() => s.query("hc", "MUTATE campaign_budget SET amount = 1"), /only SELECT/);
  await s.query("hc", "SELECT campaign.id FROM campaign");
  await assert.rejects(() => s.query("hc", "SELECT campaign.id FROM campaign"), /call budget/);
});

test("media: conversions can't check without fresh Google data, and flags broken tracking when it can", async () => {
  const { DB, env } = await setup();
  await seedPnl(DB, "hc", { days: 8 });
  const none = await runConversions(env, { storeId: "hc", nowMs: NOW });
  assert.match(none, /can't check/);
  for (let i = 1; i <= 8; i++) {
    const day = minusDays(TODAY, i);
    const conv = i > 3 ? 4 : 0;
    await DB.prepare(`INSERT INTO media_campaign_days (store, day, campaign_id, cost, clicks, impressions, conversions, conv_value, fetched_at) VALUES ('hc', ?, '1', 50, 5, 50, ?, ?, ?)`)
      .bind(day, conv, conv * 100, new Date(NOW - 3600000).toISOString()).run();
  }
  const r = await runConversions(env, { storeId: "hc", nowMs: NOW });
  assert.equal(r, "ok: bad");
  assert.equal((await evs(DB, "media.flag")).length, 1);
  await runConversions(env, { storeId: "hc", nowMs: NOW + 6 * 3600000 - 1 });
  assert.equal((await evs(DB, "media.flag")).length, 1); // same flag, not re-announced
});

test("media: AI reads are capped at one per store per day, and invented search terms are ignored", async () => {
  const { DB, env } = await setup();
  env.ANTHROPIC_API_KEY = "sk-ant-test";
  await connectGoogle(env);
  await seedTz(DB);
  await seedPnl(DB, "hc");
  let claudeCalls = 0;
  const g = fakeGoogle({
    campaign: () => j([{ results: [campRow(YDAY, "1", "A", 30, 60)] }]),
    search_term_view: () => j([{ results: [
      { searchTermView: { searchTerm: "coat sewing pattern", status: "NONE" }, campaign: { id: "1", name: "A" }, metrics: { costMicros: "4000000", conversions: 0 } },
    ] }]),
  }, { claude: (body) => {
    claudeCalls += 1;
    if (/irrelevant/.test(body.system)) return JSON.stringify({ irrelevant: [{ term: "coat sewing pattern", reason: "diy sewing" }, { term: "made up term", reason: "x" }] });
    return "Spend was steady; Google's numbers look generous.";
  } });
  const session = new AdsSession(env, { fetchImpl: g.fetchImpl, nowMs: NOW });
  const { runPerformance } = await import("../src/agents/media/performance.js");
  const { runSearchTerms } = await import("../src/agents/media/searchTerms.js");
  await runPerformance(env, { storeId: "hc", session, nowMs: NOW, fetchImpl: g.fetchImpl });
  await runPerformance(env, { storeId: "hc", session, nowMs: NOW + 4 * 3600000, fetchImpl: g.fetchImpl });
  assert.equal(claudeCalls, 1);
  const read = await DB.prepare(`SELECT status, text FROM media_reads WHERE store = 'hc' AND agent = 'media.performance'`).first();
  assert.equal(read.status, "done");
  await runSearchTerms(env, { storeId: "hc", session, nowMs: NOW, fetchImpl: g.fetchImpl });
  const props = (await DB.prepare(`SELECT key, detail FROM media_proposals WHERE agent = 'media.search_terms'`).all()).results;
  assert.deepEqual(props.map((p) => p.key), ["neg:1:coat sewing pattern"]);
  assert.equal(JSON.parse(props[0].detail).source, "claude");
  assert.equal(claudeCalls, 2);
  // AI cost is logged as events by the shared helper.
  assert.equal((await evs(DB, "ai.call")).length, 2);
});

test("media: performance — an empty Google reply never zeroes stored days (rule 6), logged once", async () => {
  const { DB, env } = await setup();
  await connectGoogle(env);
  await seedTz(DB);
  await seedPnl(DB, "hc");
  let empty = false;
  const g = fakeGoogle({ campaign: () => j([{ results: empty ? [] : [campRow(YDAY, "1", "A", 30, 60), campRow("2026-10-11", "1", "A", 25, 50)] }]) });
  const session = new AdsSession(env, { fetchImpl: g.fetchImpl, nowMs: NOW, maxCalls: 10 });
  await runPerformance(env, { storeId: "hc", session, nowMs: NOW, fetchImpl: g.fetchImpl });
  empty = true;
  const r = await runPerformance(env, { storeId: "hc", session, nowMs: NOW + 3600000, fetchImpl: g.fetchImpl });
  assert.match(r, /^no data/);
  await runPerformance(env, { storeId: "hc", session, nowMs: NOW + 2 * 3600000, fetchImpl: g.fetchImpl });
  const sum = await DB.prepare(`SELECT SUM(cost) AS c FROM media_campaign_days WHERE store = 'hc'`).first();
  assert.equal(sum.c, 55);
  assert.equal((await evs(DB, "media.check")).length, 1);
});

test("media: performance flag titles say what the ROAS is and that break-even rests on estimated COGS", async () => {
  const { DB, env } = await setup();
  await connectGoogle(env);
  await seedTz(DB);
  await seedPnl(DB, "hc");
  const days = Array.from({ length: 5 }, (_, i) => minusDays(YDAY, i));
  const g = fakeGoogle({ campaign: () => j([{ results: days.map((d) => campRow(d, "1", "Bleeder", 20, 20)) }]) });
  const session = new AdsSession(env, { fetchImpl: g.fetchImpl, nowMs: NOW });
  await runPerformance(env, { storeId: "hc", session, nowMs: NOW, fetchImpl: g.fetchImpl });
  const f = await DB.prepare(`SELECT summary FROM media_findings WHERE agent = 'media.performance'`).first();
  assert.match(f.summary, /Google ROAS, capped at total store revenue/);
  assert.match(f.summary, /break-even 2\.02x \(estimated: COGS estimated\)/);
  assert.equal(breakevenLabel({ breakeven: 2, estimated: false }), "break-even 2.00x");
  const st = await mediaState(env, { nowMs: NOW });
  const hc = st.stores.find((x) => x.store === "hc");
  assert.equal(hc.roas_capped_label, "Google ROAS, capped at total store revenue");
  assert.equal("roas_adjusted" in hc, false);
  assert.equal(st.budget.track_record.label, "early / crude");
});

test("media: writes are batched when D1 offers batch, capped at 500 rows, and a failure part-way never empties the table", async () => {
  const { DB, env } = await setup();
  await connectGoogle(env);
  await seedTz(DB);
  const term = (t, usd) => ({ searchTermView: { searchTerm: t, status: "NONE" }, campaign: { id: "1", name: "S" }, metrics: { costMicros: String(Math.round(usd * 1e6)), conversions: 1 } });
  let rows = [term("old one", 5), term("old two", 4)];
  const g = fakeGoogle({ search_term_view: () => j([{ results: rows }]) });
  let batches = 0;
  DB.batch = async (stmts) => { batches += 1; for (const st of stmts) await st.run(); };
  const session = new AdsSession(env, { fetchImpl: g.fetchImpl, nowMs: NOW, maxCalls: 10 });
  await runSearchTerms(env, { storeId: "hc", session, nowMs: NOW, fetchImpl: g.fetchImpl });
  assert.equal(batches, 1);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM media_search_terms`).first()).n, 2);
  // 600 terms: the costliest 500 stored, in 10 batches of 50; last window's rows gone.
  rows = Array.from({ length: 600 }, (_, i) => term(`t${i}`, 1 + i / 100));
  batches = 0;
  await runSearchTerms(env, { storeId: "hc", session, nowMs: NOW + 86400000, fetchImpl: g.fetchImpl });
  assert.equal(batches, 10);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM media_search_terms`).first()).n, 500);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM media_search_terms WHERE term = 't599'`).first()).n, 1);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM media_search_terms WHERE term = 'old one'`).first()).n, 0);
  // D1 fails on the second chunk: the previous window's rows are still there.
  let calls = 0;
  DB.batch = async (stmts) => { calls += 1; if (calls === 2) throw new Error("D1 limit"); for (const st of stmts) await st.run(); };
  rows = Array.from({ length: 120 }, (_, i) => term(`new${i}`, 2));
  await assert.rejects(() => runSearchTerms(env, { storeId: "hc", session, nowMs: NOW + 2 * 86400000, fetchImpl: g.fetchImpl }), /D1 limit/);
  assert.ok((await DB.prepare(`SELECT COUNT(*) AS n FROM media_search_terms`).first()).n >= 500);
  // No batch on the binding: falls back to one statement at a time.
  delete DB.batch;
  let ran = 0;
  const fake = { run: async () => { ran += 1; } };
  await runBatched(DB, [fake, fake, fake]);
  assert.equal(ran, 3);
});

test("media: a product's loss is labelled 'capped' only when the revenue cap is known", () => {
  const p = { item_id: "shopify_US_1_2", title: "Coat", cost: 40, conversions: 1, conv_value: 40 };
  const uncapped = judgeProduct(p, { breakeven: 2, factor: null, minUsd: 20, real: null });
  assert.equal(uncapped.roas_basis, "Google's own ROAS (cap unknown)");
  assert.match(uncapped.why, /^Google's own ROAS \(cap unknown\) 1\.00x/);
  assert.doesNotMatch(uncapped.why, /capped at total store revenue/);
  const capped = judgeProduct(p, { breakeven: 2, factor: 1, minUsd: 20, real: null });
  assert.equal(capped.roas_basis, "Google ROAS, capped at total store revenue");
});
