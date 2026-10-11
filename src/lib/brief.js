/**
 * Morning brief — 8:00 Eastern, once per day (docs/specs/core.md, approved by Reilly 2026-10-11).
 *
 * Code gathers every number (P&L, approvals, KFB, shipping, money, risk, media, feeds).
 * Claude only writes the words: it is given the computed numbers and nothing else, and told
 * never to invent one. After it answers, CODE checks every number in its text against the
 * data (rule 9: the author never audits its own work); any it can't find is listed at the
 * top of the brief. If the API key is missing or the call fails, a plain code-built brief
 * goes out instead and says so.
 *
 * Voice (Reilly, 2026-10-11): "similar to the eagano brain, short and concise while getting
 * the info across and giving a lot of data and reasoning."
 *
 * Claude API facts (researched 2026-10-11):
 *  - POST https://api.anthropic.com/v1/messages, headers `x-api-key`, `anthropic-version:
 *    2023-06-01` (the newest version; 2023-01-01 is deprecated), `content-type: application/json`.
 *    https://platform.claude.com/docs/en/api/messages/create · https://platform.claude.com/docs/en/api/versioning
 *  - Model id from the wrangler var BRIEF_MODEL (default claude-sonnet-5-5, released
 *    2026-09-28, $2 / $10 per million input / output tokens). On it adaptive thinking is on by
 *    default; `thinking: {type: "between_tools"}` is the lowest setting (no up-front thinking),
 *    and `temperature` must not be set (400). https://platform.claude.com/docs/en/models/sonnet-5-5/overview
 *    If a different model rejects those fields, the call is retried once without them.
 *
 * Mode (rule 11): shadow by default — the brief is saved and shown in Mission Control only.
 * BRIEF_PHONE_LIVE = "1" (Reilly flips it) also sends a Pushover notification with a SIGNED
 * link to /brief/:id. The notification text itself carries no money figures (it passes
 * through Pushover's servers); the numbers are only on the signed page.
 */
import { LIVE_STORE_IDS, STORES } from "../config/stores.js";
import { logEvent } from "./eventlog.js";
import { evaluateFeeds } from "./freshness.js";
import { listPending, hmacHex, sameText } from "./approvals.js";
import { listKfbMessages, easternClock } from "./kfbMessage.js";
import { sendPhone, phoneReady } from "./phone.js";
import { page, esc } from "./approvalPage.js";
import { recomputeDays, rowsBetween, sumRows, storeTz } from "./pnl.js";
import { minusDays } from "./adsSpend.js";
import { localDay, nowIso } from "./time.js";

export const BRIEF_AFTER_MIN = 8 * 60; // 08:00 Eastern
export const DEFAULT_BRIEF_MODEL = "claude-sonnet-5-5";
export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const BRIEF_MAX_TOKENS = 1500; // ~250 words of brief plus headroom; keeps the cost to cents
export const BRIEF_LINK_TTL_MS = 48 * 3600 * 1000; // money on the page: shorter than the 7-day approval links
const ACTOR = "core.briefer";

/**
 * USD per million tokens [input, output]. Source: the model overview pages on
 * platform.claude.com (2026-10-11). A model not listed is priced at the highest known rate,
 * so the AI-cost tile can only over-state, never under-state (rule 5).
 */
export const PRICES = Object.freeze({
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
});
const UNKNOWN_PRICE = [10, 50];

export function briefMode(env) {
  return env && env.BRIEF_PHONE_LIVE === "1" ? "live" : "shadow";
}

export function aiCostUsd(model, usage) {
  const [pin, pout] = PRICES[model] || UNKNOWN_PRICE;
  const i = Number(usage && usage.input_tokens) || 0;
  const o = Number(usage && usage.output_tokens) || 0;
  return Math.round(((i * pin + o * pout) / 1e6) * 1e6) / 1e6;
}

