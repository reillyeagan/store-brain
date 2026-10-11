/**
 * Google Ads spend puller — daily spend, clicks, impressions and conversion value per store.
 *
 * Why it re-pulls 7 days every hour: Google keeps adjusting recent days (invalid-click
 * credits, late conversions). Each pull RESTATES those days in place; a day is never
 * added twice because the ledger key is (store, day).
 *
 * Days are the AD ACCOUNT's days: Google reports `segments.date` in the account's own
 * timezone, so we ask the account for its `time_zone` and `currency_code`, store both
 * with every row, and work out "today" in that timezone. Never mixed with UTC.
 *
 * Access (researched 2026-10-11):
 *  - REST: POST https://googleads.googleapis.com/<version>/customers/<id>/googleAds:searchStream
 *  - Developer tokens were sunset on 2026-09-09; the API ignores them and will reject them
 *    in a future major version. Access now comes from the Google Cloud project behind the
 *    OAuth client. So the header is sent ONLY if GOOGLE_ADS_DEVELOPER_TOKEN is set.
 *  - `login-customer-id` is only for calls made through a manager account. Reilly is a
 *    user directly on each ad account, so it is not sent.
 *  - The version lives in the wrangler var GOOGLE_ADS_API_VERSION (Google sunsets each
 *    major version about a year after release; a sunset version fails with a plain message).
 *
 * Guy's fee is NOT computed here: this is raw spend only.
 */
import { LIVE_STORE_IDS, STORES } from "../config/stores.js";
import { getGoogleAccessToken } from "./google.js";
import { markFeedOk, markFeedFailed } from "./freshness.js";
import { logEvent } from "./eventlog.js";
import { localDay, nowIso } from "./time.js";

export const DEFAULT_ADS_API_VERSION = "v25";
export const ADS_DAYS_BACK = 7; // today (partial) + the 7 days before it

export class AdsError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AdsError";
    this.code = code;
  }
}

/** "25" or "v25" → "v25". Anything else is refused before a call is made. */
export function adsApiVersion(env) {
  const raw = String((env && env.GOOGLE_ADS_API_VERSION) || DEFAULT_ADS_API_VERSION).trim();
  const v = /^\d+$/.test(raw) ? `v${raw}` : raw;
  if (!/^v\d+$/.test(v)) {
    throw new AdsError(`GOOGLE_ADS_API_VERSION "${raw}" is not a version like "v25"; fix it in wrangler.toml`, "BAD_VERSION");
  }
  return v;
}

/** Config ids have dashes ("710-814-3649"); the API wants digits only. */
export const cleanCustomerId = (id) => String(id || "").replace(/\D/g, "");

/** YYYY-MM-DD minus n calendar days (pure date maths, no timezone involved). */
export function minusDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Never let credential material reach a stored error message or an event. */
export function scrubSecrets(text, extra = []) {
  let s = String(text == null ? "" : text);
  for (const v of extra) if (v && String(v).length >= 6) s = s.split(String(v)).join("[redacted]");
  return s
    .replace(/ya29\.[\w\-.~+/=]+/g, "[redacted]")
    .replace(/1\/\/[\w\-.~+/=]+/g, "[redacted]")
    .replace(/Bearer\s+[\w\-.~+/=]+/gi, "Bearer [redacted]")
    .slice(0, 300);
}

/** Pull the first useful error out of a Google Ads error body (object or streamed array). */
function adsErrorText(body) {
  const e = Array.isArray(body) ? (body.find((b) => b && b.error) || {}).error : body && body.error;
  if (!e) return null;
  const failure = (e.details || []).find((d) => d && Array.isArray(d.errors));
  const first = failure && failure.errors[0];
  const codeKey = first && first.errorCode ? Object.entries(first.errorCode).map(([k, v]) => `${k}=${v}`).join(",") : null;
  return [e.status, codeKey, (first && first.message) || e.message].filter(Boolean).join(": ");
}

