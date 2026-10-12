/**
 * Daily P&L ledger — one row per live store per day, in the STORE's timezone.
 * Plain code, no AI. Computed only from the event tables in the ledger:
 *
 *   revenue   orders placed that day (order time in the store's timezone), gross of refunds
 *   refunds   refund events by the day they were PROCESSED (rule 7), SUCCESS and PENDING kept apart
 *   ads       Google Ads cost for that day (ad_spend_days)
 *   guy_fee   Guy's fee: rate x ads, only on days on/after his start date (config in stores.js)
 *   fees      Shopify Payments fees on that day's CHARGE balance transactions; null if the
 *             payouts feed isn't wired (null = unknown, never 0)
 *   cogs      ESTIMATE until KFB bills are wired: per-product cost from the Core when every
 *             line of an order has one, otherwise the store's measured COGS rate from the Core,
 *             otherwise 33% flagged loudly as ASSUMED. Never presented as actual.
 *   profit    revenue - refunds - cogs - ads - guy_fee - fees. Null if any of those is null;
 *             `profit_partial` then shows the same sum without the missing items, and
 *             notes.missing names them, so an unwired cost can never make a day look better.
 *
 * Revenue basis: each order's ORIGINAL total (Shopify's "total before returns"), because
 * refunds are booked separately on their processed day; the current total would subtract
 * a refund twice and on the wrong day. It comes from the stored payload: `total_price`
 * (webhook) or `totalPriceSet` (GraphQL pulls and the orders backfill). There is no
 * "current total + refunds" guess any more: an order without its original total makes
 * that day's revenue null (notes.unknown_total) until the backfill re-reads it.
 *
 * Excluded from revenue: Shopify test orders (payload `test: true`, both payload shapes)
 * and voided orders (payment authorised then voided: no money ever moved). Counts in notes.
 *
 * Rule 4, per input: an input whose feed is stale, failing past its age limit, or not
 * wired gives a NULL component (orders → revenue, orders, COGS; refunds; ads → ads and
 * Guy; payouts → fees), never a number computed from stale data. Profit is then null and
 * `profit_partial` is the sum of what is known; notes.missing names the missing parts and
 * notes.missing_why says why. A day before the store's order coverage (or any day before
 * the orders backfill has finished) has profit null too ("order_history").
 *
 * A row is `complete` only when: the day has ended in the store's timezone, every input
 * is usable, each input's last successful pull happened at least SETTLE_MIN after the
 * day ended (orders, refunds, ads 2 h; payouts/fees 6 h), the order history covers the day,
 * and profit is known. Today is always partial.
 *
 * When: the last 3 days are recomputed on the 15-minute cron at most once an hour
 * (job_runs "pnl.recompute"), and again at the day close (05:00 UTC cron, which is
 * 01:00 EDT / 00:00 EST, so "yesterday" is always the day that just ended). Google and
 * Shopify keep adjusting recent days; a closed day whose numbers move is marked `restated`.
 */
import { LIVE_STORE_IDS, STORES } from "../config/stores.js";
import { evaluateFeeds, ensureFeeds } from "./freshness.js";
import { claimJob } from "./jobRuns.js";
import { logEvent } from "./eventlog.js";
import { localDay, nowIso, endOfLocalDayMs } from "./time.js";
import { minusDays } from "./adsSpend.js";
import { orderCoverage, coveredDays } from "./orderBackfill.js";

/**
 * Break-even ROAS constants. Source: docs/specs/media.md, "true break-even ROAS
 * `1 / [margin × (1 − 0.119 refund) − 0.0334]`" (Reilly's formula, from the Eagano P&L).
 * 0.119 = refund rate allowance; 0.0334 = payment/other variable fees as a share of revenue.
 */
export const BREAKEVEN_REFUND_RATE = 0.119;
export const BREAKEVEN_FEE_RATE = 0.0334;
/** Used ONLY when the Core has no measured COGS rate for a store. Flagged "assumed" everywhere. */
export const FALLBACK_COGS_RATE = 0.33;
/**
 * EUR→USD used ONLY to turn the Core's measured "EUR per $1 of revenue" blanket rates into a
 * USD share until the card-alert FX feed is wired. 1.17 = the rate on the quoting sheets.
 * Always flagged as an estimate; replaced by the actual card rate (decision 2026-10-10).
 */