/** Never let a key reach a stored error, an event or the page. */
export function scrubKey(text, env) {
  let s = String(text == null ? "" : text);
  if (env && env.ANTHROPIC_API_KEY && String(env.ANTHROPIC_API_KEY).length >= 6) s = s.split(String(env.ANTHROPIC_API_KEY)).join("[redacted]");
  return s.replace(/sk-ant-[\w-]+/g, "[redacted]").slice(0, 300);
}

const money = (n) => (n == null ? "not wired" : `${n < 0 ? "-" : ""}$${Math.abs(Number(n)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (n) => (n == null ? "—" : `${Math.round(Number(n) * 1000) / 10}%`);
const x2 = (n) => (n == null ? "—" : Number(n).toFixed(2));

/* ---------------- 1. gather (code only) ---------------- */

/** One P&L row (or sum) → the compact numbers the brief is allowed to use. */
function pnlFacts(r) {
  if (!r) return null;
  const basis = r.cogs_basis || {};
  return {
    revenue: r.revenue, orders: r.orders, refunds: r.refunds, refunds_pending: r.refunds_pending,
    cogs: r.cogs, cogs_source: r.cogs_source || (r.cogs_estimated_share ? "estimate" : null),
    cogs_estimated_share: r.cogs_estimated_share,
    cogs_rate: basis.rate ?? null, cogs_rate_assumed: !!(basis.rate_assumed || r.cogs_assumed),
    ads: r.ads, guy_fee: r.guy_fee, shopify_fees: r.fees,
    profit: r.profit, profit_excluding_unwired: r.profit == null ? r.profit_partial : undefined,
    margin: r.margin, roas: r.roas, breakeven_roas: r.breakeven_roas,
    roas_minus_breakeven: r.roas != null && r.breakeven_roas != null ? Math.round((r.roas - r.breakeven_roas) * 100) / 100 : null,
    complete: !!r.complete,
    not_wired: (r.notes && r.notes.missing) || r.missing || [],
    stale_inputs: (r.notes && r.notes.stale_inputs) || r.stale || [],
  };
}

const ageDays = (iso, nowMs) => (iso ? Math.floor((nowMs - Date.parse(iso)) / 86400000) : null);

export async function gatherBriefData(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const { day } = easternClock(nowMs);
  const marks = LIVE_STORE_IDS.map(() => "?").join(", ") || "''";
  const feeds = await evaluateFeeds(db, nowMs);

  // Yesterday + month-to-date, per store and group.
  const stores = [];
  const yRows = [], mtdRows = [];
  let forDay = minusDays(day, 1);
  for (const id of LIVE_STORE_IDS) {
    const y = minusDays(localDay(nowMs, storeTz(id)), 1);
    forDay = y;
    const from = `${y.slice(0, 7)}-01`;
    const yr = (await rowsBetween(db, id, y, y))[0] || null;
    const mrows = await rowsBetween(db, id, from, y);
    const w = await rowsBetween(db, id, minusDays(y, 6), y);
    if (yr) yRows.push(yr);
    mtdRows.push(...mrows);
    const mtd = sumRows(mrows);
    const wk = sumRows(w);
    stores.push({
      id, name: STORES[id].name,
      yesterday: yr ? pnlFacts(yr) : null,
      month_to_date: { from, to: y, days_recorded: mrows.length, ...pnlFacts(mtd) },
      media_watch: {
        ads_yesterday: yr ? yr.ads : null, roas_yesterday: yr ? yr.roas : null, breakeven_yesterday: yr ? yr.breakeven_roas : null,
        verdict_yesterday: verdict(yr && yr.roas, yr && yr.breakeven_roas),
        ads_7d: wk.ads, roas_7d: wk.roas, breakeven_7d: wk.breakeven_roas, verdict_7d: verdict(wk.roas, wk.breakeven_roas),
        breakeven_uses_estimated_cogs: true,
      },
    });
  }
  const group = {
    yesterday: yRows.length === LIVE_STORE_IDS.length && yRows.length ? pnlFacts(sumRows(yRows)) : null,
    month_to_date: mtdRows.length ? pnlFacts(sumRows(mtdRows)) : null,
  };

  // Waiting on Reilly.
  const pending = await listPending(db);
  const kfb = (await listKfbMessages(db, 1))[0] || null;

  // Orders + shipping.
  const { results: flagRows } = await db.prepare(
    `SELECT kind, COUNT(*) AS n FROM shipment_flags WHERE resolved_at IS NULL AND store IN (${marks}) GROUP BY kind`
  ).bind(...LIVE_STORE_IDS).all();
  const { results: newFlags } = await db.prepare(
    `SELECT store, order_name, kind, detail FROM shipment_flags WHERE resolved_at IS NULL AND raised_at >= ? AND store IN (${marks}) ORDER BY raised_at DESC LIMIT 6`
  ).bind(nowIso(nowMs - 86400000), ...LIVE_STORE_IDS).all();
  const express = await db.prepare(
    `SELECT COUNT(*) AS n FROM orders WHERE express = 1 AND local_day = ? AND store IN (${marks})`
  ).bind(forDay, ...LIVE_STORE_IDS).first();

  // Money.
  const { results: balances } = await db.prepare(
    `SELECT store, amount, currency, as_of FROM money_balances WHERE store IN (${marks})`
  ).bind(...LIVE_STORE_IDS).all();
  const { results: scheduled } = await db.prepare(
    `SELECT store, issued_at, net, currency FROM payouts WHERE status = 'SCHEDULED' AND store IN (${marks}) ORDER BY issued_at`
  ).bind(...LIVE_STORE_IDS).all();
  const { results: pend } = await db.prepare(
    `SELECT store, amount, processed_at FROM refunds WHERE status LIKE '%PENDING%' AND store IN (${marks}) ORDER BY processed_at`
  ).bind(...LIVE_STORE_IDS).all();

  // Risk: alarms and errors in the last 24 hours.
  const { results: alarms } = await db.prepare(
    `SELECT kind, store, summary FROM events
      WHERE at >= ? AND (kind IN ('payout.mismatch', 'pnl.restated', 'feed.alarm') OR kind LIKE 'error.%')
      ORDER BY id DESC LIMIT 8`
  ).bind(nowIso(nowMs - 86400000)).all();

  return {
    brief_day: day,
    pnl_day: forDay,
    stores,
    group,
    waiting: {
      approvals: pending.map((a) => ({ id: a.id, title: a.title, store: a.store, waiting_days: ageDays(a.created_at, nowMs) })),
      kfb_latest: kfb ? { day: kfb.local_day, status: kfb.status, mode: kfb.mode, orders: kfb.item_count } : null,
    },
    orders: {
      express_yesterday: express ? Number(express.n) : 0,
      open_shipping_flags: Object.fromEntries((flagRows || []).map((r) => [r.kind, Number(r.n)])),
      new_flags_24h: (newFlags || []).map((f) => ({ store: STORES[f.store] ? STORES[f.store].name : f.store, order: f.order_name, kind: f.kind, detail: f.detail })),
    },
    money: {
      shopify_balances: (balances || []).map((b) => ({ store: STORES[b.store].name, amount: b.amount, currency: b.currency, age_days: ageDays(b.as_of, nowMs) })),
      scheduled_payouts: (scheduled || []).map((p) => ({ store: STORES[p.store].name, date: String(p.issued_at || "").slice(0, 10), amount: p.net, currency: p.currency })),
      pending_refunds: {
        count: (pend || []).length,
        amount: Math.round((pend || []).reduce((s, r) => s + (Number(r.amount) || 0), 0) * 100) / 100,
        older_than_7_days: (pend || []).filter((r) => ageDays(r.processed_at, nowMs) > 7).length,
      },
    },
    risk: (alarms || []).map((a) => ({ kind: a.kind, store: a.store, what: a.summary })),
    feeds_not_fresh: feeds.filter((f) => f.current !== "fresh").map((f) => ({ feed: f.label, state: f.current, last_ok_at: f.last_ok_at })),
  };
}

function verdict(roas, be) {
  if (roas == null || be == null) return "unknown";
  return roas >= be ? "above break-even" : "below break-even";
}

/* ---------------- 2a. the plain (code-built) brief ---------------- */

function moneyLine(name, f) {
  if (!f) return `- **${name}:** no P&L row yet`;
  const est = f.cogs_source === "estimate" || f.cogs_source === "mixed";
  const cogs = f.cogs == null ? "not wired" : `${money(f.cogs)}${est ? ` (estimate${f.cogs_rate_assumed ? ", ASSUMED 33% rate" : ""})` : ""}`;
  const profit = f.profit != null ? money(f.profit)
    : `unknown (${f.not_wired.join(", ") || "inputs missing"} not wired)${f.profit_excluding_unwired != null ? `; ${money(f.profit_excluding_unwired)} before those` : ""}`;
  return `- **${name}:** revenue ${money(f.revenue)} (${f.orders == null ? "orders not wired" : `${f.orders} order${f.orders === 1 ? "" : "s"}`}) · refunds ${money(f.refunds)}` +
    `${f.refunds_pending ? ` (${money(f.refunds_pending)} PENDING)` : ""} · COGS ${cogs} · ads ${money(f.ads)} · Guy ${money(f.guy_fee)}` +
    ` · fees ${money(f.shopify_fees)} → **profit ${profit}** · ROAS ${x2(f.roas)} vs break-even ${x2(f.breakeven_roas)}` +
    `${f.complete ? "" : " · _not complete_"}${f.stale_inputs.length ? ` (${f.stale_inputs.join(", ")})` : ""}`;
}

export function plainBrief(d) {
  const L = [];
  L.push(`## Yesterday's money · ${d.pnl_day}`);
  for (const s of d.stores) L.push(moneyLine(s.name, s.yesterday));
  L.push(moneyLine("Group", d.group.yesterday));
  if (d.group.month_to_date) L.push(moneyLine(`Month to date`, d.group.month_to_date));
  L.push("");
  L.push("## Waiting on you");
  if (!d.waiting.approvals.length) L.push("- Nothing waiting.");
  for (const a of d.waiting.approvals.slice(0, 8)) L.push(`- ${a.title}${a.waiting_days ? ` (${a.waiting_days} d)` : ""}`);
  if (d.waiting.kfb_latest) L.push(`- KFB message ${d.waiting.kfb_latest.day}: ${d.waiting.kfb_latest.status} (${d.waiting.kfb_latest.mode}, ${d.waiting.kfb_latest.orders} orders)`);
  L.push("");
  L.push("## Orders");
  L.push(`- Express orders yesterday: ${d.orders.express_yesterday}`);
  const fl = Object.entries(d.orders.open_shipping_flags);
  L.push(`- Open shipping flags: ${fl.length ? fl.map(([k, n]) => `${k} ${n}`).join(", ") : "none"}`);
  for (const f of d.orders.new_flags_24h) L.push(`- New: ${f.store} ${f.order} · ${f.kind} — ${f.detail}`);
  L.push("");
  L.push("## Money");
  for (const b of d.money.shopify_balances) L.push(`- ${b.store} Shopify balance ${money(b.amount)} ${b.currency || ""} (${b.age_days ?? "?"} d old)`);
  for (const p of d.money.scheduled_payouts) L.push(`- Payout scheduled ${p.date}: ${p.store} ${money(p.amount)}`);
  const pr = d.money.pending_refunds;
  L.push(`- PENDING refunds: ${pr.count} (${money(pr.amount)})${pr.older_than_7_days ? `, **${pr.older_than_7_days} older than 7 days**` : ""}`);
  if (d.risk.length) {
    L.push("");
    L.push("## Risk");
    for (const r of d.risk.slice(0, 6)) L.push(`- ${r.what}`);
  }
  L.push("");
  L.push("## Media (watch only)");
  for (const s of d.stores) {
    const m = s.media_watch;
    L.push(`- ${s.name}: ads ${money(m.ads_yesterday)}, ROAS ${x2(m.roas_yesterday)} vs break-even ${x2(m.breakeven_yesterday)} (${m.verdict_yesterday}); 7 days ROAS ${x2(m.roas_7d)} vs ${x2(m.breakeven_7d)} (${m.verdict_7d}). Break-even uses estimated COGS.`);
  }
  L.push("");
  L.push("## Feeds");
  if (!d.feeds_not_fresh.length) L.push("- All feeds fresh.");
  for (const f of d.feeds_not_fresh) L.push(`- ${f.feed}: ${f.state.replace("_", " ")}`);
  return L.join("\n");
}

