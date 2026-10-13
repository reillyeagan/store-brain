/**
 * media.conversions — Conversion Integrity. SHADOW / WATCH ONLY. Plain code, no API calls.
 *
 * Does: per store, every few hours, compares what Google Ads CLAIMS (conversions and
 *   conversion value, summed over campaigns in media_campaign_days) with what Shopify REALLY
 *   took (orders and revenue in pnl_days) over the last 7 closed days, and flags:
 *    - "overclaim_value": Google claims more sales value than the store took from ALL channels
 *      (impossible if tracking is right — errors have run in the flattering direction, rule 5);
 *    - "overclaim_orders": Google counts more conversions than there were orders;
 *    - "tracking_broken": the last 3 closed days spent money and Google saw 0 conversions while
 *      Shopify had orders (the tag or the import is likely broken).
 *   It judges only when the Google side is fresh (performance pull within 8 hours) and the
 *   Shopify side has a P&L row for every day; otherwise it says "can't check" and why.
 * Inputs: media_campaign_days (from media.performance), pnl_days.
 * Outputs: media_findings (agent media.conversions; key "check" holds the latest comparison),
 *   one media.flag event per new flag and one media.checked event per run.
 * Note: Google days are the ad account's days, P&L days the store's days (both Eastern today).
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso, localDay } from "../../lib/time.js";
import { STORES } from "../../config/stores.js";
import { minusDays, r2, upsertFinding, clearUnseen, storeName, money } from "./common.js";

export const AGENT = "media.conversions";
export const CHECK_DAYS = 7;
export const MAX_GOOGLE_AGE_MIN = 8 * 60;
export const OVERCLAIM_RATIO = 1.1;

/**
 * Pure: compare day lists. google: [{day, conversions, conv_value, cost}], shop: [{day, orders, revenue}].
 * Returns { totals, flags: [{key, severity, summary}] }.
 */
export function compareDays(google, shop, { recentDays = 3, minOrders = 3 } = {}) {
  const g = { conversions: 0, value: 0, cost: 0 };
  const s = { orders: 0, revenue: 0 };
  for (const d of google) { g.conversions += d.conversions; g.value += d.conv_value; g.cost += d.cost; }
  for (const d of shop) { s.orders += Number(d.orders || 0); s.revenue += Number(d.revenue || 0); }
  const totals = {
    google_conversions: Math.round(g.conversions * 100) / 100, google_value: r2(g.value), cost: r2(g.cost),
    shopify_orders: s.orders, shopify_revenue: r2(s.revenue),
    value_ratio: s.revenue > 0 ? Math.round((g.value / s.revenue) * 1000) / 1000 : null,
  };
  const flags = [];
  if (g.value > s.revenue * OVERCLAIM_RATIO && g.value > 0) {
    flags.push({ key: "overclaim_value", severity: "bad",
      summary: `Google claims ${money(r2(g.value))} of sales; Shopify took ${money(r2(s.revenue))} from every channel. Google's ROAS is overstated` });
  }
  if (g.conversions > s.orders * OVERCLAIM_RATIO + 1) {
    flags.push({ key: "overclaim_orders", severity: "warn",
      summary: `Google counts ${totals.google_conversions} conversions; Shopify had ${s.orders} orders in total (duplicate or non-purchase conversions?)` });
  }
  const lastDays = [...new Set([...google.map((d) => d.day), ...shop.map((d) => d.day)])].sort().slice(-recentDays);
  const gRecent = google.filter((d) => lastDays.includes(d.day));
  const sRecent = shop.filter((d) => lastDays.includes(d.day));
  const recentConv = gRecent.reduce((x, d) => x + d.conversions, 0);
  const recentCost = gRecent.reduce((x, d) => x + d.cost, 0);
  const recentOrders = sRecent.reduce((x, d) => x + Number(d.orders || 0), 0);
  if (lastDays.length === recentDays && recentCost > 0 && recentConv === 0 && recentOrders >= minOrders) {
    flags.push({ key: "tracking_broken", severity: "bad",
      summary: `${money(r2(recentCost))} spent over the last ${recentDays} days with 0 Google conversions while Shopify had ${recentOrders} orders: tracking looks broken` });
  }
  return { totals, flags };
}