export const EUR_USD_ESTIMATE = 1.17;
/** How many days (today included) the hourly job recomputes. */
export const RECOMPUTE_DAYS = 3;
export const RECOMPUTE_EVERY_MIN = 60;
/** The refunds pull is hourly; its watermark older than this = stale. */
export const REFUNDS_MAX_AGE_MIN = 120;
/**
 * How long after a day ends each input's last successful pull must be before the day can
 * be complete: late orders, refunds and Google's own adjustments land in the first hours;
 * Shopify Payments fees settle later, so payouts wait 6 hours.
 */
export const SETTLE_MIN = Object.freeze({ orders: 120, refunds: 120, ads: 120, payouts: 360 });

const ACTOR = "pnl.ledger";
const r2 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 100) / 100);
const r4 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10000) / 10000);

export function storeTz(storeId) {
  return (STORES[storeId] && STORES[storeId].timezone) || "America/New_York";
}

/** Guy's fee for one day: null when ads are unknown, 0 before his start date. */
export function guyFeeFor(storeId, day, ads) {
  const s = STORES[storeId];
  if (ads == null) return null;
  if (!s || !s.guyFeeRate || !s.guyStart || day < s.guyStart) return 0;
  return r2(ads * s.guyFeeRate);
}

/** Break-even ROAS for a margin. Null when there's no margin or the store can't break even at any ROAS. */
export function breakevenRoas(margin) {
  if (margin == null || !Number.isFinite(margin)) return null;
  const d = margin * (1 - BREAKEVEN_REFUND_RATE) - BREAKEVEN_FEE_RATE;
  return d > 0 ? Math.round((1 / d) * 100) / 100 : null;
}

/* ---------------- the Core: COGS rate and per-product costs ---------------- */

/** "0.31", "31%", 31, {"rate":0.31} → 0.31. Anything outside (0, 1) after that → null. */
export function parseRate(value) {
  let v = value;
  if (typeof v === "string") {
    const t = v.trim();
    try { v = JSON.parse(t); } catch { v = t; }
  }
  if (v && typeof v === "object") v = v.rate ?? v.value ?? v.cogs_rate ?? null;
  if (typeof v === "string") {
    const pct = /%\s*$/.test(v);
    v = parseFloat(v);
    if (pct) v = v / 100;
  }
  let n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n > 1 && n < 100) n = n / 100; // "31" means 31%
  return n > 0 && n < 1 ? n : null;
}

/**
 * The store's MEASURED COGS rate from the Core. Keys containing "cogs" and "rate"
 * (e.g. "pnl.cogs_rate", "cogs.measured_rate"). Pricing BANDS ("cogs band 25-29%") are
 * targets, not measurements, and would flatter the estimate, so keys with "band" or
 * "target" are ignored. Store-specific beats all-stores; newest observation wins.
 */
export async function cogsRate(db, storeId) {
  const { results } = await db.prepare(
    `SELECT id, store, key, value, source, observed_at, stale_after FROM core_facts
      WHERE live = 1 AND (store = ? OR store IS NULL)
        AND lower(key) LIKE '%cogs%' AND lower(key) LIKE '%rate%'
        AND lower(key) NOT LIKE '%band%' AND lower(key) NOT LIKE '%target%'
      ORDER BY CASE WHEN store IS NULL THEN 1 ELSE 0 END, observed_at DESC, id DESC`
  ).bind(storeId).all();
  for (const f of results || []) {
    // The vault's measured blanket rates are text like "0.2849 EUR per $1 of revenue":
    // convert with the estimate FX (flagged) rather than silently falling back to 33%.
    const eur = /([0-9]*\.[0-9]+)\s*EUR\s+per\s+\$1/i.exec(String(f.value));
    if (eur) {
      const rate = Number(eur[1]) * EUR_USD_ESTIMATE;
      if (rate > 0 && rate < 1) {
        return { rate, assumed: false, source: `core:${f.key} (${eur[1]} EUR per $1 × ${EUR_USD_ESTIMATE} est. FX)`, factId: f.id,
          observed_at: f.observed_at, stale: !!(f.stale_after && f.stale_after < nowIso()) };
      }
    }
    const rate = parseRate(f.value);
    if (rate == null) continue;
    return { rate, assumed: false, source: `core:${f.key}`, factId: f.id, observed_at: f.observed_at,
      stale: !!(f.stale_after && f.stale_after < nowIso()) };
  }
  return { rate: FALLBACK_COGS_RATE, assumed: true, source: "ASSUMED 33% (no measured COGS rate in the Core)" };
}

