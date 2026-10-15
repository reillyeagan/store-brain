/**
 * Payouts for the P&L page: per live store, when the next Shopify Payments payout comes and
 * the last few that were paid. Read-only, straight from the `payouts` table (filled hourly by
 * src/lib/payouts.js) and the payouts feed's freshness.
 *
 * What the date means: Shopify's `issuedAt`. For a SCHEDULED payout it is the day Shopify
 * will send it; for IN_TRANSIT / PAID it is the day it was sent. It is NOT the day the money
 * lands in the bank (that is usually 1-3 business days later and Shopify does not give it),
 * so the page calls it the "payout date" and never invents an arrival date.
 *
 * Freshness (rule 4): upcoming payouts are only shown as current while the payouts feed is
 * fresh. A stale or failing feed gives `upcoming: null` with the reason, because a payout
 * that was SCHEDULED at the last read may have been paid (or failed) since. Paid payouts are
 * history and stay shown, labelled with when they were read.
 * A store without Shopify Payments, or whose feed never delivered, is "not wired": null,
 * never $0.
 */
import { LIVE_STORE_IDS, STORES } from "../config/stores.js";
import { evaluateFeeds } from "./freshness.js";
import { localDay } from "./time.js";

/** Payouts that haven't reached the bank yet. */
export const UPCOMING = Object.freeze(["SCHEDULED", "IN_TRANSIT"]);
/** How many paid payouts each store shows. */
export const RECENT_PAID = 4;

const r2 = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);
const tzOf = (id) => (STORES[id] && STORES[id].timezone) || "America/New_York";

function shape(p, tz) {
  return {
    payout_id: p.payout_id,
    status: p.status || null,
    // The payout date in the store's own days (issued_at is a UTC moment).
    date: p.issued_at ? localDay(p.issued_at, tz) : null,
    issued_at: p.issued_at || null,
    net: r2(p.net),
    currency: p.currency || null,
    check: p.check_result || null,
  };
}

/** Sum of amounts per currency, so a EUR payout is never added to a USD one. */
function totals(list) {
  const out = {};
  for (const p of list) {
    if (p.net == null) continue;
    const c = p.currency || "USD";
    out[c] = r2((out[c] || 0) + p.net);
  }
  return out;
}

/**
 * @param store "all" or a live store id
 * @returns {{ok, store, stores:[{store, name, feed:{state,last_ok_at,last_error}, wired, current,
 *   why, next, upcoming, upcoming_total, paid, failed, balance}], upcoming_total, all_current}}
 */
export async function payoutsState(db, store = "all", { nowMs = Date.now(), feeds = null } = {}) {
  const ids = store === "all" ? [...LIVE_STORE_IDS] : LIVE_STORE_IDS.filter((id) => id === store);
  if (!ids.length) return { ok: false, error: "unknown store" };
  const feedRows = feeds || (await evaluateFeeds(db, nowMs));
  const out = [];
  for (const id of ids) {
    const tz = tzOf(id);
    const f = feedRows.find((x) => x.id === `shopify.payouts.${id}`);
    const state = f ? f.current || f.state || "not_wired" : "not_wired";
    const feed = { state, last_ok_at: (f && f.last_ok_at) || null, last_error: (f && f.last_error) || null };
    const { results } = await db.prepare(
      `SELECT payout_id, issued_at, status, net, currency, check_result FROM payouts WHERE store = ? ORDER BY issued_at DESC`
    ).bind(id).all();
    const rows = (results || []).map((p) => shape(p, tz));
    const wired = state !== "not_wired" || rows.length > 0;
    const current = state === "fresh";
    // Earliest first: the next one to go out is at the top.
    const pending = rows.filter((p) => UPCOMING.includes(String(p.status || "").toUpperCase()))
      .sort((a, b) => String(a.issued_at || "").localeCompare(String(b.issued_at || "")));
    const paid = rows.filter((p) => String(p.status || "").toUpperCase() === "PAID").slice(0, RECENT_PAID);
    const failed = rows.filter((p) => ["FAILED", "CANCELED", "CANCELLED"].includes(String(p.status || "").toUpperCase())).slice(0, 3);
    const noPayments = !rows.length && state === "not_wired"
      ? await db.prepare(`SELECT summary FROM events WHERE kind = 'payouts.unavailable' AND store = ? ORDER BY at DESC LIMIT 1`).bind(id).first().catch(() => null)
      : null;
    const why = current ? null
      : state === "not_wired" ? (noPayments ? "no Shopify Payments data for this store" : "payouts feed not wired")
      : `payouts feed ${state}${feed.last_ok_at ? `, last read ${feed.last_ok_at}` : ""}`;
    const balance = await db.prepare(`SELECT amount, currency, as_of FROM money_balances WHERE source = 'shopify_payments' AND store = ?`).bind(id).first();
    out.push({
      store: id, name: STORES[id].name, feed, wired, current, why,
      // Only a fresh read can say what is coming next (see the header).
      next: current ? pending[0] || null : null,
      upcoming: current ? pending : null,
      upcoming_total: current ? totals(pending) : null,
      paid, failed,
      balance: current && balance ? { amount: r2(balance.amount), currency: balance.currency, as_of: balance.as_of } : null,
    });
  }
  const allCurrent = out.every((s) => s.current);
  // The group total is only claimed when every store's feed is fresh (a partial sum would
  // understate what is coming, rule 5).
  const upcomingTotal = allCurrent ? totals(out.flatMap((s) => s.upcoming || [])) : null;
  return { ok: true, store, stores: out, all_current: allCurrent, upcoming_total: upcomingTotal };
}
