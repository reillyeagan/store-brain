/**
 * Media department — shared plumbing for the seven watch-only agents.
 *
 * WATCH ONLY (Reilly, 2026-10-11: "guy is still the mediabuyer ... the media section is just
 * watching more than anything"). Everything here READS Google Ads with GAQL searchStream
 * (src/lib/adsSpend.js adsQuery). There is no function in this folder that writes to
 * Google Ads, and none may be added without Reilly's own words.
 *
 * What lives here:
 *  - which stores have an ad account (live + adsCustomerId),
 *  - an AdsSession: one Google token per tick, a hard cap on Ads calls per tick, and
 *    "not wired" as its own answer (never zero),
 *  - the store's break-even ROAS from the P&L ledger (pnl_days), never invented,
 *  - the "reality factor": Shopify revenue / Google's claimed conversion value, capped at 1
 *    so Google's numbers can be marked DOWN but never up (rule 5),
 *  - findings (flags that stay open while true) and rate-limited error events.
 */
import { LIVE_STORE_IDS, STORES } from "../../config/stores.js";
import { getGoogleAccessToken } from "../../lib/google.js";
import { adsQuery, cleanCustomerId, scrubSecrets, minusDays } from "../../lib/adsSpend.js";
import { breakevenRoas } from "../../lib/pnl.js";
import { logEvent } from "../../lib/eventlog.js";
import { localDay, nowIso } from "../../lib/time.js";

export { minusDays };

/** Stores the media agents watch: live AND with a Google Ads customer id. */
export function mediaStoreIds() {
  return LIVE_STORE_IDS.filter((id) => STORES[id] && cleanCustomerId(STORES[id].adsCustomerId));
}

/** Why a store is not watched (for the page). Null when it is. */
export function notWiredReason(storeId) {
  const s = STORES[storeId];
  if (!s) return "unknown store";
  if (!s.live) return "store not live";
  if (!cleanCustomerId(s.adsCustomerId)) return "no Google Ads customer id in config";
  return null;
}

export const r2 = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);
export const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
export const real = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const micros = (v) => int(v) / 1e6;

export class MediaNotWired extends Error {
  constructor(message) { super(message); this.name = "MediaNotWired"; this.code = "NOT_WIRED"; }
}
export class MediaCallBudget extends Error {
  constructor() { super("Ads call budget for this tick is used up"); this.name = "MediaCallBudget"; this.code = "CALL_BUDGET"; }
}

/**
 * One cron tick's access to Google Ads.
 * - The token is fetched once, on first use. Google not connected → MediaNotWired (skip).
 * - `maxCalls` caps Ads requests per tick (Worker subrequest limits); `canCall(n)` lets an
 *   agent check before it claims its job, so a claimed job never runs half.
 */
export class AdsSession {
  constructor(env, { fetchImpl = fetch, nowMs = Date.now(), maxCalls = 8 } = {}) {
    this.env = env; this.fetchImpl = fetchImpl; this.nowMs = nowMs;
    this.maxCalls = maxCalls; this.calls = 0;
    this.token = undefined; this.notWired = null; this.tokenError = null;
  }

  canCall(n = 1) { return !this.notWired && !this.tokenError && this.calls + n <= this.maxCalls; }

  async getToken() {
    if (this.notWired) throw new MediaNotWired(this.notWired);
    if (this.token) return this.token;
    // A sign-in that failed once this tick fails for the rest of it (no repeated token calls).
    if (this.tokenError) throw new Error(this.tokenError);
    try {
      this.token = await getGoogleAccessToken(this.env, { fetchImpl: this.fetchImpl, nowMs: this.nowMs });
      return this.token;
    } catch (err) {
      if (err && err.code === "NOT_WIRED") {
        this.notWired = "Google not connected";
        throw new MediaNotWired(this.notWired);
      }
      this.tokenError = scrubSecrets(`Google sign-in failed: ${err && err.message}`);
      throw new Error(this.tokenError);
    }
  }

  /** Read-only GAQL for one store. Throws on any problem (callers log it; never treat as zero). */
  async query(storeId, gaql) {
    const cid = cleanCustomerId(STORES[storeId] && STORES[storeId].adsCustomerId);
    if (!cid) throw new MediaNotWired(`${storeId}: no Google Ads customer id`);
    // Defence in depth: this department must never send anything but a SELECT.
    if (!/^\s*SELECT\s/i.test(gaql)) throw new Error("media: only SELECT queries are allowed (watch only)");
    if (this.calls >= this.maxCalls) throw new MediaCallBudget();
    const token = await this.getToken();
    this.calls += 1;
    try {
      return await adsQuery(this.env, cid, gaql, { token, fetchImpl: this.fetchImpl });
    } catch (err) {
      const e = new Error(scrubSecrets(err && err.message, [token, this.env.GOOGLE_ADS_DEVELOPER_TOKEN]));
      e.code = err && err.code;
      throw e;
    }
  }
}