export async function runConversions(env, { storeId, nowMs = Date.now() }) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const tz = (STORES[storeId] && STORES[storeId].timezone) || "America/New_York";
  const to = minusDays(localDay(nowMs, tz), 1);
  const from = minusDays(to, CHECK_DAYS - 1);

  const fresh = await db.prepare(`SELECT MAX(fetched_at) AS f, MIN(day) AS first FROM media_campaign_days WHERE store = ?`).bind(storeId).first();
  const ageMin = fresh && fresh.f ? (nowMs - Date.parse(fresh.f)) / 60000 : null;
  const cantCheck = async (why) => {
    // The comparison is unknown, not "fine": keep the open flags as they are and say why.
    await upsertFinding(db, { store: storeId, agent: AGENT, key: "check", severity: "info", at,
      summary: `${storeName(storeId)}: can't check conversions: ${why}`, data: { status: "unknown", why, window: { from, to } } });
    return `can't check: ${why}`;
  };
  if (ageMin == null) return cantCheck("no Google campaign data yet");
  if (ageMin > MAX_GOOGLE_AGE_MIN) return cantCheck(`Google campaign data is ${Math.round(ageMin / 60)}h old`);
  if (fresh.first > from) return cantCheck(`Google campaign data starts ${fresh.first}, after the window start ${from}`);

  const { results: gRows } = await db.prepare(
    `SELECT day, SUM(conversions) AS conversions, SUM(conv_value) AS conv_value, SUM(cost) AS cost
     FROM media_campaign_days WHERE store = ? AND day >= ? AND day <= ? GROUP BY day`
  ).bind(storeId, from, to).all();
  const { results: sRows } = await db.prepare(
    `SELECT day, orders, revenue FROM pnl_days WHERE store = ? AND day >= ? AND day <= ? AND revenue IS NOT NULL AND orders IS NOT NULL`
  ).bind(storeId, from, to).all();
  if ((sRows || []).length < CHECK_DAYS) return cantCheck(`Shopify P&L has ${(sRows || []).length} of ${CHECK_DAYS} days`);
  const google = (gRows || []).map((r) => ({ day: r.day, conversions: Number(r.conversions), conv_value: Number(r.conv_value), cost: Number(r.cost) }));
  const { totals, flags } = compareDays(google, sRows);

  const keys = ["check"];
  for (const f of flags) {
    keys.push(f.key);
    const summary = `${storeName(storeId)}: ${f.summary} (${from} to ${to})`;
    if (await upsertFinding(db, { store: storeId, agent: AGENT, key: f.key, severity: f.severity, summary, data: { ...totals, window: { from, to } }, at })) {
      await logEvent(db, { actor: AGENT, kind: "media.flag", store: storeId, target: "sys.ads", summary, data: { key: f.key }, at });
    }
  }
  const status = flags.length ? (flags.some((f) => f.severity === "bad") ? "bad" : "warn") : "ok";
  await upsertFinding(db, { store: storeId, agent: AGENT, key: "check", severity: "info", at,
    summary: `${storeName(storeId)}: Google ${totals.google_conversions} conversions / ${money(totals.google_value)} vs Shopify ${totals.shopify_orders} orders / ${money(totals.shopify_revenue)} (${from} to ${to})`,
    data: { status, ...totals, window: { from, to } } });
  await clearUnseen(db, { store: storeId, agent: AGENT, keys, at });
  await logEvent(db, {
    actor: AGENT, kind: "media.checked", store: storeId, target: "sys.ads", at,
    summary: `${storeName(storeId)}: conversion check ${status}: Google ${money(totals.google_value)} claimed vs Shopify ${money(totals.shopify_revenue)} taken (${from} to ${to})`,
    data: { status, ...totals },
  });
  return `ok: ${status}`;
}
