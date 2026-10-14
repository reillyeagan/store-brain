/**
 * media.spend_alarm — Spend Alarm. WATCH ONLY, plain code, no API calls (reads the ledger).
 *
 * Why: specified long ago, never built (vault: Q4 Plan item 15, Research Findings 2026-10-10).
 * Twice a store bled money unnoticed: Auberlane stopped spending on 09-27 (billing / paused
 * campaign), and spent 85-95 clicks a day with 0 orders on 10-11/12 (Memory Log 2026-10-13).
 *
 * What it judges, per store, about once an hour (Media's rotation slot):
 *   no_orders  — today's ad spend is at least SPEND_ALARM.noOrdersMinSpend and the store has 0
 *                Shopify orders today, from noOrdersFromHour in the STORE's timezone;
 *   runaway    — today's spend is already over usualMultiple x a normal full day (median of the
 *                last usualDays closed days) with 0 orders, at any hour;
 *   stopped    — a normally-spending account (see SPEND_ALARM) spent $0 on its last closed day,
 *                or $0 so far today after stoppedFromHour (account time): billing failed or a
 *                campaign was paused.
 * Thresholds and why: SPEND_ALARM in src/config/stores.js.
 *
 * Freshness first (rule 4): the Google Ads spend feed must be fresh (Freshness Sentinel's own
 * verdict on ads.spend.<store>) or nothing is judged; the store's order feed must be fresh for
 * the two "0 orders" checks (0 orders from a stale feed is not a claim). Then it says "can't
 * check" and why, once a day, instead of alarming.
 *
 * One alarm per store per day: the finding key is "alarm:<store-local day>", the event is
 * logged only when that finding is NEW (later conditions the same day refresh the finding's
 * text, never a second alarm). The event (kind media.spend_alarm) reaches the morning brief's
 * Risk list and the Event Log — the same path as feed alarms. Nothing is ever paused, raised
 * or changed in Google Ads: Guy runs the ads.
 * Inputs: feeds, ad_spend_days, orders. Outputs: media_findings (agent media.spend_alarm), events.
 */
import { logEvent } from "../../lib/eventlog.js";
import { feedState } from "../../lib/freshness.js";
import { localDay, nowIso } from "../../lib/time.js";
import { STORES, spendAlarmConfig } from "../../config/stores.js";
import { upsertFinding, clearUnseen, storeName, money, r2 } from "./common.js";

export const AGENT = "media.spend_alarm";

/** Hour of day (0-23) of a moment in a timezone. */
export function hourIn(nowMs, tz) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date(nowMs))) % 24;
}

export function median(xs) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * Is an account "normally spending" over these closed days? Needs a full window of rows
 * (a missing day is unknown, not $0), a median at or above the minimum, and enough days with
 * any spend. Returns {normal, usual}.
 */
export function normallySpending(days, cfg) {
  const w = days.slice(0, cfg.stoppedWindow);
  if (w.length < cfg.stoppedWindow) return { normal: false, usual: null, why: `only ${w.length} closed days on file` };
  const usual = median(w.map((d) => d.cost));
  const spent = w.filter((d) => d.cost > 0).length;
  return { normal: usual != null && usual >= cfg.stoppedMinUsual && spent >= cfg.stoppedNormalDays, usual };
}

/**
 * Pure: the alarms for one store right now.
 * `closed` = closed days, NEWEST FIRST ([{day, cost}]), `yesterday` = the account's last closed day.
 * Returns { alarms: [{key, summary}], notes: [...], usual }.
 */
export function judgeSpend({ cfg, spendToday, ordersToday, ordersFresh, storeHour, acctHour, closed, yesterday }) {
  const alarms = [];
  const notes = [];
  const usualDays = closed.slice(0, cfg.usualDays);
  const usual = usualDays.length >= 7 ? median(usualDays.map((d) => d.cost)) : null;
  if (!ordersFresh) notes.push("orders feed not fresh: the 0-orders checks were skipped");
  if (ordersFresh && ordersToday === 0) {
    if (spendToday >= cfg.noOrdersMinSpend && storeHour >= cfg.noOrdersFromHour) {
      alarms.push({ key: "no_orders", summary: `${money(r2(spendToday))} of ad spend today and 0 Shopify orders (it's past ${cfg.noOrdersFromHour}:00 store time)` });
    }
    if (usual != null && usual > 0 && spendToday > cfg.usualMultiple * usual) {
      alarms.push({ key: "runaway", summary: `${money(r2(spendToday))} spent today, over ${cfg.usualMultiple}x a normal day (${money(r2(usual))}), with 0 orders` });
    }
  }
  // Stopped: yesterday (closed) judged against the days before it; today against the closed days.
  const y = closed[0] && closed[0].day === yesterday ? closed[0] : null;
  if (y && y.cost === 0) {
    const n = normallySpending(closed.slice(1), cfg);
    if (n.normal) alarms.push({ key: "stopped", summary: `Ad spend stopped: $0.00 on ${y.day} on an account that normally spends ${money(r2(n.usual))}/day (billing failed or campaigns paused?)` });
  }
  if (spendToday === 0 && acctHour >= cfg.stoppedFromHour && !alarms.some((a) => a.key === "stopped")) {
    const n = normallySpending(closed, cfg);
    if (n.normal) alarms.push({ key: "stopped", summary: `Ad spend stopped: $0.00 so far today (after ${cfg.stoppedFromHour}:00 account time) on an account that normally spends ${money(r2(n.usual))}/day (billing failed or campaigns paused?)` });
  }
  return { alarms, notes, usual: usual == null ? null : r2(usual) };
}