/** Parse a per-product cost value: number, "12.40", {"usd":12.4} or {"cost":12.4}. USD only. */
function parseCost(value) {
  let v = value;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { /* plain text */ } }
  if (v && typeof v === "object") {
    if (v.currency && String(v.currency).toUpperCase() !== "USD") return null; // EUR needs the card rate first
    v = v.usd ?? v.cost ?? v.amount ?? null;
  }
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Per-product costs from the Core, as a Map of "sku:<SKU>" / "product:<GID>" → USD.
 * Key convention: "cost:sku:<SKU>" or "cost:product:<product GID>" (also accepts
 * "sku:<SKU>:cost"). The newest live fact wins.
 */
export async function productCosts(db, storeId) {
  const { results } = await db.prepare(
    `SELECT key, value FROM core_facts
      WHERE live = 1 AND (store = ? OR store IS NULL)
        AND (key LIKE 'cost:sku:%' OR key LIKE 'cost:product:%' OR (key LIKE 'sku:%' AND key LIKE '%:cost'))
      ORDER BY CASE WHEN store IS NULL THEN 0 ELSE 1 END, observed_at, id`
  ).bind(storeId).all();
  const map = new Map();
  for (const f of results || []) {
    const cost = parseCost(f.value);
    if (cost == null) continue;
    let k = null;
    if (f.key.startsWith("cost:sku:")) k = `sku:${f.key.slice(9)}`;
    else if (f.key.startsWith("cost:product:")) k = `product:${f.key.slice(13)}`;
    else k = `sku:${f.key.slice(4, -5)}`;
    map.set(k, cost); // later rows (store-specific, newer) overwrite
  }
  return map;
}

/* ---------------- freshness of each input ---------------- */

/**
 * State of every input for one store: fresh | stale | failing | not_wired (| none when the
 * store has no ad account), whether its data may be used (`usable`), and `pulled_at`, the
 * last successful pull (for day completeness).
 *  - A failing feed (latest attempt errored) stays usable while its last success is inside
 *    the age limit: a failed probe is evidence about the probe (rule 6), and the data is no
 *    older than a fresh feed's could be.
 *  - Refunds have no feed row: their freshness is the hourly refund pull's watermark in
 *    job_runs ("refunds.<store>"), which only moves after a successful read.
 *  - Orders: the feed is kept fresh by webhooks and the 15-minute pull, but neither reads
 *    every change; the orders backfill's last full read is the orders input's last pull.
 */
export async function inputFreshness(db, storeId, feeds, nowMs = Date.now()) {
  const pick = (id) => {
    const f = feeds.find((x) => x.id === id);
    if (!f) return { state: "not_wired", last_ok_at: null, pulled_at: null, usable: false };
    const state = f.current || f.state || "not_wired";
    const ageMin = f.last_ok_at ? (nowMs - Date.parse(f.last_ok_at)) / 60000 : Infinity;
    const usable = state === "fresh" || (state === "failing" && ageMin <= Number(f.max_age_min));
    return { state, last_ok_at: f.last_ok_at || null, pulled_at: f.last_ok_at || null, usable };
  };
  const mark = await db.prepare(`SELECT last_run_at FROM job_runs WHERE job = ?`).bind(`refunds.${storeId}`).first();
  let refunds = { state: "not_wired", last_ok_at: null, pulled_at: null, usable: false };
  if (mark && mark.last_run_at) {
    const age = (nowMs - Date.parse(mark.last_run_at)) / 60000;
    const state = age <= REFUNDS_MAX_AGE_MIN ? "fresh" : "stale";
    refunds = { state, last_ok_at: mark.last_run_at, pulled_at: mark.last_run_at, usable: state === "fresh" };
  }
  const cov = await orderCoverage(db, storeId);
  const orders = { ...pick(`shopify.orders.${storeId}`), pulled_at: cov.last_full_read_at };
  return {
    orders,
    ads: STORES[storeId] && STORES[storeId].adsCustomerId ? pick(`ads.spend.${storeId}`) : { state: "none", last_ok_at: null, pulled_at: null, usable: true },
    payouts: pick(`shopify.payouts.${storeId}`),
    refunds,
  };
}

/* ---------------- one store, one day ---------------- */

function safeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Original (pre-refund) order total from the stored payload. See "Revenue basis" at the
 * top. Null when the payload doesn't carry it: never guessed from the current total.
 */
export function orderGross(order) {
  const raw = safeJson(order.raw);
  const n = (v) => (v != null && Number.isFinite(parseFloat(v)) ? parseFloat(v) : null);
  if (raw) {
    const webhook = n(raw.total_price);
    if (webhook != null) return { gross: webhook, basis: "payload" };
    const gql = n(raw.totalPriceSet && raw.totalPriceSet.shopMoney && raw.totalPriceSet.shopMoney.amount);
    if (gql != null) return { gross: gql, basis: "totalPriceSet" };
  }
  return { gross: null, basis: "unknown" };
}