/**
 * Run one GAQL query with searchStream. Returns the flat list of result rows.
 * searchStream answers with a JSON array of batches, each { results: [...] }.
 */
export async function adsQuery(env, customerId, query, { token, fetchImpl = fetch } = {}) {
  const version = adsApiVersion(env);
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  if (env.GOOGLE_ADS_DEVELOPER_TOKEN) headers["developer-token"] = env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const res = await fetchImpl(`https://googleads.googleapis.com/${version}/customers/${customerId}/googleAds:searchStream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON: handled below */ }
  const detail = adsErrorText(body);
  const versionProblem =
    (res.status === 404 && !body) ||
    /UNSUPPORTED_VERSION|version .*(deprecated|sunset|not supported|no longer)|deprecated.*version/i.test(detail || "");
  if (versionProblem) {
    throw new AdsError(
      `Google Ads API version ${version} is not supported (any more). Set GOOGLE_ADS_API_VERSION in wrangler.toml to a current version (see Google's sunset-dates page), then redeploy`,
      "UNSUPPORTED_VERSION"
    );
  }
  if (!res.ok || !body || detail) {
    throw new AdsError(scrubSecrets(`Google Ads HTTP ${res.status}${detail ? ` — ${detail}` : ""}`, [token, env.GOOGLE_ADS_DEVELOPER_TOKEN]), "ADS_HTTP");
  }
  const batches = Array.isArray(body) ? body : [body];
  return batches.flatMap((b) => (b && Array.isArray(b.results) ? b.results : []));
}

const int = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
};
const real = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Pure: turn result rows into one row per day for every day in [from, to].
 * Google omits days with no activity, so a missing day is written as zero spend:
 * the account answered for that range, and "nothing ran" is what it said (a claim, not a gap).
 */
export function parseSpendRows(rows, { from, to }) {
  const byDay = new Map();
  for (const r of rows) {
    const day = r && r.segments && r.segments.date;
    if (!day || day < from || day > to) continue;
    const m = r.metrics || {};
    const cur = byDay.get(day) || { day, cost: 0, clicks: 0, impressions: 0, conv_value: 0 };
    // Several rows for one day can come back (one per batch); add them, don't overwrite.
    cur.cost += int(m.costMicros) / 1e6;
    cur.clicks += int(m.clicks);
    cur.impressions += int(m.impressions);
    cur.conv_value += real(m.conversionsValue);
    byDay.set(day, cur);
  }
  const out = [];
  for (let d = from; d <= to; d = minusDays(d, -1)) {
    const v = byDay.get(d) || { day: d, cost: 0, clicks: 0, impressions: 0, conv_value: 0 };
    out.push({ ...v, cost: Math.round(v.cost * 100) / 100, conv_value: Math.round(v.conv_value * 100) / 100 });
  }
  return out;
}

