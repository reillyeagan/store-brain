/**
 * Google Ads HISTORY backfill — one time, chunked over runs (fix for the empty P&L days,
 * Reilly 2026-10-14: "why are there so many days missing info").
 *
 * Why: the hourly spend pull (adsSpend.js) only ever reads the last ADS_DAYS_BACK days, and
 * it was connected on 2026-10-11, so every older day had no ad spend row and no profit.
 * This reads each account's daily spend from HISTORY_FROM (2026-07-01) up to the day before
 * the hourly window, CHUNK_DAYS at a time, saving a cursor after each chunk. The API is the
 * authority: its rows replace any day that only had the sheet's figure (the P&L Sheets agent
 * then cross-checks the two and logs a difference over $0.50).
 *
 * Days before the account's FIRST SPEND are not written: Google returns nothing for them and
 * a store that was not advertising yet is not a P&L day worth a $0 claim.
 *
 * Limits: per store per run, 1 call for the account's timezone + at most CHUNKS_PER_RUN range
 * queries (one GAQL query returns every day of its range). 3 stores × 3 calls = 9 outside
 * calls, far inside a Worker run's subrequest limit and Google's per-account limits.
 */
import { LIVE_STORE_IDS, STORES, HISTORY_FROM } from "../config/stores.js";
import { getGoogleAccessToken } from "./google.js";
import { adsQuery, parseSpendRows, cleanCustomerId, minusDays, ADS_DAYS_BACK, scrubSecrets, upsertSpendDay, accountInfo } from "./adsSpend.js";
import { logEvent } from "./eventlog.js";
import { localDay, nowIso } from "./time.js";
import { unlimited } from "./callBudget.js";

export const CHUNK_DAYS = 31;
export const CHUNKS_PER_RUN = 2;
const ACTOR = "pnl.pullers";

/** Where the backfill stops: the day before the hourly pull's window starts. */
export const historyEnd = (today) => minusDays(today, ADS_DAYS_BACK + 1);

/**
 * One store's next chunk(s). Returns what it did. Throws on an API problem (the caller logs it
 * and the cursor stays where it was, so the same chunk is retried).
 */