/**
 * Pure read: compute (don't store) one store's P&L for one day.
 * @returns {Promise<object>} the row, shaped like pnl_days
 */
export async function computeStoreDay(db, storeId, day, { nowMs = Date.now(), feeds = null, tz = storeTz(storeId) } = {}) {
  const feedRows = feeds || (await evaluateFeeds(db, nowMs));
  const fresh = await inputFreshness(db, storeId, feedRows, nowMs);
  const cov = await orderCoverage(db, storeId);
  const notes = { missing: [] };
  const why = {}; // component → why it is null
  const notUsable = (k) => `${k} ${fresh[k].state.replace("_", " ")}`;

  // --- Orders and revenue ---
  const { results: orders } = await db.prepare(
    `SELECT order_id, name, total, financial_status, raw FROM orders WHERE store = ? AND local_day = ?`
  ).bind(storeId, day).all();
  const counted = [];
  let excludedTest = 0, excludedVoided = 0, unknownTotal = 0;
  for (const o of orders || []) {
    const raw = safeJson(o.raw);
    if (raw && raw.test === true) { excludedTest++; continue; }
    if (String(o.financial_status || "").toLowerCase() === "voided") { excludedVoided++; continue; }
    const g = orderGross(o);
    if (g.gross == null) { unknownTotal++; continue; }
    counted.push({ ...o, gross: g.gross, basis: g.basis });
  }
  if (excludedTest) notes.excluded_test = excludedTest;
  if (excludedVoided) notes.excluded_voided = excludedVoided;
  if (unknownTotal) notes.unknown_total = unknownTotal;
  let revenue = null, orderCount = null;
  if (!fresh.orders.usable) why.revenue = notUsable("orders");
  else if (unknownTotal) why.revenue = `${unknownTotal} order${unknownTotal === 1 ? "" : "s"} without an original total (re-read by the orders backfill)`;
  else { revenue = r2(counted.reduce((s, o) => s + o.gross, 0)); orderCount = counted.length; }
  // Order history: a day the backfill hasn't covered may be missing orders.
  const covered = !!(cov.covered_from && cov.covered_from <= day);
  if (!covered) {
    why.order_history = cov.covered_from ? `order history only covers ${cov.covered_from} onwards` : "orders backfill not finished";
    notes.orders_incomplete = why.order_history;
  }

  // --- Refunds by processed day (rule 7) ---
  let refunds = null, refundsPending = null, refundsSuccess = null;
  // Days before the refunds' first full read are unknown, not $0 (rule 5).
  const refCov = await db.prepare(`SELECT covered_from FROM feed_coverage WHERE store = ? AND feed = 'refunds'`).bind(storeId).first().catch(() => null);
  const refundsCovered = !!(refCov && refCov.covered_from && refCov.covered_from <= day);
  if (fresh.refunds.usable && !refundsCovered) why.refunds = refCov && refCov.covered_from ? `refunds only read from ${refCov.covered_from}` : "first refund read not finished";
  else if (fresh.refunds.usable) {
    const ref = await db.prepare(
      `SELECT SUM(CASE WHEN status LIKE '%PENDING%' THEN amount ELSE 0 END) AS pending,
              SUM(CASE WHEN status LIKE '%PENDING%' THEN 0 ELSE amount END) AS settled
         FROM refunds WHERE store = ? AND local_day = ?`
    ).bind(storeId, day).first();
    refundsPending = r2(Number(ref && ref.pending) || 0);
    refundsSuccess = r2(Number(ref && ref.settled) || 0);
    refunds = r2(refundsPending + refundsSuccess);
  } else why.refunds = notUsable("refunds");

  // --- Ads + Guy ---
  const adRow = await db.prepare(`SELECT cost, clicks, account_tz, currency FROM ad_spend_days WHERE store = ? AND day = ?`).bind(storeId, day).first();
  let ads = null;
  if (!fresh.ads.usable) why.ads = notUsable("ads");
  else if (!adRow) why.ads = "no ad spend row for that day";
  else ads = r2(adRow.cost);
  if (adRow && adRow.account_tz && adRow.account_tz !== tz) notes.ads_tz = `ad account days are ${adRow.account_tz}, store days are ${tz}`;
  if (adRow && adRow.currency && adRow.currency !== "USD") notes.ads_currency = adRow.currency;
  const guyFee = guyFeeFor(storeId, day, ads);
  if (guyFee == null) why.guy_fee = "ads unknown";

  // --- Shopify Payments fees on that day's charges (UTC dates → store day) ---
  let fees = null;
  // Fees are only known from the day after the oldest balance transaction stored: older
  // days were never read, and a missing fee would flatter profit (rule 5).
  const oldest = await db.prepare(`SELECT MIN(date) AS d FROM balance_txns WHERE store = ? AND test = 0`).bind(storeId).first().catch(() => null);
  const feesFrom = oldest && oldest.d ? minusDays(localDay(oldest.d, tz), -1) : null;
  if (fresh.payouts.usable && !(feesFrom && feesFrom <= day)) why.fees = feesFrom ? `fees only read from ${feesFrom}` : "no balance transactions read yet";
  else if (fresh.payouts.usable) {
    const { results: txns } = await db.prepare(
      `SELECT date, fee FROM balance_txns WHERE store = ? AND test = 0 AND upper(type) = 'CHARGE' AND date >= ? AND date < ?`
    ).bind(storeId, `${minusDays(day, 1)}T00:00:00`, `${minusDays(day, -2)}T00:00:00`).all();
    fees = r2((txns || []).filter((t) => t.date && localDay(t.date, tz) === day).reduce((s, t) => s + (Number(t.fee) || 0), 0));
  } else why.fees = notUsable("payouts");

  // --- COGS (estimate) ---
  const rate = await cogsRate(db, storeId);
  const costs = await productCosts(db, storeId);
  let cogsEst = 0, perProduct = 0, byRate = 0;
  for (const o of counted) {
    let lineCost = null;
    if (costs.size) {
      const { results: lines } = await db.prepare(`SELECT sku, product_id, quantity FROM order_lines WHERE store = ? AND order_id = ?`).bind(storeId, o.order_id).all();
      if (lines && lines.length) {
        let sum = 0, all = true;
        for (const l of lines) {
          const q = Number(l.quantity) || 0;
          if (q <= 0) continue;
          const c = (l.sku && costs.get(`sku:${l.sku}`)) || (l.product_id && costs.get(`product:${l.product_id}`)) || null;
          if (c == null) { all = false; break; }
          sum += c * q;
        }
        if (all) lineCost = sum;
      }
    }
    if (lineCost != null) { cogsEst += lineCost; perProduct++; }
    else { cogsEst += o.gross * rate.rate; byRate++; }
  }
  cogsEst = revenue != null ? r2(cogsEst) : null;
  if (cogsEst == null) why.cogs = "revenue unknown";
  const cogsActual = null; // KFB bills are not wired yet (COGS Matcher)
  const cogs = cogsEst == null ? null : r2(cogsEst + (cogsActual || 0));
  const cogsSource = cogs == null || orderCount === 0 ? null : cogsActual ? (cogsEst ? "mixed" : "actual") : "estimate";
  const cogsShare = cogs ? r4(cogsEst / cogs) : null;
  const cogsBasis = {
    rate: rate.rate, rate_source: rate.source, rate_assumed: rate.assumed, rate_stale: !!rate.stale,
    orders_by_product_cost: perProduct, orders_by_rate: byRate,
  };
  if (rate.assumed && byRate > 0) notes.cogs_assumed = `COGS uses an ASSUMED ${Math.round(FALLBACK_COGS_RATE * 100)}% rate for ${byRate} order${byRate === 1 ? "" : "s"}`;

  // --- Profit ---
  const parts = { revenue, refunds, cogs, ads, guy_fee: guyFee, fees };
  for (const [k, v] of Object.entries(parts)) if (v == null) notes.missing.push(k);
  if (!covered) notes.missing.push("order_history");
  if (notes.missing.length) notes.missing_why = Object.fromEntries(notes.missing.map((k) => [k, why[k] || "unknown"]));
  const val = (v) => (v == null ? 0 : v);
  const partial = r2(val(revenue) - val(refunds) - val(cogs) - val(ads) - val(guyFee) - val(fees));
  const profit = notes.missing.length ? null : partial;
  const margin = revenue ? r4((revenue - val(cogs)) / revenue) : null;
  const roas = ads && revenue != null ? r2(revenue / ads) : null;

  // --- Completeness ---
  const endMs = endOfLocalDayMs(day, tz);
  const ended = nowMs >= endMs;
  const stale = Object.entries(fresh).filter(([, f]) => f.state !== "fresh" && f.state !== "none").map(([k, f]) => `${k} ${f.state}`);
  const unsettled = Object.entries(fresh)
    .filter(([k, f]) => f.state !== "none" && (!f.pulled_at || Date.parse(f.pulled_at) < endMs + SETTLE_MIN[k] * 60000))
    .map(([k]) => `${k} not pulled ${SETTLE_MIN[k] / 60} h after the day ended`);
  const complete = ended && stale.length === 0 && unsettled.length === 0 && covered && profit != null && !notes.unknown_total;
  if (!ended) notes.partial = "today: day not over";
  else if (unsettled.length) notes.unsettled = unsettled;
  if (stale.length) notes.stale_inputs = stale;

  return {
    store: storeId, day,
    revenue, orders: orderCount,
    refunds, refunds_success: refundsSuccess, refunds_pending: refundsPending,
    ads, clicks: adRow ? adRow.clicks : null, guy_fee: guyFee, services: guyFee, fees, chargebacks: null,
    cogs, cogs_est: cogsEst, cogs_actual: cogsActual, cogs_source: cogsSource, cogs_estimated_share: cogsShare, cogs_basis: cogsBasis,
    profit, profit_partial: partial, real_profit: null, // REAL profit: not defined in the Core yet (see report)
    margin, roas, breakeven_roas: breakevenRoas(margin),
    complete: complete ? 1 : 0,
    status: complete ? "closed" : "partial",
    freshness: fresh, notes,
    sources: {
      revenue: "orders (store-day of order time, original totals)", refunds: "refunds (processed day)",
      ads: "ad_spend_days", fees: "balance_txns CHARGE fees", cogs: "estimate (KFB bills not wired)",
      order_coverage: cov.covered_from,
      guy: STORES[storeId] ? { rate: STORES[storeId].guyFeeRate || 0, start: STORES[storeId].guyStart || null } : null,
    },
  };
}