/** Pull and restate one store. Throws on any API problem (caller decides how to record it). */
export async function pullStoreSpend(env, storeId, { token, fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const store = STORES[storeId];
  const cid = cleanCustomerId(store.adsCustomerId);
  const acct = await adsQuery(env, cid, "SELECT customer.id, customer.time_zone, customer.currency_code FROM customer", { token, fetchImpl });
  const c = acct[0] && acct[0].customer;
  if (!c || !c.timeZone) throw new AdsError(`Google Ads account ${store.adsCustomerId} returned no timezone`, "ADS_NO_TZ");
  const tz = c.timeZone;
  const currency = c.currencyCode || null;
  const to = localDay(nowMs, tz);
  const from = minusDays(to, ADS_DAYS_BACK);
  const rows = await adsQuery(
    env, cid,
    `SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions_value
     FROM customer WHERE segments.date BETWEEN '${from}' AND '${to}'`,
    { token, fetchImpl }
  );
  const days = parseSpendRows(rows, { from, to });
  const at = nowIso(nowMs);
  const restated = [];
  const had = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ad_spend_days WHERE store = ?`).bind(storeId).first();
  for (const d of days) {
    const before = await env.DB.prepare(`SELECT cost FROM ad_spend_days WHERE store = ? AND day = ?`).bind(storeId, d.day).first();
    await env.DB.prepare(
      `INSERT INTO ad_spend_days (store, day, cost, clicks, impressions, conv_value, currency, account_tz, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(store, day) DO UPDATE SET cost = excluded.cost, clicks = excluded.clicks,
         impressions = excluded.impressions, conv_value = excluded.conv_value, currency = excluded.currency,
         account_tz = excluded.account_tz, fetched_at = excluded.fetched_at`
    ).bind(storeId, d.day, d.cost, d.clicks, d.impressions, d.conv_value, currency, tz, at).run();
    // Today moves all day; that's expected. A change to a PAST day is worth a line,
    // because a restated day changes a P&L that may already have been read.
    if (before && d.day < to && Math.abs(Number(before.cost) - d.cost) >= 0.01) {
      restated.push({ day: d.day, before: Number(before.cost), after: d.cost });
    }
  }
  return { store: storeId, tz, currency, from, to, days, restated, initial: !had || Number(had.n) === 0, at };
}

/**
 * The hourly job: every live store with an ads account.
 * Google not connected → quiet (feeds stay "not wired"). Any other failure marks
 * that store's feed failed, with a message that never contains a token.
 */
export async function pullAdsSpend(env, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const stores = LIVE_STORE_IDS.filter((id) => STORES[id].adsCustomerId);
  const out = [];
  let token;
  try {
    token = await getGoogleAccessToken(env, { fetchImpl, nowMs });
  } catch (err) {
    if (err.code === "NOT_WIRED") return stores.map((id) => ({ store: id, ok: false, skipped: "google not connected" }));
    const msg = scrubSecrets(`Google sign-in failed: ${err.message}`);
    for (const id of stores) await markFeedFailed(env.DB, `ads.spend.${id}`, msg, nowIso(nowMs)).catch(() => {});
    return stores.map((id) => ({ store: id, ok: false, error: msg }));
  }
  for (const id of stores) {
    const store = STORES[id];
    const feed = `ads.spend.${id}`;
    try {
      const r = await pullStoreSpend(env, id, { token, fetchImpl, nowMs });
      // Only now: Google actually answered for this account.
      await markFeedOk(env.DB, feed, r.at);
      const money = (n) => `${n.toFixed(2)} ${r.currency || ""}`.trim();
      if (r.initial) {
        const total = r.days.reduce((s, d) => s + d.cost, 0);
        await logEvent(env.DB, {
          actor: "pnl.pullers", kind: "ads.imported", store: id, target: "sys.ads",
          summary: `${store.name}: Google Ads connected, imported ${r.days.length} days of spend (${money(total)}, ${r.from} to ${r.to}, account time ${r.tz})`,
          at: r.at,
        });
      } else if (r.restated.length) {
        await logEvent(env.DB, {
          actor: "pnl.pullers", kind: "ads.restated", store: id, target: "sys.ads",
          summary: `${store.name}: Google restated ad spend for ${r.restated.map((x) => `${x.day} ${x.before.toFixed(2)} → ${x.after.toFixed(2)}`).join(", ")}`,
          data: { restated: r.restated, currency: r.currency }, at: r.at,
        });
      }
      out.push({ store: id, ok: true, days: r.days.length, restated: r.restated.length, tz: r.tz, currency: r.currency });
    } catch (err) {
      const msg = scrubSecrets(err.message, [token, env.GOOGLE_ADS_DEVELOPER_TOKEN]);
      await markFeedFailed(env.DB, feed, msg, nowIso(nowMs)).catch(() => {});
      out.push({ store: id, ok: false, error: msg, code: err.code });
    }
  }
  return out;
}