async function feedRow(db, id) {
  return db.prepare(`SELECT * FROM feeds WHERE id = ?`).bind(id).first().catch(() => null);
}

/** "Can't check" once a day per store (finding kept open while it lasts; event at most daily). */
async function cantCheck(db, storeId, reason, nowMs) {
  const at = nowIso(nowMs);
  await upsertFinding(db, { store: storeId, agent: AGENT, key: "cant_check", severity: "warn", summary: `Spend alarm can't check: ${reason}`, at });
  const since = nowIso(nowMs - 24 * 3600000);
  const recent = await db.prepare(`SELECT id FROM events WHERE kind = 'media.spend_alarm_skipped' AND store = ? AND at >= ? LIMIT 1`).bind(storeId, since).first().catch(() => null);
  if (!recent) {
    await logEvent(db, { actor: AGENT, kind: "media.spend_alarm_skipped", store: storeId, target: "sys.ads", at,
      summary: `${storeName(storeId)}: spend alarm can't check (${reason}). No alarm is raised on data that isn't fresh.` });
  }
  return `can't check: ${reason}`;
}

export async function runSpendAlarm(env, { storeId, nowMs = Date.now() }) {
  const db = env.DB;
  const cfg = spendAlarmConfig(storeId);
  const ads = feedState(await feedRow(db, `ads.spend.${storeId}`), nowMs);
  if (ads !== "fresh") return cantCheck(db, storeId, `Google Ads spend feed is ${ads.replace("_", " ")}`, nowMs);
  const tzRow = await db.prepare(`SELECT account_tz FROM ad_spend_days WHERE store = ? AND account_tz IS NOT NULL ORDER BY day DESC LIMIT 1`).bind(storeId).first();
  if (!tzRow) return cantCheck(db, storeId, "no Google Ads days stored yet", nowMs);
  const acctTz = tzRow.account_tz;
  const storeTz = (STORES[storeId] && STORES[storeId].timezone) || "America/New_York";
  const acctToday = localDay(nowMs, acctTz);
  const storeToday = localDay(nowMs, storeTz);
  const todayRow = await db.prepare(`SELECT cost FROM ad_spend_days WHERE store = ? AND day = ?`).bind(storeId, acctToday).first();
  if (!todayRow) return cantCheck(db, storeId, `no Google Ads row for today (${acctToday}) yet`, nowMs);
  const { results } = await db.prepare(`SELECT day, cost FROM ad_spend_days WHERE store = ? AND day < ? ORDER BY day DESC LIMIT ?`)
    .bind(storeId, acctToday, Math.max(cfg.usualDays, cfg.stoppedWindow + 1)).all();
  const closed = (results || []).map((r) => ({ day: r.day, cost: Number(r.cost) }));
  const yesterday = new Date(Date.parse(`${acctToday}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const ordersFresh = feedState(await feedRow(db, `shopify.orders.${storeId}`), nowMs) === "fresh";
  const o = await db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE store = ? AND local_day = ?`).bind(storeId, storeToday).first();
  const ordersToday = Number((o && o.n) || 0);
  const spendToday = Number(todayRow.cost);
  const verdict = judgeSpend({
    cfg, spendToday, ordersToday, ordersFresh, storeHour: hourIn(nowMs, storeTz), acctHour: hourIn(nowMs, acctTz), closed, yesterday,
  });

  const at = nowIso(nowMs);
  const key = `alarm:${storeToday}`;
  // The page shows a "can't check" only while it's true.
  await clearUnseen(db, { store: storeId, agent: AGENT, keys: [], at, prefix: "cant_check" });
  // Yesterday's alarm stays in history (events); its finding closes when the day turns.
  await clearUnseen(db, { store: storeId, agent: AGENT, keys: [key], at, prefix: "alarm:" });
  if (!verdict.alarms.length) {
    return `ok: no alarm (spend today ${money(r2(spendToday))}, ${ordersFresh ? `${ordersToday} orders` : "orders feed not fresh"})`;
  }
  const summary = `${storeName(storeId)}: ${verdict.alarms.map((a) => a.summary).join("; ")}. Watch only: nothing was changed in Google Ads.`;
  const data = { day: storeToday, account_day: acctToday, alarms: verdict.alarms.map((a) => a.key), spend_today: r2(spendToday),
    orders_today: ordersFresh ? ordersToday : null, usual_day: verdict.usual, notes: verdict.notes };
  const isNew = await upsertFinding(db, { store: storeId, agent: AGENT, key, severity: "bad", summary, data, at });
  if (isNew) {
    await logEvent(db, { actor: AGENT, kind: "media.spend_alarm", store: storeId, target: "sys.ads", summary, data, at });
  }
  return `ok: ALARM ${verdict.alarms.map((a) => a.key).join("+")}${isNew ? "" : " (already raised today)"}`;
}