const MONEY_FIELDS = ["revenue", "refunds", "cogs", "ads", "guy_fee", "fees", "profit"];

/** Store a computed row. A closed day whose money moves becomes "restated" (and is logged). */
export async function writePnlRow(db, row, at = nowIso()) {
  const before = await db.prepare(`SELECT * FROM pnl_days WHERE store = ? AND day = ?`).bind(row.store, row.day).first();
  const changed = before ? MONEY_FIELDS.filter((k) => (before[k] == null) !== (row[k] == null) || Math.abs(Number(before[k] || 0) - Number(row[k] || 0)) >= 0.01) : [];
  let status = row.status;
  if (before && (before.status === "closed" || before.status === "restated") && changed.length) status = "restated";
  else if (before && before.status === "restated" && row.complete) status = "restated";
  await db.prepare(
    `INSERT INTO pnl_days (store, day, revenue, cogs, cogs_estimated_share, ads, services, fees, refunds, chargebacks,
        profit, real_profit, orders, clicks, sessions, status, sources, updated_at,
        refunds_success, refunds_pending, guy_fee, cogs_est, cogs_actual, cogs_source, cogs_basis, profit_partial,
        margin, roas, breakeven_roas, complete, freshness, notes, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(store, day) DO UPDATE SET revenue = excluded.revenue, cogs = excluded.cogs,
        cogs_estimated_share = excluded.cogs_estimated_share, ads = excluded.ads, services = excluded.services,
        fees = excluded.fees, refunds = excluded.refunds, chargebacks = excluded.chargebacks, profit = excluded.profit,
        real_profit = excluded.real_profit, orders = excluded.orders, clicks = excluded.clicks, sessions = excluded.sessions,
        status = excluded.status, sources = excluded.sources, updated_at = excluded.updated_at,
        refunds_success = excluded.refunds_success, refunds_pending = excluded.refunds_pending, guy_fee = excluded.guy_fee,
        cogs_est = excluded.cogs_est, cogs_actual = excluded.cogs_actual, cogs_source = excluded.cogs_source,
        cogs_basis = excluded.cogs_basis, profit_partial = excluded.profit_partial, margin = excluded.margin,
        roas = excluded.roas, breakeven_roas = excluded.breakeven_roas, complete = excluded.complete,
        freshness = excluded.freshness, notes = excluded.notes, computed_at = excluded.computed_at`
  ).bind(row.store, row.day, row.revenue, row.cogs, row.cogs_estimated_share, row.ads, row.services, row.fees, row.refunds,
    row.chargebacks, row.profit, row.real_profit, row.orders, row.clicks, null, status, JSON.stringify(row.sources), at,
    row.refunds_success, row.refunds_pending, row.guy_fee, row.cogs_est, row.cogs_actual, row.cogs_source,
    JSON.stringify(row.cogs_basis), row.profit_partial, row.margin, row.roas, row.breakeven_roas, row.complete,
    JSON.stringify(row.freshness), JSON.stringify(row.notes), at).run();
  const restated = status === "restated" && changed.length > 0;
  if (restated) {
    await logEvent(db, {
      actor: ACTOR, kind: "pnl.restated", store: row.store,
      summary: `${STORES[row.store].name} P&L for ${row.day} restated: ` +
        changed.map((k) => `${k} ${fmt(before[k])} → ${fmt(row[k])}`).join(", "),
      data: { day: row.day, changed, before: Object.fromEntries(changed.map((k) => [k, before[k]])) }, at,
    });
  }
  return { status, restated, changed };
}