export async function backfillStoreAds(env, storeId, { token, fetchImpl = fetch, nowMs = Date.now(), calls = null } = {}) {
  const db = env.DB;
  const store = STORES[storeId];
  const at = nowIso(nowMs);
  let st = await db.prepare(`SELECT * FROM ads_backfill WHERE store = ?`).bind(storeId).first();
  if (st && st.done_at) return { store: storeId, done: true, ran: false };
  if (!st) {
    await db.prepare(`INSERT INTO ads_backfill (store, from_day, cursor_day, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(store) DO NOTHING`)
      .bind(storeId, HISTORY_FROM, HISTORY_FROM, at).run();
    st = await db.prepare(`SELECT * FROM ads_backfill WHERE store = ?`).bind(storeId).first();
  }
  const cid = cleanCustomerId(store.adsCustomerId);
  const { tz, currency } = await accountInfo(env, cid, { token, fetchImpl });
  const end = historyEnd(localDay(nowMs, tz));
  let cursor = st.cursor_day, firstSpend = st.first_spend_day, written = 0, chunks = 0;
  const restated = [];
  while (cursor <= end && chunks < CHUNKS_PER_RUN && (!calls || calls.has(1))) {
    const to = [minusDays(cursor, -(CHUNK_DAYS - 1)), end].sort()[0];
    const rows = await adsQuery(env, cid,
      `SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions_value
       FROM customer WHERE segments.date BETWEEN '${cursor}' AND '${to}'`, { token, fetchImpl });
    const days = parseSpendRows(rows, { from: cursor, to });
    // What the hourly pull already stored for these days: re-reading them is fine (the API is the
    // authority and these are older, settled figures), but a change is a restatement and is said.
    const { results: had } = await db.prepare(`SELECT day, cost FROM ad_spend_days WHERE store = ? AND source = 'api' AND day >= ? AND day <= ?`).bind(storeId, cursor, to).all();
    const prevApi = new Map((had || []).map((r) => [r.day, Number(r.cost)]));
    for (const d of days) {
      if (!firstSpend && d.cost > 0) firstSpend = d.day;
      if (!firstSpend || d.day < firstSpend) continue;
      if (prevApi.has(d.day) && Math.abs(prevApi.get(d.day) - d.cost) >= 0.01) restated.push({ day: d.day, before: prevApi.get(d.day), after: d.cost });
      await upsertSpendDay(db, storeId, d, { currency, tz, at });
      written++;
    }
    cursor = minusDays(to, -1);
    chunks++;
    // Saved after every chunk: a run that stops half-way resumes here.
    await db.prepare(`UPDATE ads_backfill SET cursor_day = ?, first_spend_day = ?, days_written = days_written + ?, last_error = NULL, updated_at = ? WHERE store = ?`)
      .bind(cursor, firstSpend, written, at, storeId).run();
    written = 0;
  }
  if (restated.length) {
    await logEvent(db, {
      actor: ACTOR, kind: "ads.restated", store: storeId, target: "sys.ads",
      summary: `${store.name}: Google restated ad spend (history read) for ${restated.map((x) => `${x.day} ${x.before.toFixed(2)} → ${x.after.toFixed(2)}`).join(", ")}`,
      data: { restated, currency }, at,
    });
  }
  const done = cursor > end;
  if (done) {
    await db.prepare(`UPDATE ads_backfill SET done_at = ?, updated_at = ? WHERE store = ?`).bind(at, at, storeId).run();
    const total = await db.prepare(`SELECT days_written, first_spend_day FROM ads_backfill WHERE store = ?`).bind(storeId).first();
    await logEvent(db, {
      actor: ACTOR, kind: "ads.history_backfilled", store: storeId, target: "sys.ads",
      summary: `${store.name}: Google Ads history read back to ${total.first_spend_day || "(no spend found)"} (${total.days_written} days, account time ${tz}); the hourly pull keeps the last ${ADS_DAYS_BACK} days`,
      data: { first_spend_day: total.first_spend_day, days: total.days_written, to: end }, at,
    });
  }
  return { store: storeId, ran: true, done, chunks, cursor, first_spend_day: firstSpend };
}

/** The P&L department step: every live store with an ads account. Never throws. */
export async function runAdsHistory(env, { fetchImpl = fetch, nowMs = Date.now(), calls = null } = {}) {
  const stores = LIVE_STORE_IDS.filter((id) => STORES[id].adsCustomerId);
  const budget = calls || unlimited(fetchImpl);
  fetchImpl = budget.fetch;
  const done = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ads_backfill WHERE done_at IS NOT NULL`).first().catch(() => null);
  if (done && Number(done.n) >= stores.length) return { done: true };
  let token;
  try {
    token = await getGoogleAccessToken(env, { fetchImpl, nowMs });
  } catch (err) {
    return { skipped: err.code === "NOT_WIRED" ? "google not connected" : scrubSecrets(`Google sign-in failed: ${err.message}`) };
  }
  const out = [];
  for (const id of stores) {
    // The account's timezone + at least one chunk: otherwise stop cleanly, resume next run.
    if (!budget.has(2)) { out.push({ store: id, ran: false, skipped: "call budget for this run used up" }); continue; }
    try {
      out.push(await backfillStoreAds(env, id, { token, fetchImpl, nowMs, calls: budget }));
    } catch (err) {
      const msg = scrubSecrets(err.message, [token, env.GOOGLE_ADS_DEVELOPER_TOKEN]);
      await env.DB.prepare(`UPDATE ads_backfill SET last_error = ?, updated_at = ? WHERE store = ?`).bind(msg, nowIso(nowMs), id).run().catch(() => {});
      out.push({ store: id, ran: false, error: msg });
    }
  }
  return out;
}

export async function adsHistoryState(db) {
  const { results } = await db.prepare(`SELECT store, from_day, cursor_day, first_spend_day, days_written, done_at, last_error FROM ads_backfill ORDER BY store`).all().catch(() => ({ results: [] }));
  return results || [];
}
