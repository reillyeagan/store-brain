/**
 * Shopify funnel feed (part of pnl.pullers, Data Pullers) — plain code, read only.
 *
 * What it does: per live store, hourly, asks Shopify (ShopifyQL, Admin GraphQL
 * `shopifyqlQuery`, scope read_reports) for daily sessions → added to cart → reached checkout
 * → completed checkout for the last FUNNEL_DAYS days, and stores one row per store-day in
 * `funnel_days`. Shopify reports days in the shop's timezone (the stores are all Eastern, the
 * same as the P&L days).
 * Not wired is never zero (rule 4): no credentials, scope not granted, or a query error →
 * `funnel_runs.state` = not_wired / error with the reason, and NO rows are written.
 * `funnelFor()` gives the page/integrator the days; a group day is summed only when every
 * live store has that day, and data older than FUNNEL_MAX_AGE_MIN is not used.
 * Inputs: Shopify (read only, via Store Guard). Outputs: funnel_days, funnel_runs, events.
 */
import { LIVE_STORE_IDS, STORES } from "../../config/stores.js";
import { shopifyGraphQL } from "../../lib/storeGuard.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso, localDay } from "../../lib/time.js";
import { loggedWithin } from "../core/shared.js";

const ACTOR = "pnl.pullers";
export const FUNNEL_DAYS = 30;
export const FUNNEL_MAX_AGE_MIN = 180; // pulled hourly; three missed pulls = stale, not used

export const FUNNEL_SHOPIFYQL =
  `FROM sessions SHOW sessions, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout ` +
  `TIMESERIES day SINCE -${FUNNEL_DAYS - 1}d UNTIL today ORDER BY day ASC`;

export const FUNNEL_QUERY = `query Funnel($q: String!) {
  shopifyqlQuery(query: $q) { parseErrors tableData { columns { name dataType } rows } }
}`;

const int = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};

/** Pure: ShopifyQL rows → [{day, sessions, cart_sessions, checkout_sessions, converted_sessions}]. */
export function parseFunnelRows(table) {
  if (!table || !Array.isArray(table.rows)) return null;
  const out = [];
  for (const r of table.rows) {
    const rawDay = r.day ?? r.date ?? null;
    const day = rawDay ? String(rawDay).slice(0, 10) : null;
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    out.push({
      day,
      sessions: int(r.sessions),
      cart_sessions: int(r.sessions_with_cart_additions),
      checkout_sessions: int(r.sessions_that_reached_checkout),
      converted_sessions: int(r.sessions_that_completed_checkout),
    });
  }
  return out;
}

/** The ShopifyQL columns the funnel needs. */
export const FUNNEL_COLUMNS = Object.freeze(["sessions", "sessions_with_cart_additions", "sessions_that_reached_checkout", "sessions_that_completed_checkout"]);
const FIELD = { sessions: "sessions", sessions_with_cart_additions: "cart_sessions", sessions_that_reached_checkout: "checkout_sessions", sessions_that_completed_checkout: "converted_sessions" };

/** Pure: expected columns absent from the answer's column list or null on any row. */
export function missingColumns(table, rows) {
  const names = table && Array.isArray(table.columns) && table.columns.length ? new Set(table.columns.map((c) => c && c.name)) : null;
  return FUNNEL_COLUMNS.filter((c) => (names && !names.has(c)) || rows.some((r) => r[FIELD[c]] == null));
}

/** Pure: converted / sessions, null unless both are known (and sessions > 0). */
export const conversionRate = (converted, sessions) =>
  converted == null || sessions == null || !(sessions > 0) ? null : Math.round((converted / sessions) * 10000) / 10000;

/** Why a failure means "not wired" rather than a broken pull. */
function notWiredReason(err) {
  const m = String((err && err.message) || err);
  if (err && err.code === "NOT_WIRED") return m;
  if (err && err.code === "STORE_NOT_LIVE") return m;
  if (/access denied|read_reports|not approved|scope|ACCESS_DENIED|unauthori[sz]ed/i.test(m)) return `read_reports not granted on this store's app (${m.slice(0, 160)})`;
  return null;
}