/* ---------------- 2b. the AI brief ---------------- */

export const SYSTEM_PROMPT = `You write Reilly's 8:00 morning brief for his Shopify stores (Holt & Crane, Auberlane, Marlowe Standard).
Voice, in Reilly's words: "short and concise while getting the info across and giving a lot of data and reasoning".

Hard rules:
1. Use ONLY numbers that appear in DATA. Never invent, estimate, round into new figures, or extrapolate. Do not add up numbers yourself; the totals you need are in DATA (group, month_to_date, roas_minus_breakeven).
2. null means "not wired / unknown". Say "not wired", never treat it as zero.
3. Wherever cogs_source is "estimate", call COGS (and profit, margin, break-even) an estimate. If cogs_rate_assumed is true, say the 33% COGS rate is ASSUMED.
4. A day with complete=false or stale_inputs is not final; say which inputs.
5. Good news gets MORE scrutiny, not less: when a number looks good, say what could make it wrong (estimated COGS, stale feed, partial day, PENDING refunds).
6. Media is watch only: describe ROAS against break-even and the reason; never recommend changing bids, budgets or campaigns.
7. Give the reasoning behind each judgement in a few words.

Format: plain markdown subset only: "## " headings, "- " bullets, **bold**. No tables, no links, no HTML.
Sections in this order: Yesterday's money (per store + group, then month to date) · Waiting on you · Orders · Risk (omit if empty) · Media · Feeds.
Keep it under about 250 words.`;