const fmt = (n) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);

/** Recompute the last `days` days (today included) for every live store. */
export async function recomputeDays(env, { nowMs = Date.now(), days = RECOMPUTE_DAYS, reason = "hourly" } = {}) {
  const db = env.DB;
  await ensureFeeds(db);
  const feeds = await evaluateFeeds(db, nowMs);
  const at = nowIso(nowMs);
  const out = [];
  for (const id of LIVE_STORE_IDS) {
    const today = localDay(nowMs, storeTz(id));
    for (let i = 0; i < days; i++) {
      const day = minusDays(today, i);
      const row = await computeStoreDay(db, id, day, { nowMs, feeds });
      const w = await writePnlRow(db, row, at);
      out.push({ store: id, day, status: w.status, complete: !!row.complete, profit: row.profit, revenue: row.revenue });
    }
  }
  return out;
}

/** The 15-minute cron step: recompute at most once an hour. */
export async function runPnlCron(env, { nowMs = Date.now() } = {}) {
  if (!LIVE_STORE_IDS.length) return { ran: false, reason: "no live stores" };
  if (!(await claimJob(env.DB, "pnl.recompute", RECOMPUTE_EVERY_MIN, nowMs))) return { ran: false, reason: "not due" };
  const rows = await recomputeDays(env, { nowMs });
  const closed = rows.filter((r) => r.complete).length;
  await env.DB.prepare(`UPDATE job_runs SET last_result = ? WHERE job = 'pnl.recompute'`)
    .bind(`ok: ${rows.length} rows, ${closed} complete`).run();
  return { ran: true, rows };
}