async function setRun(db, store, state, reason, at, ok) {
  await db.prepare(
    `INSERT INTO funnel_runs (store, state, reason, last_ok_at, last_try_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(store) DO UPDATE SET state = excluded.state, reason = excluded.reason, last_try_at = excluded.last_try_at,
       last_ok_at = COALESCE(excluded.last_ok_at, funnel_runs.last_ok_at)`
  ).bind(store, state, reason, ok ? at : null, at).run();
}

export async function pullStoreFunnel(env, storeId, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  let data;
  try {
    data = await shopifyGraphQL(env, storeId, FUNNEL_QUERY, { q: FUNNEL_SHOPIFYQL }, { fetchImpl, nowMs });
  } catch (err) {
    const nw = notWiredReason(err);
    const before = await db.prepare(`SELECT state FROM funnel_runs WHERE store = ?`).bind(storeId).first();
    await setRun(db, storeId, nw ? "not_wired" : "error", nw || String(err && err.message).slice(0, 300), at, false);
    // Logged once when the state changes (not wired) or at most hourly (errors): no flooding.
    if (nw && (!before || before.state !== "not_wired")) {
      await logEvent(db, { actor: ACTOR, kind: "funnel.not_wired", store: storeId, target: "sys.shopify", summary: `${STORES[storeId].name} funnel not wired: ${nw}`, at });
    } else if (!nw && !(await loggedWithin(db, ACTOR, "error.funnel_pull", 60, nowMs))) {
      await logEvent(db, { actor: ACTOR, kind: "error.funnel_pull", store: storeId, target: "sys.shopify", summary: `${STORES[storeId].name} funnel pull failed; retrying next hour (${String(err && err.message).slice(0, 160)})`, at });
    }
    return { store: storeId, state: nw ? "not_wired" : "error", reason: nw || String(err && err.message) };
  }
  const q = data && data.shopifyqlQuery;
  const errs = q && Array.isArray(q.parseErrors) ? q.parseErrors.filter(Boolean) : [];
  const rows = q && !errs.length ? parseFunnelRows(q.tableData) : null;
  // Every expected column must be there on every row: a missing column is not "0 carts".
  const gap = rows ? missingColumns(q.tableData, rows) : [];
  if (!rows || gap.length) {
    const reason = errs.length ? `ShopifyQL: ${errs.join("; ").slice(0, 250)}` : !rows ? "no table in the answer" : `Shopify's answer is missing ${gap.join(", ")}`;
    await setRun(db, storeId, "error", reason, at, false);
    if (!(await loggedWithin(db, ACTOR, "error.funnel_pull", 60, nowMs))) {
      await logEvent(db, { actor: ACTOR, kind: "error.funnel_pull", store: storeId, target: "sys.shopify", summary: `${STORES[storeId].name} funnel: ${reason}`, at });
    }
    return { store: storeId, state: "error", reason };
  }
  const today = localDay(nowMs, STORES[storeId].timezone);
  for (const r of rows) {
    await db.prepare(
      `INSERT INTO funnel_days (store, day, sessions, cart_sessions, checkout_sessions, converted_sessions, partial, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(store, day) DO UPDATE SET sessions = excluded.sessions, cart_sessions = excluded.cart_sessions,
         checkout_sessions = excluded.checkout_sessions, converted_sessions = excluded.converted_sessions,
         partial = excluded.partial, fetched_at = excluded.fetched_at`
    ).bind(storeId, r.day, r.sessions, r.cart_sessions, r.checkout_sessions, r.converted_sessions, r.day >= today ? 1 : 0, at).run();
  }
  const before = await db.prepare(`SELECT state FROM funnel_runs WHERE store = ?`).bind(storeId).first();
  await setRun(db, storeId, "wired", null, at, true);
  if (!before || before.state !== "wired") {
    await logEvent(db, { actor: ACTOR, kind: "funnel.wired", store: storeId, target: "sys.shopify", summary: `${STORES[storeId].name} funnel is wired: ${rows.length} days of sessions read from Shopify`, at });
  }
  return { store: storeId, state: "wired", days: rows.length };
}