/**
 * The ad account's timezone (Google reports days in it). Taken from the spend puller's rows
 * first (no API call); otherwise asked once from the account.
 */
export async function accountTz(env, storeId, session) {
  const row = await env.DB.prepare(`SELECT account_tz FROM ad_spend_days WHERE store = ? AND account_tz IS NOT NULL ORDER BY day DESC LIMIT 1`)
    .bind(storeId).first().catch(() => null);
  if (row && row.account_tz) return row.account_tz;
  const rows = await session.query(storeId, "SELECT customer.time_zone FROM customer");
  const tz = rows[0] && rows[0].customer && rows[0].customer.timeZone;
  if (!tz) throw new Error(`${storeId}: Google Ads account returned no timezone`);
  return tz;
}

/** Today (partial) in the account's timezone, and the window of closed days before it. */
export function windowFor(nowMs, tz, days) {
  const today = localDay(nowMs, tz);
  const to = minusDays(today, 1);           // last CLOSED day: today is still moving
  const from = minusDays(to, days - 1);
  return { today, from, to };
}

/**
 * Break-even ROAS for a store from the P&L ledger: margin = (revenue − COGS) / revenue over
 * the days that have BOTH numbers. Days with unknown COGS are left out, never treated as zero
 * COGS (that would make break-even look easier than it is — rule 5). Null when unknown.
 */
export async function storeBreakeven(db, storeId, from, to) {
  const { results } = await db.prepare(
    `SELECT day, revenue, cogs, cogs_basis, cogs_estimated_share FROM pnl_days
     WHERE store = ? AND day >= ? AND day <= ? AND revenue IS NOT NULL AND revenue > 0 AND cogs IS NOT NULL`
  ).bind(storeId, from, to).all();
  const rows = results || [];
  if (!rows.length) return { breakeven: null, margin: null, days: 0, estimated: null, reason: "no P&L days with revenue and COGS" };
  const rev = rows.reduce((s, r) => s + Number(r.revenue), 0);
  const cogs = rows.reduce((s, r) => s + Number(r.cogs), 0);
  const margin = rev > 0 ? (rev - cogs) / rev : null;
  const estimated = rows.some((r) => r.cogs_estimated_share == null || Number(r.cogs_estimated_share) > 0);
  const be = breakevenRoas(margin);
  return {
    breakeven: be, margin: margin == null ? null : Math.round(margin * 10000) / 10000, days: rows.length, estimated,
    reason: be == null ? "margin too thin to break even at any ROAS" : null,
  };
}

/**
 * Shopify reality vs Google's claim over a window: real revenue / Google conv value.
 * Capped at 1: Google's number may be marked DOWN to reality, never UP (Google only sees
 * ad-driven sales, so a ratio above 1 is other channels, not a reason to flatter ads).
 * Null when either side is unknown or Google claims nothing.
 */
export async function realityFactor(db, storeId, from, to) {
  const g = await db.prepare(`SELECT COALESCE(SUM(conv_value), 0) AS v, COUNT(*) AS n FROM media_campaign_days WHERE store = ? AND day >= ? AND day <= ?`)
    .bind(storeId, from, to).first();
  const p = await db.prepare(`SELECT COALESCE(SUM(revenue), 0) AS v, COUNT(*) AS n FROM pnl_days WHERE store = ? AND day >= ? AND day <= ? AND revenue IS NOT NULL`)
    .bind(storeId, from, to).first();
  if (!g || !Number(g.n) || !p || !Number(p.n) || !(Number(g.v) > 0)) return null;
  return Math.min(1, Math.round((Number(p.v) / Number(g.v)) * 10000) / 10000);
}

/* ---------------- findings ---------------- */

/** Open or refresh a finding. Returns true if it is NEW (so the caller can log one event). */
export async function upsertFinding(db, { store, agent, key, severity, summary, data = null, at }) {
  const had = await db.prepare(`SELECT cleared_at FROM media_findings WHERE store = ? AND agent = ? AND key = ?`).bind(store, agent, key).first();
  await db.prepare(
    `INSERT INTO media_findings (store, agent, key, severity, summary, data, first_seen, last_seen, cleared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(store, agent, key) DO UPDATE SET severity = excluded.severity, summary = excluded.summary,
       data = excluded.data, last_seen = excluded.last_seen,
       first_seen = CASE WHEN media_findings.cleared_at IS NOT NULL THEN excluded.first_seen ELSE media_findings.first_seen END,
       cleared_at = NULL`
  ).bind(store, agent, key, severity, String(summary).slice(0, 500), data == null ? null : JSON.stringify(data), at, at).run();
  return !had || had.cleared_at != null;
}

