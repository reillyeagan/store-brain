/**
 * Freshness Sentinel — no number is used unless its feed is fresh.
 *
 * Why: the Auberlane spend feed sat dead for 9 days and nothing noticed; dashboards
 * went stale for days because a duty depended on someone remembering. Here every
 * feed has an age limit, and a check runs on its own every 15 minutes.
 *
 * States:
 *   not_wired — never delivered (shown as an absence, never as zero)
 *   fresh     — delivered within its limit
 *   stale     — last success is older than its limit
 *   failing   — the latest attempt errored after the last success
 */
import { LIVE_STORE_IDS, STORES } from "../config/stores.js";
import { nowIso } from "./time.js";
import { logEvent } from "./eventlog.js";

/** The feeds the brain expects, per live store. Limits in minutes. */
export function expectedFeeds() {
  const feeds = [];
  for (const id of LIVE_STORE_IDS) {
    const name = STORES[id].name;
    feeds.push({ id: `shopify.orders.${id}`, store: id, label: `${name} — Shopify orders`, max_age_min: 30 });
    feeds.push({ id: `shopify.payouts.${id}`, store: id, label: `${name} — Shopify payouts`, max_age_min: 6 * 60 });
    feeds.push({ id: `ads.spend.${id}`, store: id, label: `${name} — Google Ads spend`, max_age_min: 90 });
  }
  feeds.push({ id: "kfb.morning_sweep", store: null, label: "KungFuBuy morning sweep", max_age_min: 26 * 60 });
  // Marked OK only when 17TRACK itself answers (quota read hourly, tracking reads as due).
  // Never marked at all without TRACKING_API_KEY, so it shows "not wired", not zero.
  feeds.push({ id: "tracking.17track", store: null, label: "17TRACK parcel tracking", max_age_min: 8 * 60 });
  return feeds;
}

/** Pure: decide the state of one feed row at a moment. */
export function feedState(row, nowMs = Date.now()) {
  if (!row || !row.wired || !row.last_ok_at) {
    if (row && row.last_try_at && row.last_error) return "failing";
    return "not_wired";
  }
  const okMs = Date.parse(row.last_ok_at);
  const tryMs = row.last_try_at ? Date.parse(row.last_try_at) : 0;
  if (row.last_error && tryMs > okMs) return "failing";
  const ageMin = (nowMs - okMs) / 60000;
  return ageMin <= Number(row.max_age_min) ? "fresh" : "stale";
}

/** Make sure every expected feed has a row (new feeds start as not wired). */
export async function ensureFeeds(db) {
  for (const f of expectedFeeds()) {
    await db
      .prepare(
        `INSERT INTO feeds (id, store, label, max_age_min, wired) VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, max_age_min = excluded.max_age_min`
      )
      .bind(f.id, f.store, f.label, f.max_age_min)
      .run();
  }
}

export async function markFeedOk(db, feedId, atIso = nowIso()) {
  const upd = () => db
    .prepare(`UPDATE feeds SET wired = 1, last_ok_at = ?, last_try_at = ?, last_error = NULL WHERE id = ?`)
    .bind(atIso, atIso, feedId)
    .run();
  const res = await upd();
  // First delivery before the sentinel has ever run: create the feed rows, then record it.
  if (res.meta && res.meta.changes === 0) {
    await ensureFeeds(db);
    const again = await upd();
    if (again.meta && again.meta.changes === 0) throw new Error(`markFeedOk: unknown feed "${feedId}"`);
  }
}

export async function markFeedFailed(db, feedId, error, atIso = nowIso()) {
  await db
    .prepare(`UPDATE feeds SET last_try_at = ?, last_error = ? WHERE id = ?`)
    .bind(atIso, String(error).slice(0, 300), feedId)
    .run();
}

/** All feeds with their current state. */
export async function evaluateFeeds(db, nowMs = Date.now()) {
  const { results } = await db.prepare(`SELECT * FROM feeds ORDER BY id`).all();
  // A closed store's feeds (Auberlane, Marlowe: 2026-10-27) are left out: nothing reads them any
  // more, so they would only ever turn "stale" and raise alarms about a store that is gone.
  return (results || []).filter((r) => !r.store || !STORES[r.store] || STORES[r.store].live).map((r) => ({ ...r, current: feedState(r, nowMs) }));
}

/**
 * The scheduled check. Logs an event only when a feed CHANGES state, so a dead
 * feed raises one clear alarm instead of one every 15 minutes.
 */
export async function runSentinel(db, nowMs = Date.now()) {
  await ensureFeeds(db);
  const feeds = await evaluateFeeds(db, nowMs);
  const changes = [];
  for (const f of feeds) {
    if (f.current !== f.state) {
      await db.prepare(`UPDATE feeds SET state = ? WHERE id = ?`).bind(f.current, f.id).run();
      // A brand-new feed that isn't wired yet is expected during setup: record it silently.
      if (!f.state && f.current === "not_wired") continue;
      changes.push(f);
      const alarming = f.current === "stale" || f.current === "failing";
      await logEvent(db, {
        actor: "svc.freshness",
        kind: alarming ? "feed.alarm" : "feed.state",
        store: f.store,
        summary: `${f.label}: ${f.state || "new"} → ${f.current}${f.last_error ? ` (${f.last_error})` : ""}`,
        data: { feed: f.id, from: f.state || null, to: f.current, last_ok_at: f.last_ok_at },
        at: nowIso(nowMs),
      });
    }
  }
  return { feeds, changes };
}