export async function pullFunnel(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const out = [];
  for (const id of LIVE_STORE_IDS) out.push(await pullStoreFunnel(env, id, { nowMs, fetchImpl }));
  return out;
}

const next = (d) => new Date(Date.parse(`${d}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
const KEYS = ["sessions", "cart_sessions", "checkout_sessions", "converted_sessions"];

/**
 * Funnel days for one live store or 'all', from..to inclusive (YYYY-MM-DD).
 *  - A store whose funnel isn't wired, or whose last good pull is older than
 *    FUNNEL_MAX_AGE_MIN, gives no numbers (`wired:false` / `stale:true`, with the reason).
 *  - 'all': a day is summed only when every live store has it; otherwise its numbers are null
 *    and `missing_stores` names who's missing. Totals are null if any day is null.
 */
export async function funnelFor(db, store, from, to, { nowMs = Date.now() } = {}) {
  const ids = store === "all" ? [...LIVE_STORE_IDS] : LIVE_STORE_IDS.filter((id) => id === store);
  if (!ids.length) return { ok: false, error: "unknown store" };
  const status = {};
  for (const id of ids) {
    const r = await db.prepare(`SELECT * FROM funnel_runs WHERE store = ?`).bind(id).first();
    const age = r && r.last_ok_at ? (nowMs - Date.parse(r.last_ok_at)) / 60000 : Infinity;
    status[id] = !r || !r.last_ok_at ? { usable: false, state: r ? r.state : "not_wired", reason: (r && r.reason) || "never pulled" }
      : age > FUNNEL_MAX_AGE_MIN ? { usable: false, state: "stale", reason: `last good pull ${r.last_ok_at}`, last_ok_at: r.last_ok_at }
      : { usable: true, state: "wired", last_ok_at: r.last_ok_at, latest_error: r.state !== "wired" ? r.reason : null };
  }
  const usable = ids.filter((id) => status[id].usable);
  const rows = new Map();
  if (usable.length) {
    const marks = usable.map(() => "?").join(", ");
    const { results } = await db.prepare(`SELECT * FROM funnel_days WHERE store IN (${marks}) AND day >= ? AND day <= ?`).bind(...usable, from, to).all();
    for (const r of results || []) rows.set(`${r.store}|${r.day}`, r);
  }
  const days = [];
  let guard = 0;
  for (let d = from; d <= to && guard < 400; d = next(d), guard++) {
    const parts = ids.map((id) => (status[id].usable ? rows.get(`${id}|${d}`) : null));
    const missing = ids.filter((id, i) => !parts[i]);
    const day = { day: d, partial: parts.some((p) => p && p.partial), missing_stores: missing };
    for (const k of KEYS) day[k] = missing.length ? null : parts.reduce((s, p) => (s == null || p[k] == null ? null : s + p[k]), 0);
    day.conversion_rate = conversionRate(day.converted_sessions, day.sessions);
    days.push(day);
  }
  const totals = {};
  for (const k of KEYS) totals[k] = days.length && days.every((d) => d[k] != null) ? days.reduce((s, d) => s + d[k], 0) : null;
  totals.conversion_rate = conversionRate(totals.converted_sessions, totals.sessions);
  return { ok: true, store, from, to, wired: ids.every((id) => status[id].usable), status, days, totals };
}

export async function funnelState(db, { nowMs = Date.now() } = {}) {
  const { results } = await db.prepare(`SELECT * FROM funnel_runs`).all();
  const runs = Object.fromEntries((results || []).map((r) => [r.store, r]));
  return {
    stores: LIVE_STORE_IDS.map((id) => ({ store: id, state: runs[id] ? runs[id].state : "not_wired", reason: runs[id] ? runs[id].reason : "not pulled yet", last_ok_at: runs[id] ? runs[id].last_ok_at : null })),
    note: `Needs the read_reports scope on each store's app. Not wired is shown as "not wired", never as 0 sessions. Stale after ${FUNNEL_MAX_AGE_MIN} min.`,
    now: nowIso(nowMs),
  };
}