export function buildPrompt(data) {
  return { system: SYSTEM_PROMPT, user: `DATA (computed by code; the only numbers you may use):\n${JSON.stringify(data)}` };
}

export class BriefAiError extends Error {}

/** One Messages API call. Returns { text, usage, model, stop_reason }. Throws BriefAiError (never with the key in it). */
export async function callClaude(env, prompt, { fetchImpl = fetch } = {}) {
  const model = String(env.BRIEF_MODEL || DEFAULT_BRIEF_MODEL).trim();
  const base = {
    model, max_tokens: BRIEF_MAX_TOKENS, system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
  };
  // No up-front thinking (plain writing task, keeps tokens down) and low effort.
  const tuned = { ...base, thinking: { type: "between_tools" }, output_config: { effort: "low" } };
  const send = async (body) => {
    let res;
    try {
      res = await fetchImpl(ANTHROPIC_URL, {
        method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new BriefAiError(scrubKey(`couldn't reach the Claude API (${err && err.message})`, env));
    }
    const j = await res.json().catch(() => null);
    return { res, j };
  };
  let { res, j } = await send(tuned);
  const errMsg = (x) => (x && x.error && x.error.message) || "";
  if (res.status === 400 && /thinking|output_config|effort/i.test(errMsg(j))) ({ res, j } = await send(base));
  if (!res.ok || !j) {
    throw new BriefAiError(scrubKey(`Claude API HTTP ${res.status}${errMsg(j) ? `: ${errMsg(j)}` : ""}`, env));
  }
  const text = (Array.isArray(j.content) ? j.content : []).filter((b) => b && b.type === "text").map((b) => b.text).join("\n").trim();
  if (!text) throw new BriefAiError(`Claude API returned no text (stop_reason ${j.stop_reason || "?"})`);
  return { text, usage: j.usage || {}, model: j.model || model, stop_reason: j.stop_reason || null };
}

/* ---------------- 3. code checks the AI's numbers (rule 9) ---------------- */

function collectNumbers(v, out = []) {
  if (v == null) return out;
  if (typeof v === "number") { if (Number.isFinite(v)) out.push(v); return out; }
  if (typeof v === "string") {
    for (const m of v.replace(/,/g, "").matchAll(/-?\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
    return out;
  }
  if (Array.isArray(v)) { for (const x of v) collectNumbers(x, out); return out; }
  if (typeof v === "object") for (const x of Object.values(v)) collectNumbers(x, out);
  return out;
}

/**
 * Numbers in the AI's text that the data doesn't contain. Each figure is matched at the
 * precision it was written in ("$1,234" within 0.5, "2.1" within 0.05); "31%" may be a
 * ratio of 0.31. Dates, times and small counts (0-31) are not checked.
 */
export function unverifiedNumbers(text, data) {
  const known = collectNumbers(data);
  const cleaned = String(text)
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}\b/g, " ")
    .replace(/#\d+/g, " ");
  const bad = [];
  for (const m of cleaned.matchAll(/(\$)?(-?\d[\d,]*(?:\.\d+)?)(k)?(%)?/gi)) {
    const raw = m[0];
    const digits = m[2].replace(/,/g, "");
    let v = Number(digits);
    if (!Number.isFinite(v)) continue;
    const dec = (digits.split(".")[1] || "").length;
    let tol = 0.5 * Math.pow(10, -dec) + 1e-9;
    if (m[3]) { v *= 1000; tol *= 1000; }
    if (!m[1] && !m[4] && !m[3] && dec === 0 && Math.abs(v) <= 31) continue;
    const ok = known.some((c) => Math.abs(Math.abs(c) - Math.abs(v)) <= tol ||
      (m[4] && Math.abs(Math.abs(c) * 100 - Math.abs(v)) <= tol));
    if (!ok) bad.push(raw);
  }
  return [...new Set(bad)];
}

/* ---------------- 4. the daily run ---------------- */

/**
 * The cron step. Safe every 15 minutes: nothing before 08:00 Eastern, and only the first
 * run after it (per Eastern day) composes. The briefs row (UNIQUE day) is the claim.
 */
export async function runBrief(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const db = env.DB;
  const { day, minutes } = easternClock(nowMs);
  if (minutes < BRIEF_AFTER_MIN) return { ran: false, reason: "before 08:00 Eastern" };
  const at = nowIso(nowMs);
  const mode = briefMode(env);
  const claim = await db.prepare(
    `INSERT INTO briefs (day, created_at, status, mode) VALUES (?, ?, 'composing', ?) ON CONFLICT(day) DO NOTHING`
  ).bind(day, at, mode).run();
  if (!claim.meta || claim.meta.changes !== 1) return { ran: false, reason: "already composed today" };
  const row = await db.prepare(`SELECT id, created_at FROM briefs WHERE day = ?`).bind(day).first();

  let notified = false;
  try {
    // Fresh numbers first: the hourly job may be up to an hour behind.
    await recomputeDays(env, { nowMs, reason: "brief" });
    const data = await gatherBriefData(env, { nowMs });
    const plain = plainBrief(data);

    let body = plain, composer = "plain", model = null, usage = null, cost = 0, aiError = null, unverified = [];
    if (!env.ANTHROPIC_API_KEY) {
      aiError = "ANTHROPIC_API_KEY is not set in Cloudflare";
    } else {
      try {
        const r = await callClaude(env, buildPrompt(data), { fetchImpl });
        model = r.model; usage = r.usage; cost = aiCostUsd(r.model, r.usage);
        // Log the spend at once, so a later fault (and a retry) can't hide what was paid.
        await logEvent(db, {
          actor: ACTOR, kind: "ai.call", target: "sys.claude", costUsd: cost,
          summary: `Morning brief ${day}: Claude ${r.model}, ${usage.input_tokens || 0} in / ${usage.output_tokens || 0} out tokens ($${cost.toFixed(4)})`,
          // Key names avoid "token": the event log redacts any field named like a credential.
          data: { model: r.model, usage_in: usage.input_tokens || 0, usage_out: usage.output_tokens || 0, stop_reason: r.stop_reason }, at,
        });
        body = r.text + (r.stop_reason === "max_tokens" ? "\n\n_(cut short at the length limit)_" : "");
        composer = "ai";
        unverified = unverifiedNumbers(r.text, data);
      } catch (err) {
        aiError = scrubKey(err && err.message, env);
      }
    }
    if (aiError) {
      body = `> Plain brief, built by code: the AI version is unavailable (${aiError}).\n\n${plain}`;
      await logEvent(db, { actor: ACTOR, kind: "brief.ai_failed", target: "sys.claude", summary: `Morning brief ${day}: using the plain brief (${aiError})`, at });
    } else if (unverified.length) {
      body = `> **Check:** these numbers in the text are not in the brain's data: ${unverified.join(", ")}. Treat them as unverified.\n\n${body}`;
    }

    await db.prepare(
      `UPDATE briefs SET status = 'ready', body_md = ?, data = ?, model = ?, composer = ?, input_tokens = ?, output_tokens = ?,
         cost_usd = ?, ai_error = ?, unverified = ? WHERE id = ?`
    ).bind(body, JSON.stringify(data), model, composer, usage ? usage.input_tokens || 0 : null, usage ? usage.output_tokens || 0 : null,
      cost, aiError, JSON.stringify(unverified), row.id).run();

    let phone = null;
    if (mode === "live") {
      phone = await notifyBrief(env, { id: row.id, created_at: row.created_at, day }, data, { nowMs, fetchImpl });
      notified = !!phone.sent;
      await db.prepare(`UPDATE briefs SET phone = ? WHERE id = ?`).bind(JSON.stringify(phone), row.id).run();
    }
    await logEvent(db, {
      actor: ACTOR,
      kind: mode === "shadow" ? "brief.composed" : phone.sent ? "brief.notified" : "brief.notify_failed",
      target: mode === "live" ? "sys.phone" : null,
      summary: `Morning brief ${day} ready (${composer === "ai" ? `Claude ${model}` : "plain, no AI"}` +
        `${unverified.length ? `, ${unverified.length} unverified number${unverified.length === 1 ? "" : "s"}` : ""})` +
        (mode === "shadow" ? " — shadow: Mission Control only" : phone.sent ? " — sent to Reilly's phone" : ` — phone notification failed: ${phone.reason}`),
      data: { briefId: row.id, day, mode, composer, model, unverified }, at,
    });
    return { ran: true, day, id: row.id, mode, composer, model, body, unverified, aiError, phone, cost };
  } catch (err) {
    if (notified) throw err; // already on the phone: keep it, don't send a second one
    await db.prepare(`DELETE FROM briefs WHERE id = ?`).bind(row.id).run().catch(() => {});
    throw err;
  }
}

/* ---------------- signed page + phone ---------------- */

export const signBrief = (secret, brief, expMs) => hmacHex(secret, `brief:${brief.id}:${brief.created_at}:view:${expMs}`);

export async function verifyBriefSig(secret, brief, sig, expMs, nowMs = Date.now()) {
  if (!secret || !sig || !brief) return false;
  const exp = Number(expMs);
  if (!Number.isFinite(exp) || exp < nowMs || exp > nowMs + BRIEF_LINK_TTL_MS + 60000) return false;
  return sameText(await signBrief(secret, brief, exp), sig);
}

export async function briefPageUrl(env, brief, baseUrl, nowMs = Date.now()) {
  const exp = nowMs + BRIEF_LINK_TTL_MS;
  return `${baseUrl}/brief/${brief.id}?exp=${exp}&sig=${await signBrief(env.APPROVAL_SIGNING_KEY, brief, exp)}`;
}

/** Push "your brief is ready" with the signed link. No money in the notification text. */
export async function notifyBrief(env, brief, data, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const baseUrl = String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!phoneReady(env)) return { sent: false, reason: "Pushover keys are not set in Cloudflare yet" };
  if (!env.APPROVAL_SIGNING_KEY) return { sent: false, reason: "APPROVAL_SIGNING_KEY is not set" };
  if (!baseUrl) return { sent: false, reason: "PUBLIC_BASE_URL is not set" };
  const waiting = data && data.waiting ? data.waiting.approvals.length : 0;
  const stale = data && data.feeds_not_fresh ? data.feeds_not_fresh.length : 0;
  return sendPhone(env, {
    title: "Store Brain: morning brief",
    message: `Brief for ${brief.day} is ready. ${waiting} waiting on you` + (stale ? `, ${stale} feed${stale === 1 ? "" : "s"} not fresh.` : "."),
    url: await briefPageUrl(env, brief, baseUrl, nowMs),
    urlTitle: "Open the brief",
  }, { fetchImpl });
}

/** Safe markdown subset → HTML: everything escaped first; then ## headings, - bullets, **bold**, _italic_, > note. */
export function briefHtml(md) {
  const inline = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|\s)_([^_]+)_(?=\s|$|[.,;:)])/g, "$1<i>$2</i>");
  const out = [];
  let list = false;
  for (const line of String(md || "").split("\n")) {
    const t = line.trim();
    const bullet = /^[-*•]\s+/.test(t);
    if (!bullet && list) { out.push("</ul>"); list = false; }
    if (!t) continue;
    if (bullet) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${inline(t.replace(/^[-*•]\s+/, ""))}</li>`); continue; }
    const h = t.match(/^(#{1,3})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue; }
    if (t.startsWith(">")) { out.push(`<div class="note">${inline(t.replace(/^>\s*/, ""))}</div>`); continue; }
    out.push(`<p>${inline(t)}</p>`);
  }
  if (list) out.push("</ul>");
  return out.join("\n");
}

export async function getBrief(db, id) {
  return db.prepare(`SELECT * FROM briefs WHERE id = ?`).bind(id).first();
}

/** Latest finished brief for Mission Control. */
export async function latestBrief(db) {
  const r = await db.prepare(`SELECT id, day, created_at, mode, body_md, model, composer, input_tokens, output_tokens, cost_usd, ai_error, unverified, phone FROM briefs WHERE status = 'ready' ORDER BY day DESC LIMIT 1`).first();
  if (!r) return null;
  const j = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  return { ...r, unverified: j(r.unverified) || [], phone: j(r.phone) };
}

const BRIEF_CSS = `main{max-width:640px}h2{font-size:15px;margin:18px 0 6px;color:var(--accent)}h3,h4{font-size:14px;margin:14px 0 4px}
ul{margin:0;padding-left:18px}li{margin:3px 0;font-size:14px}p{margin:6px 0;font-size:14px}
.note{border:1px solid #4a3d29;color:var(--warn);border-radius:8px;padding:8px 10px;margin:8px 0;font-size:13px}`;

/** GET /brief/:id?exp&sig — the brief, read-only. Same answer for "no such brief" and "bad link". */
export async function handleBriefPage(request, env, id, nowMs = Date.now()) {
  const url = new URL(request.url);
  const b = await getBrief(env.DB, id);
  if (!b || b.status !== "ready" || !(await verifyBriefSig(env.APPROVAL_SIGNING_KEY, b, url.searchParams.get("sig"), url.searchParams.get("exp"), nowMs))) {
    return page("Link not valid", `<h1>This link isn't valid</h1><div class="meta">It may have expired (brief links last 48 hours). Open Mission Control → Brief instead.</div>`, 403);
  }
  const inner = `<h1>Morning brief · ${esc(b.day)}</h1>
<div class="meta">${esc(b.composer === "ai" ? `written by Claude (${b.model}) from the brain's numbers` : "plain brief, built by code")} · ${esc(b.mode)}</div>
${briefHtml(b.body_md)}`;
  return page(`Brief ${b.day}`, inner, 200, BRIEF_CSS);
}