/**
 * The day close (05:00 UTC cron). 05:00 UTC is 01:00 EDT or 00:00 EST, so in both seasons
 * the store's "yesterday" is the day that just ended. Recompute the last 3 closed days
 * plus today, and log one line per store for the day that just closed.
 */
export async function runDayClose(env, { nowMs = Date.now() } = {}) {
  const rows = await recomputeDays(env, { nowMs, days: RECOMPUTE_DAYS + 1, reason: "close" });
  const at = nowIso(nowMs);
  for (const id of LIVE_STORE_IDS) {
    const y = minusDays(localDay(nowMs, storeTz(id)), 1);
    const r = await db1(env.DB, id, y);
    const notes = safeJson(r && r.notes) || {};
    await logEvent(env.DB, {
      actor: ACTOR, kind: "day.close", store: id,
      summary: `${STORES[id].name} ${y} closed: revenue ${fmt(r && r.revenue)}, profit ${r && r.profit != null ? fmt(r.profit) : `unknown (missing: ${(notes.missing || []).join(", ") || "inputs"})`}` +
        (r && r.cogs_source === "estimate" ? " (COGS estimated)" : "") +
        (r && r.complete ? "" : ` — not complete${[...(notes.stale_inputs || []), ...(notes.unsettled || [])].length ? `: ${[...(notes.stale_inputs || []), ...(notes.unsettled || [])].join(", ")}` : ""}`),
      data: { day: y, complete: !!(r && r.complete) }, at,
    });
  }
  return { rows };
}

const db1 = (db, store, day) => db.prepare(`SELECT * FROM pnl_days WHERE store = ? AND day = ?`).bind(store, day).first();

/* ---------------- reading back: rows, sums, Mission Control ---------------- */

/** pnl_days row → plain object with JSON columns parsed. */
export function parseRow(r) {
  if (!r) return null;
  return {
    ...r, complete: !!r.complete,
    cogs_basis: safeJson(r.cogs_basis), freshness: safeJson(r.freshness), notes: safeJson(r.notes) || {}, sources: safeJson(r.sources),
  };
}

