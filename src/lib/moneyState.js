/**
 * The Money tab's data for /api/state: per live store, ad spend (today so far, yesterday,
 * last 7 days), Shopify balance + recent payouts, refunds by processed day, and the
 * state of each money feed. Read-only, straight from the ledger.
 *
 * Nulls stay nulls: a store whose ads feed never delivered shows "not wired", never $0.
 */
import { LIVE_STORE_IDS, STORES } from "../config/stores.js";
import { localDay } from "./time.js";
import { minusDays } from "./adsSpend.js";

const r2 = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);

export async function moneyState(db, feeds, nowMs = Date.now()) {
  const feedState = (id) => {
    const f = feeds.find((x) => x.id === id);
    return f ? { state: f.current || f.state, last_ok_at: f.last_ok_at, last_error: f.last_error } : { state: "not_wired" };
  };
  const stores = [];
  for (const id of LIVE_STORE_IDS) {
    const store = STORES[id];
    const tz = store.timezone || "America/New_York";

    // Ads: days are the ad account's days, so "today" is worked out in account_tz.
    // From the API's own rows: a day filled from the sheet carries no account facts of its own.
    const acct = await db.prepare(`SELECT account_tz, currency FROM ad_spend_days WHERE store = ? AND source = 'api' ORDER BY fetched_at DESC LIMIT 1`).bind(id).first();
    let ads = null;
    if (acct) {
      const today = localDay(nowMs, acct.account_tz || tz);
      const yesterday = minusDays(today, 1);
      const weekFrom = minusDays(today, 7);
      const oneDay = (d) => db.prepare(`SELECT cost, clicks, conv_value FROM ad_spend_days WHERE store = ? AND day = ?`).bind(id, d).first();
      const t = await oneDay(today);
      const y = await oneDay(yesterday);
      const w = await db.prepare(
        `SELECT COUNT(*) AS days, SUM(cost) AS cost, SUM(clicks) AS clicks, SUM(conv_value) AS conv_value
         FROM ad_spend_days WHERE store = ? AND day >= ? AND day <= ?`
      ).bind(id, weekFrom, yesterday).first();
      ads = {
        currency: acct.currency, account_tz: acct.account_tz, today_day: today,
        today: t ? { cost: r2(t.cost), clicks: t.clicks, conv_value: r2(t.conv_value) } : null,
        yesterday: y ? { day: yesterday, cost: r2(y.cost), clicks: y.clicks, conv_value: r2(y.conv_value) } : null,
        last7: w && w.days ? { from: weekFrom, to: yesterday, days: w.days, cost: r2(w.cost), clicks: w.clicks, conv_value: r2(w.conv_value) } : null,
      };
    }

    const balance = await db.prepare(`SELECT amount, currency, as_of FROM money_balances WHERE source = 'shopify_payments' AND store = ?`).bind(id).first();
    const { results: payouts } = await db.prepare(
      `SELECT payout_id, issued_at, status, net, currency, check_result FROM payouts WHERE store = ? ORDER BY issued_at DESC LIMIT 6`
    ).bind(id).all();

    // Refunds by processed day (store timezone), last 7 days including today.
    const today = localDay(nowMs, tz);
    const from = minusDays(today, 6);
    const { results: byDay } = await db.prepare(
      `SELECT local_day, COUNT(*) AS n, SUM(amount) AS amount,
              SUM(CASE WHEN status LIKE '%PENDING%' THEN 1 ELSE 0 END) AS pending_n,
              SUM(CASE WHEN status LIKE '%PENDING%' THEN amount ELSE 0 END) AS pending_amount
       FROM refunds WHERE store = ? AND local_day >= ? GROUP BY local_day ORDER BY local_day DESC`
    ).bind(id, from).all();
    const { results: pending } = await db.prepare(
      `SELECT refund_id, order_id, processed_at, local_day, amount, status FROM refunds
       WHERE store = ? AND status LIKE '%PENDING%' ORDER BY processed_at DESC LIMIT 20`
    ).bind(id).all();

    stores.push({
      id, name: store.name,
      ads, adsFeed: feedState(`ads.spend.${id}`),
      balance: balance ? { amount: r2(balance.amount), currency: balance.currency, as_of: balance.as_of } : null,
      payouts: (payouts || []).map((p) => ({ ...p, net: r2(p.net) })),
      payoutsFeed: feedState(`shopify.payouts.${id}`),
      refunds: {
        from, to: today,
        byDay: (byDay || []).map((d) => ({ day: d.local_day, n: d.n, amount: r2(d.amount), pending_n: d.pending_n, pending_amount: r2(d.pending_amount) })),
        pending: (pending || []).map((p) => ({ ...p, amount: r2(p.amount) })),
      },
    });
  }
  return { stores };
}