/** Clear this agent's open findings for a store that were not seen in this run. */
export async function clearUnseen(db, { store, agent, keys, at, prefix = null }) {
  const { results } = await db.prepare(`SELECT key FROM media_findings WHERE store = ? AND agent = ? AND cleared_at IS NULL`).bind(store, agent).all();
  const keep = new Set(keys);
  let n = 0;
  for (const r of results || []) {
    if (keep.has(r.key)) continue;
    if (prefix && !r.key.startsWith(prefix)) continue;
    await db.prepare(`UPDATE media_findings SET cleared_at = ? WHERE store = ? AND agent = ? AND key = ?`).bind(at, store, agent, r.key).run();
    n += 1;
  }
  return n;
}

/* ---------------- events ---------------- */

/**
 * An error event, at most once an hour per agent+store (the job still retries). The message
 * has already been scrubbed of tokens by AdsSession.
 */
export async function logMediaError(db, { actor, store = null, message, nowMs }) {
  const since = new Date(nowMs - 60 * 60000).toISOString();
  const recent = await db.prepare(`SELECT id FROM events WHERE kind = 'error.media' AND actor = ? AND COALESCE(store, '') = ? AND at >= ? LIMIT 1`)
    .bind(actor, store || "", since).first().catch(() => null);
  if (recent) return false;
  await logEvent(db, {
    actor, kind: "error.media", store, target: "sys.ads",
    summary: `${store ? `${STORES[store] ? STORES[store].name : store}: ` : ""}Google Ads read failed; no numbers were stored for this run, it will retry (${String(message).slice(0, 220)})`,
    at: nowIso(nowMs),
  });
  return true;
}

/** "Google not connected" — logged once a day, so the page and the feed both say why nothing moves. */
export async function logNotWiredOnce(db, { reason, nowMs }) {
  const since = new Date(nowMs - 24 * 3600000).toISOString();
  const recent = await db.prepare(`SELECT id FROM events WHERE kind = 'media.not_wired' AND at >= ? LIMIT 1`).bind(since).first().catch(() => null);
  if (recent) return false;
  await logEvent(db, {
    actor: "media.performance", kind: "media.not_wired", target: "sys.ads",
    summary: `Media agents are waiting: ${reason}. Nothing is read or shown as zero until it is connected.`,
    at: nowIso(nowMs),
  });
  return true;
}

/* ---------------- proposals (what the brain WOULD do; never applied) ---------------- */

/** Open or refresh a proposal. Returns true if it is new (or re-opened). */
export async function upsertProposal(db, { store, agent, key, kind, title, detail = null, at }) {
  const had = await db.prepare(`SELECT status FROM media_proposals WHERE store = ? AND agent = ? AND key = ?`).bind(store, agent, key).first();
  await db.prepare(
    `INSERT INTO media_proposals (store, agent, key, kind, title, detail, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
     ON CONFLICT(store, agent, key) DO UPDATE SET title = excluded.title, detail = excluded.detail,
       status = 'open', updated_at = excluded.updated_at`
  ).bind(store, agent, key, kind, String(title).slice(0, 300), detail == null ? null : JSON.stringify(detail), at, at).run();
  return !had || had.status !== "open";
}

/** Open proposals of this agent for a store that were not proposed again in this run → stale. */
export async function staleUnseenProposals(db, { store, agent, keys, at }) {
  const { results } = await db.prepare(`SELECT key FROM media_proposals WHERE store = ? AND agent = ? AND status = 'open'`).bind(store, agent).all();
  const keep = new Set(keys);
  let n = 0;
  for (const r of results || []) {
    if (keep.has(r.key)) continue;
    await db.prepare(`UPDATE media_proposals SET status = 'stale', updated_at = ? WHERE store = ? AND agent = ? AND key = ?`).bind(at, store, agent, r.key).run();
    n += 1;
  }
  return n;
}

export const storeName = (id) => (STORES[id] ? STORES[id].name : id);
export const money = (n) => (n == null ? "unknown" : `$${Number(n).toFixed(2)}`);
export const ratio = (n) => (n == null ? "unknown" : `${Number(n).toFixed(2)}x`);