/**
 * Sum several rows (days, or stores). A sum is null when any part is null: summing only
 * the known parts would understate costs, i.e. flatter (rule 5).
 */
export function sumRows(rows, label = null) {
  const keys = ["revenue", "orders", "refunds", "refunds_success", "refunds_pending", "ads", "guy_fee", "fees", "cogs", "cogs_est", "profit", "profit_partial"];
  const out = { label, days: rows.length, complete: rows.length > 0 && rows.every((r) => r.complete) };
  for (const k of keys) {
    out[k] = rows.length && rows.every((r) => r[k] != null) ? r2(rows.reduce((s, r) => s + Number(r[k]), 0)) : null;
  }
  out.cogs_estimated_share = out.cogs ? r4(out.cogs_est / out.cogs) : null;
  out.cogs_assumed = rows.some((r) => r.cogs_basis && r.cogs_basis.rate_assumed && r.cogs_basis.orders_by_rate > 0);
  out.margin = out.revenue ? r4((out.revenue - (out.cogs || 0)) / out.revenue) : null;
  out.roas = out.ads ? r2(out.revenue / out.ads) : null;
  out.breakeven_roas = breakevenRoas(out.margin);
  out.missing = [...new Set(rows.flatMap((r) => (r.notes && r.notes.missing) || []))];
  out.stale = [...new Set(rows.flatMap((r) => (r.notes && r.notes.stale_inputs) || []))];
  return out;
}

export async function rowsBetween(db, storeId, from, to) {
  const { results } = await db.prepare(`SELECT * FROM pnl_days WHERE store = ? AND day >= ? AND day <= ? ORDER BY day DESC`).bind(storeId, from, to).all();
  return (results || []).map(parseRow);
}

/** Days in [from, to] with no stored row (MTD can't be trusted if one is missing). */
function missingDays(rows, from, to) {
  const have = new Set(rows.map((r) => r.day));
  const gaps = [];
  for (let d = from; d <= to; d = minusDays(d, -1)) if (!have.has(d)) gaps.push(d);
  return gaps;
}

/**
 * The P&L tab: per live store and for the group — today (partial), yesterday, the last 7
 * closed days, month-to-date (1st of yesterday's month → yesterday).
 */
export async function pnlState(db, { nowMs = Date.now() } = {}) {
  const stores = [];
  const allMtdRows = [];
  for (const id of LIVE_STORE_IDS) {
    const today = localDay(nowMs, storeTz(id));
    const yesterday = minusDays(today, 1);
    const weekFrom = minusDays(today, 7);
    const monthFrom = `${yesterday.slice(0, 7)}-01`;
    const todayRow = parseRow(await db1(db, id, today));
    const yRow = parseRow(await db1(db, id, yesterday));
    const last7 = await rowsBetween(db, id, weekFrom, yesterday);
    const mtdRows = await rowsBetween(db, id, monthFrom, yesterday);
    allMtdRows.push(...mtdRows);
    const mtd = sumRows(mtdRows, `${monthFrom} to ${yesterday}`);
    mtd.missing_days = missingDays(mtdRows, monthFrom, yesterday);
    if (mtd.missing_days.length) { mtd.complete = false; mtd.profit = null; }
    const cd = coveredDays((await orderCoverage(db, id)).covered_from, monthFrom, yesterday);
    mtd.order_history_days = cd.covered;
    mtd.days_in_period = cd.total;
    stores.push({ id, name: STORES[id].name, today_day: today, today: todayRow, yesterday: yRow, last7, last7_sum: sumRows(last7, `${weekFrom} to ${yesterday}`), mtd });
  }
  const pick = (k) => stores.map((s) => s[k]).filter(Boolean);
  const group = {
    today: stores.length && stores.every((s) => s.today) ? sumRows(pick("today"), "today") : null,
    yesterday: stores.length && stores.every((s) => s.yesterday) ? sumRows(pick("yesterday"), "yesterday") : null,
    last7: sumRows(stores.flatMap((s) => s.last7), "last 7 days"),
    mtd: (() => {
      const m = sumRows(allMtdRows, "month to date");
      if (stores.some((s) => s.mtd.missing_days && s.mtd.missing_days.length)) { m.complete = false; m.profit = null; }
      return m;
    })(),
  };
  return { stores, group, guy: Object.fromEntries(LIVE_STORE_IDS.map((id) => [id, { rate: STORES[id].guyFeeRate || 0, start: STORES[id].guyStart || null }])) };
}
