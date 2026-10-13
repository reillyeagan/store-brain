/**
 * Tracking Sync + fulfillment checks — plain code, no AI (docs/specs/fulfillment.md).
 *
 * Shopify only holds the tracking number; the carrier's real story comes from 17TRACK.
 * Every 15-minute cron calls runTracking(), which self-throttles:
 *
 *   collect   hourly    read fulfillments (tracking numbers) of the last 30 days' orders
 *   register  hourly    hand NEW numbers to 17TRACK, once each, never past the quota
 *   poll      each run  re-read numbers not delivered yet, at most every 6 h per number
 *                       (sooner when a verified 17TRACK push says something changed)
 *   checks    each run  stuck pickup · failed delivery · day 15 · day 20 · proof of delivery
 *
 * Shadow-safe: nothing here contacts a customer or changes an order. Findings become
 * events, flags on Mission Control's Shipping tab, a `pickup` line in the KFB copy-paste
 * message, and (day 20) an approval for Reilly. Nothing executes on its own.
 *
 * Quota: the 17TRACK account has 200 free registrations. A number is registered once,
 * only if its order is from the last 30 days, and a rejection is never retried
 * automatically. A re-registration attempt (e.g. after a crash between the API call and
 * our write) is answered "already registered" by 17TRACK, which spends nothing.
 * The first collection finds a month of parcels at once, so registration is guarded:
 *   - newest first (the ones still on the road matter most);
 *   - never a parcel Shopify already reports DELIVERED, never one shipped 21+ days ago;
 *   - at most TRACKING_REGISTER_CAP registrations in total (default 60) until Reilly
 *     raises that variable in Cloudflare;
 *   - the last QUOTA_RESERVE registrations are kept for parcels shipped in the last
 *     few days, so the backlog can never use up what new orders need.
 * A parcel that isn't tracked still gets day-15 / day-20 flags from its order date.
 */
import { LIVE_STORE_IDS, STORES, parcelTrackingOn, PARCEL_TRACKING_DECISION } from "../config/stores.js";
import { seedDecision } from "../agents/core/decisions.js";
import { shopifyGraphQL } from "./storeGuard.js";
import { logEvent } from "./eventlog.js";
import { markFeedOk, markFeedFailed } from "./freshness.js";
import { createApproval } from "./approvals.js";
import { backup } from "./backupVault.js";
import { localDay, nowIso } from "./time.js";
import {
  getQuota, register, getTrackInfo, verifyPush, summarise, mapStatus, STATE_LABELS,
  MAX_PER_CALL, CALL_GAP_MS, ERR_ALREADY_REGISTERED, Track17Error,
} from "./track17.js";

export const TRACKING_TZ = "America/New_York";
export const FEED_ID = "tracking.17track";
const ACTOR = "ful.tracking";
const LATE_ACTOR = "ful.late";
const SYS = "sys.17track";

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** Only orders this recent are collected and registered (quota is precious). */
export const LOOKBACK_DAYS = 30;
/** Collection runs at most this often. A little under an hour so cron jitter can't skip a slot. */
export const COLLECT_EVERY_MS = 55 * MIN;
/** A number not delivered yet is re-read at most this often (unless a push asks sooner). */
export const POLL_EVERY_MS = 6 * HOUR;
/** Per run caps, so a backlog can't blow through the rate limit or the Worker's time. */
export const MAX_POLL_PER_RUN = 120;
export const MAX_REGISTER_PER_RUN = 120;
/** A status older than this is not used for a flag (rule 4: freshness before numbers). */
export const STATUS_FRESH_MS = 24 * HOUR;
/** Spec: shipped, no carrier pickup 3 days after KFB ships. */
export const PICKUP_STUCK_DAYS = 3;
export const DAY15 = 15;
export const DAY20 = 20;
/** Mission Control warns when fewer registrations than this are left. */
export const QUOTA_LOW = 20;
/** The backlog never spends the last this-many registrations; they're kept for new parcels. */
export const QUOTA_RESERVE = 20;
/** "New parcel" for the reserve: shipped within this many days. */
export const NEW_PARCEL_DAYS = 3;
/** A parcel shipped this long ago isn't registered: it's arrived or it's a day-20 case already. */
export const MAX_REGISTER_AGE_DAYS = 21;
/** Total registrations allowed until Reilly sets TRACKING_REGISTER_CAP higher in Cloudflare. */
export const DEFAULT_REGISTER_CAP = 60;
/** Refused (bad-signature) pushes are counted and summarised in the log at most this often. */
export const PUSH_REJECT_LOG_EVERY_MS = HOUR;
/** Shopify's own word that a fulfillment arrived (FulfillmentDisplayStatus, Admin API 2026-07). */
export const SHOPIFY_DELIVERED = new Set(["DELIVERED", "PICKED_UP"]);
/** Shopify query: 25 orders × (1 + 3 fulfillments × (1 + 2 tracking)) ≈ 250 points, far under 1,000. */
export const ORDERS_PER_PAGE = 25;
export const MAX_PAGES = 8;

export const FULFILLMENTS_QUERY = `query RecentFulfillments($q: String!, $after: String) {
  orders(first: ${ORDERS_PER_PAGE}, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt
      fulfillments(first: 3) {
        id createdAt status displayStatus deliveredAt
        trackingInfo(first: 2) { number company url }
      }
    }
  }
}`;

/** Fulfillments in these states never shipped anything. */
const DEAD_FULFILLMENTS = new Set(["CANCELLED", "ERROR", "FAILURE"]);

export const FLAG_LABELS = Object.freeze({
  stuck_pickup: "Not picked up by the carrier",
  failed_delivery: "Delivery failed — customer email needed",
  pickup_ready: "Waiting at pickup point — customer email needed",
  day15: "Day-15 heads-up email due",
  day20: "Escalate: reship or refund",
  day20_verify: "Day 20+, not tracked: verify manually",
});

/**
 * Day-20 approvals (fix after review, 2026-10-11): an approval asks Reilly to spend money
 * (reship or refund), so it needs real evidence. Only a parcel 17TRACK is tracking with a
 * fresh status counts. Untracked parcels (quota, age, rejected) and orders older than
 * DAY20_MAX_AGE_DAYS get a "verify manually" flag on the Shipping tab instead. At most
 * DAY20_APPROVALS_PER_RUN new approvals per run, so a backlog can't flood Reilly's phone;
 * the rest wait (their flag stays open without an approval) and are asked on later runs.
 */
export const DAY20_MAX_AGE_DAYS = 45;
export const DAY20_APPROVALS_PER_RUN = 5;

const storeName = (id) => (STORES[id] ? STORES[id].name : id);
const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));
const liveMarks = () => LIVE_STORE_IDS.map(() => "?").join(", ");

export function normaliseNumber(n) {
  const s = String(n == null ? "" : n).replace(/\s+/g, "").toUpperCase();
  return /^[A-Z0-9-]{6,50}$/.test(s) ? s : null;
}

/** Whole Eastern calendar days from the order's Eastern date to today's Eastern date. */
export function easternDaysSince(orderIso, nowMs = Date.now()) {
  const a = Date.parse(`${localDay(orderIso, TRACKING_TZ)}T00:00:00Z`);
  const b = Date.parse(`${localDay(nowMs, TRACKING_TZ)}T00:00:00Z`);
  return Math.round((b - a) / DAY);
}

/** "Oct 8" in Eastern time, for messages people read. */
export function shortDate(iso) {
  if (!iso) return "date unknown";
  return new Intl.DateTimeFormat("en-US", { timeZone: TRACKING_TZ, month: "short", day: "numeric" }).format(new Date(iso));
}

/* ---------------- throttle ---------------- */

/** Claim a stage atomically if it hasn't run within `everyMs`. Two overlapping crons can't both win. */
export async function claimStage(db, stage, nowMs, everyMs) {
  await db.prepare(`INSERT INTO tracking_runs (stage) VALUES (?) ON CONFLICT(stage) DO NOTHING`).bind(stage).run();
  const res = await db.prepare(
    `UPDATE tracking_runs SET last_run_at = ? WHERE stage = ? AND (last_run_at IS NULL OR last_run_at <= ?)`
  ).bind(nowIso(nowMs), stage, nowIso(nowMs - everyMs)).run();
  return !!(res.meta && res.meta.changes === 1);
}

async function stageOk(db, stage, atIso, detail) {
  await db.prepare(`INSERT INTO tracking_runs (stage) VALUES (?) ON CONFLICT(stage) DO NOTHING`).bind(stage).run();
  await db.prepare(`UPDATE tracking_runs SET last_ok_at = ?, detail = COALESCE(?, detail) WHERE stage = ?`)
    .bind(atIso, detail == null ? null : JSON.stringify(detail), stage).run();
}

async function stageRow(db, stage) {
  const r = await db.prepare(`SELECT * FROM tracking_runs WHERE stage = ?`).bind(stage).first();
  if (!r) return null;
  let detail = null;
  try { detail = r.detail ? JSON.parse(r.detail) : null; } catch { detail = null; }
  return { ...r, detail };
}

/* ---------------- 1. collect tracking numbers from Shopify ---------------- */

/** Flatten an order node into shipment rows (one per tracking number). */
export function shipmentsFromOrderNode(n) {
  const out = [];
  for (const f of (n && Array.isArray(n.fulfillments) ? n.fulfillments : [])) {
    if (!f || DEAD_FULFILLMENTS.has(String(f.status || "").toUpperCase())) continue;
    for (const t of (Array.isArray(f.trackingInfo) ? f.trackingInfo : [])) {
      const number = normaliseNumber(t && t.number);
      if (!number) continue;
      out.push({
        order_id: n.id, order_name: n.name || null, order_created_at: n.createdAt || null,
        fulfillment_id: f.id || null, tracking_number: number,
        carrier_hint: t.company || null, tracking_url: t.url || null, shipped_at: f.createdAt || null,
        shopify_status: f.displayStatus || null, shopify_delivered_at: f.deliveredAt || null,
      });
    }
  }
  return out;
}

async function upsertShipment(db, storeId, s, at) {
  const had = await db.prepare(`SELECT store, order_id FROM shipments WHERE tracking_number = ?`).bind(s.tracking_number).first();
  if (had && (had.store !== storeId || had.order_id !== s.order_id)) return "conflict";
  if (had) {
    await db.prepare(
      `UPDATE shipments SET order_name = COALESCE(?, order_name), carrier_hint = COALESCE(?, carrier_hint),
              tracking_url = COALESCE(?, tracking_url), shopify_status = COALESCE(?, shopify_status),
              shopify_delivered_at = COALESCE(shopify_delivered_at, ?), updated_at = ? WHERE tracking_number = ?`
    ).bind(s.order_name, s.carrier_hint, s.tracking_url, s.shopify_status || null, s.shopify_delivered_at || null, at, s.tracking_number).run();
    return "seen";
  }
  await db.prepare(
    `INSERT INTO shipments (store, order_id, order_name, order_created_at, fulfillment_id, tracking_number,
                            carrier_hint, tracking_url, shipped_at, shopify_status, shopify_delivered_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tracking_number) DO NOTHING`
  ).bind(storeId, s.order_id, s.order_name, s.order_created_at, s.fulfillment_id, s.tracking_number,
    s.carrier_hint, s.tracking_url, s.shipped_at, s.shopify_status || null, s.shopify_delivered_at || null, at).run();
  return "new";
}

export async function collectShipments(env, { nowMs = Date.now(), fetchImpl } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const since = new Date(nowMs - LOOKBACK_DAYS * DAY).toISOString().slice(0, 10);
  const opts = fetchImpl ? { fetchImpl } : {};
  const results = [];
  for (const id of LIVE_STORE_IDS) {
    const r = { store: id, ok: true, orders: 0, numbers: 0, added: 0, conflicts: 0 };
    try {
      let after = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const data = await shopifyGraphQL(env, id, FULFILLMENTS_QUERY, { q: `created_at:>=${since}`, after }, opts);
        const conn = data && data.orders;
        for (const node of (conn && Array.isArray(conn.nodes) ? conn.nodes : [])) {
          r.orders++;
          for (const s of shipmentsFromOrderNode(node)) {
            r.numbers++;
            const res = await upsertShipment(db, id, s, at);
            if (res === "new") r.added++;
            if (res === "conflict") r.conflicts++;
          }
        }
        if (!conn || !conn.pageInfo || !conn.pageInfo.hasNextPage) break;
        after = conn.pageInfo.endCursor;
      }
    } catch (err) {
      if (err.code === "NOT_WIRED") { results.push({ store: id, ok: false, skipped: "not wired" }); continue; }
      r.ok = false; r.error = String(err.message).slice(0, 200);
      await logEvent(db, {
        actor: ACTOR, kind: "error.tracking_collect", store: id, target: "sys.shopify",
        summary: `${storeName(id)}: couldn't read tracking numbers from Shopify; will retry next hour (${r.error})`, at,
      });
    }
    results.push(r);
  }
  const added = results.filter((r) => r.added);
  if (added.length) {
    const total = added.reduce((n, r) => n + r.added, 0);
    await logEvent(db, {
      actor: ACTOR, kind: "tracking.collected", target: "sys.shopify",
      summary: `Found ${total} new tracking number${total === 1 ? "" : "s"} in Shopify (${added.map((r) => `${storeName(r.store)} ${r.added}`).join(", ")})`,
      data: { results }, at,
    });
  }
  const conflicts = results.reduce((n, r) => n + (r.conflicts || 0), 0);
  if (conflicts) {
    await logEvent(db, {
      actor: ACTOR, kind: "tracking.number_conflict", target: "sys.shopify",
      summary: `${conflicts} tracking number${conflicts === 1 ? " is" : "s are"} on more than one order; kept the first order and ignored the rest`,
      data: { results }, at,
    });
  }
  return results;
}

/* ---------------- 2. register with 17TRACK (quota-guarded) ---------------- */

async function saveQuota(db, quota, at) {
  const prev = await stageRow(db, "quota");
  await stageOk(db, "quota", at, { ...quota, checked_at: at });
  const was = prev && prev.detail ? prev.detail.remain : null;
  // One alarm when it crosses the line, not one per hour.
  if (quota.remain != null && quota.remain < QUOTA_LOW && (was == null || was >= QUOTA_LOW)) {
    await logEvent(db, {
      actor: ACTOR, kind: "tracking.quota_low", target: SYS,
      summary: `17TRACK: only ${quota.remain} tracking registrations left${quota.total != null ? ` of ${quota.total}` : ""}. New parcels stop being tracked at 0.`,
      data: quota, at,
    });
  }
}

/** SQL: Shopify already says this parcel arrived. */
const SHOPIFY_DELIVERED_SQL =
  `(shopify_delivered_at IS NOT NULL OR UPPER(COALESCE(shopify_status, '')) IN (${[...SHOPIFY_DELIVERED].map((s) => `'${s}'`).join(", ")}))`;

export const isShopifyDelivered = (p) =>
  !!(p && (p.shopify_delivered_at || SHOPIFY_DELIVERED.has(String(p.shopify_status || "").toUpperCase())));

/** The total-registrations cap: TRACKING_REGISTER_CAP if Reilly set a number, else 60. */
export function registerCap(env) {
  const raw = env && env.TRACKING_REGISTER_CAP;
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_REGISTER_CAP;
}

/**
 * Which waiting parcels to register now: newest first, and only parcels shipped in the
 * last NEW_PARCEL_DAYS may use the reserve. Pure, so the rule is easy to test.
 * @returns {{ pick: object[], held: number, reason: string|null }}
 */
export function planRegistrations(eligible, { remain, cap, used, nowMs }) {
  const left = remain == null ? 0 : Math.max(0, remain);
  const capLeft = Math.max(0, cap - used);
  const total = Math.min(left, capLeft, MAX_REGISTER_PER_RUN);
  const backlogBudget = Math.min(total, Math.max(0, left - QUOTA_RESERVE));
  const newSince = nowIso(nowMs - NEW_PARCEL_DAYS * DAY);
  const pick = [];
  let backlog = 0, reserveStop = false;
  for (const r of eligible) {
    if (pick.length >= total) break;
    const isNew = String(r.shipped_at || r.order_created_at || "") >= newSince;
    if (!isNew) {
      if (backlog >= backlogBudget) { reserveStop = true; break; }
      backlog++;
    }
    pick.push(r);
  }
  const held = eligible.length - pick.length;
  let reason = null;
  if (held) {
    // Which limit stopped us. Only the per-run limit is not worth reporting: the rest go next hour.
    if (remain == null) reason = "quota_unknown";
    else if (reserveStop) reason = "reserve_kept";
    else if (total === left) reason = "quota_used_up";
    else if (total === capLeft) reason = "cap_reached";
  }
  return { pick, held, reason, cap, capLeft, total };
}

const HOLD_TEXT = {
  quota_unknown: () => "17TRACK quota is unknown, so nothing is registered",
  quota_used_up: () => "17TRACK quota is used up",
  cap_reached: (p) => `the brain's cap of ${p.cap} registrations is reached (Reilly can raise TRACKING_REGISTER_CAP in Cloudflare)`,
  reserve_kept: () => `the last ${QUOTA_RESERVE} registrations are kept for parcels shipped in the last ${NEW_PARCEL_DAYS} days`,
};

export async function registerNew(env, { nowMs = Date.now(), fetchImpl = fetch, sleep = sleepDefault } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const opts = { fetchImpl, sleep };
  const quota = await getQuota(env, opts);
  await markFeedOk(db, FEED_ID, at);
  await saveQuota(db, quota, at);

  if (!LIVE_STORE_IDS.length) return { quota, registered: 0 };
  const cap = registerCap(env);
  // Everything we've ever registered counts toward the cap, whichever store.
  const usedRow = await db.prepare(`SELECT COUNT(*) AS n FROM shipments WHERE registered_at IS NOT NULL`).first();
  const used = usedRow ? usedRow.n : 0;
  const { results } = await db.prepare(
    `SELECT tracking_number, store, order_name, shipped_at, order_created_at FROM shipments
      WHERE registered_at IS NULL AND register_error IS NULL
        AND store IN (${liveMarks()}) AND order_created_at >= ?
        AND COALESCE(shipped_at, order_created_at) >= ?
        AND NOT ${SHOPIFY_DELIVERED_SQL}
      ORDER BY COALESCE(shipped_at, order_created_at) DESC, tracking_number`
  ).bind(...LIVE_STORE_IDS, nowIso(nowMs - LOOKBACK_DAYS * DAY), nowIso(nowMs - MAX_REGISTER_AGE_DAYS * DAY)).all();
  const eligible = results || [];
  // Unknown quota = don't spend (rule 4: null is not a number).
  const plan = planRegistrations(eligible, { remain: quota.remain, cap, used, nowMs });
  const rows = plan.pick;

  // Say why parcels are waiting, once per change of reason, not every hour.
  const prev = await stageRow(db, "register");
  const prevReason = prev && prev.detail ? prev.detail.reason : null;
  if (plan.reason && plan.reason !== prevReason) {
    const quotaReason = plan.reason === "quota_used_up" || plan.reason === "quota_unknown";
    await logEvent(db, {
      actor: ACTOR, kind: quotaReason ? "tracking.quota_exhausted" : "tracking.register_held", target: SYS,
      summary: `17TRACK: ${plan.held} parcel${plan.held === 1 ? "" : "s"} not tracked for now: ${HOLD_TEXT[plan.reason](plan)}. They still get day-15 / day-20 checks from the order date.`,
      data: { quota, cap, used, held: plan.held, reason: plan.reason }, at,
    });
  }
  const saveStage = (registeredNow) => stageOk(db, "register", at, {
    reason: plan.reason, held: plan.held, cap, used: used + registeredNow, eligible: eligible.length, checked_at: at,
  });
  if (!rows.length) {
    await saveStage(0);
    return { quota, registered: 0, held: plan.held, reason: plan.reason };
  }

  let registered = 0, rejected = 0, already = 0;
  // One batch at a time, saved before the next, so a fault mid-way loses nothing.
  for (let i = 0; i < rows.length; i += MAX_PER_CALL) {
    if (i > 0) await sleep(CALL_GAP_MS);
    const numbers = rows.slice(i, i + MAX_PER_CALL).map((r) => r.tracking_number);
    const res = await register(env, numbers, opts);
    for (const a of res.accepted) {
      const n = normaliseNumber(a.number);
      if (!n) continue;
      const u = await db.prepare(
        `UPDATE shipments SET registered_at = ?, carrier_code = COALESCE(?, carrier_code), updated_at = ?
          WHERE tracking_number = ? AND registered_at IS NULL`
      ).bind(at, Number.isFinite(Number(a.carrier)) ? Number(a.carrier) : null, at, n).run();
      if (u.meta.changes) registered++;
    }
    for (const r of res.rejected) {
      const n = normaliseNumber(r.number);
      if (!n) continue;
      const code = r.error && r.error.code;
      if (code === ERR_ALREADY_REGISTERED) {
        await db.prepare(`UPDATE shipments SET registered_at = ?, updated_at = ? WHERE tracking_number = ? AND registered_at IS NULL`)
          .bind(at, at, n).run();
        already++;
      } else {
        await db.prepare(`UPDATE shipments SET register_error = ?, updated_at = ? WHERE tracking_number = ? AND registered_at IS NULL`)
          .bind(`${code}: ${String((r.error && r.error.message) || "rejected").slice(0, 150)}`, at, n).run();
        rejected++;
      }
    }
  }
  await saveStage(registered + already);
  // Read the quota back from 17TRACK rather than doing arithmetic on our side (rule 3).
  const after = await getQuota(env, opts);
  await saveQuota(db, after, at);
  await logEvent(db, {
    actor: ACTOR, kind: "tracking.registered", target: SYS,
    summary: `17TRACK: registered ${registered} new parcel${registered === 1 ? "" : "s"} (newest first)` +
      (already ? `, ${already} already registered` : "") +
      (rejected ? `, ${rejected} rejected (see Shipping tab)` : "") +
      (plan.held ? `, ${plan.held} waiting` : "") +
      `; ${after.remain == null ? "unknown" : after.remain} registrations left`,
    data: { registered, already, rejected, held: plan.held, reason: plan.reason, cap, quotaBefore: quota.remain, quotaAfter: after.remain }, at,
  });
  return { quota: after, registered, already, rejected, held: plan.held, reason: plan.reason };
}

/* ---------------- 3. poll + proof of delivery ---------------- */

const POD_KEYS = /(sign|photo|image|picture|pod|proof)/i;

/** Any signature/photo-looking fields the carrier passed through, wherever they sit. */
function podExtras(obj, depth = 0, out = {}) {
  if (!obj || typeof obj !== "object" || depth > 4) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (POD_KEYS.test(k) && v != null && v !== "") out[k] = v;
    else if (v && typeof v === "object") podExtras(v, depth + 1, out);
  }
  return out;
}

export async function saveProofOfDelivery(env, row, s, nowMs = Date.now()) {
  const at = nowIso(nowMs);
  const ev = s.deliveredEvent || {};
  const data = {
    store: row.store, store_name: storeName(row.store), order_id: row.order_id, order_name: row.order_name,
    order_created_at: row.order_created_at, tracking_number: row.tracking_number,
    carrier_hint: row.carrier_hint, carrier_code: s.carrier || row.carrier_code, tracking_url: row.tracking_url,
    shipped_at: row.shipped_at, pickup_at: s.pickupAt || row.pickup_at, delivered_at: s.deliveredAt,
    delivered_event: {
      time_iso: ev.time_iso || null, time_utc: ev.time_utc || null, description: ev.description || null,
      location: ev.location || null, address: ev.address || null, sub_status: ev.sub_status || null,
      provider: ev._provider || null,
    },
    recipient_area: s.recipient, // city/state/postal code as 17TRACK reports it
    signature_or_photo: podExtras({ event: ev, misc: s.misc }),
    milestones: s.milestones,
    events: s.events.map(({ _provider, ...e }) => ({ ...e, provider: _provider || null })),
    source: "17TRACK gettrackinfo",
    saved_at: at,
  };
  const label = `pod-${row.store}-${String(row.order_name || row.order_id).replace(/[^0-9A-Za-z]+/g, "")}`;
  const saved = await backup(env.BACKUPS, { store: row.store, label, data, atIso: at }); // verified by head inside
  await env.DB.prepare(`UPDATE shipments SET pod = ?, updated_at = ? WHERE tracking_number = ? AND pod IS NULL`)
    .bind(saved.key, at, row.tracking_number).run();
  await logEvent(env.DB, {
    actor: ACTOR, kind: "tracking.pod_saved", store: row.store, target: "svc.backup_vault",
    summary: `${storeName(row.store)} ${row.order_name}: proof of delivery saved (${shortDate(s.deliveredAt)}${ev.location ? `, ${ev.location}` : ""})`,
    data: { tracking: row.tracking_number, key: saved.key }, at,
  });
  return saved.key;
}

export async function pollTracking(env, { nowMs = Date.now(), fetchImpl = fetch, sleep = sleepDefault } = {}) {
  const db = env.DB;
  if (!LIVE_STORE_IDS.length) return { polled: 0 };
  const at = nowIso(nowMs);
  const { results } = await db.prepare(
    `SELECT * FROM shipments
      WHERE registered_at IS NOT NULL AND store IN (${liveMarks()}) AND order_created_at >= ?
        AND (
          (delivered_at IS NULL AND (polled_at IS NULL OR polled_at <= ?))
          OR (push_at IS NOT NULL AND (polled_at IS NULL OR push_at > polled_at))
          OR (delivered_at IS NOT NULL AND pod IS NULL AND (polled_at IS NULL OR polled_at <= ?))
        )
      ORDER BY polled_at IS NOT NULL, polled_at LIMIT ?`
  ).bind(...LIVE_STORE_IDS, nowIso(nowMs - 60 * DAY), nowIso(nowMs - POLL_EVERY_MS), nowIso(nowMs - HOUR), MAX_POLL_PER_RUN).all();
  const due = results || [];
  if (!due.length) return { polled: 0 };

  const byNumber = new Map(due.map((r) => [r.tracking_number, r]));
  const out = { polled: 0, delivered: [], failed: [], pickupReady: [], podSaved: 0, podErrors: 0, rejected: 0 };
  for (let i = 0; i < due.length; i += MAX_PER_CALL) {
    if (i > 0) await sleep(CALL_GAP_MS);
    const res = await getTrackInfo(env, due.slice(i, i + MAX_PER_CALL).map((r) => r.tracking_number), { fetchImpl, sleep });
    await markFeedOk(db, FEED_ID, at);
    out.rejected += res.rejected.length;
    for (const item of res.accepted) {
      const n = normaliseNumber(item.number);
      const row = n && byNumber.get(n);
      if (!row) continue;
      const s = summarise(item);
      if (!s.status) continue; // no status at all: say nothing rather than guess
      await db.prepare(
        `UPDATE shipments SET state = ?, last_status = ?, last_sub_status = ?, last_event_at = ?, last_event_text = ?,
                last_event_location = ?, pickup_at = COALESCE(pickup_at, ?), delivered_at = COALESCE(delivered_at, ?),
                carrier_code = COALESCE(?, carrier_code), polled_at = ?, push_at = NULL, updated_at = ?
          WHERE tracking_number = ?`
      ).bind(s.state, s.status, s.subStatus, s.lastEventAt, s.lastEventText, s.lastEventLocation,
        s.pickupAt, s.deliveredAt, s.carrier, at, at, n).run();
      out.polled++;
      const label = `${storeName(row.store)} ${row.order_name}`;
      if (s.state === "delivered" && !row.delivered_at) {
        out.delivered.push(label);
      }
      if (s.state !== row.state && s.state === "failed_attempt") out.failed.push(label);
      if (s.state !== row.state && s.state === "pickup_ready") out.pickupReady.push(label);
      if (s.state === "delivered" && !row.pod) {
        try {
          await saveProofOfDelivery(env, row, s, nowMs);
          out.podSaved++;
        } catch (err) {
          out.podErrors++;
          await logEvent(db, {
            actor: ACTOR, kind: "error.pod_save", store: row.store, target: "svc.backup_vault",
            summary: `${label}: delivered, but proof of delivery couldn't be saved; will retry within the hour (${String(err.message).slice(0, 150)})`, at,
          });
        }
      }
    }
  }
  await stageOk(db, "poll", at, { polled: out.polled });
  const parts = [];
  if (out.delivered.length) parts.push(`${out.delivered.length} delivered (${out.delivered.join(", ")})`);
  if (out.failed.length) parts.push(`${out.failed.length} delivery failed (${out.failed.join(", ")})`);
  if (out.pickupReady.length) parts.push(`${out.pickupReady.length} waiting at a pickup point (${out.pickupReady.join(", ")})`);
  if (out.rejected) parts.push(`${out.rejected} not answered by 17TRACK`);
  await logEvent(db, {
    actor: ACTOR, kind: "tracking.polled", target: SYS,
    summary: `Checked ${out.polled} parcel${out.polled === 1 ? "" : "s"} with 17TRACK` + (parts.length ? `: ${parts.join("; ")}` : ", no big changes"),
    data: { polled: out.polled, delivered: out.delivered, failed: out.failed, pickupReady: out.pickupReady, rejected: out.rejected }, at,
  });
  return out;
}

/* ---------------- 4. checks → flags + approvals ---------------- */

/** Raise a flag once. Returns true only for the run that created it. */
async function raiseFlag(db, f, at) {
  const res = await db.prepare(
    `INSERT INTO shipment_flags (store, order_id, order_name, kind, tracking_number, detail, raised_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(store, order_id, kind) DO NOTHING`
  ).bind(f.store, f.order_id, f.order_name, f.kind, f.tracking_number || null, f.detail, at).run();
  return !!(res.meta && res.meta.changes === 1);
}

/** Delivered, by 17TRACK or by Shopify's own fulfillment status. */
export const isDelivered = (p) => !!(p.delivered_at || p.state === "delivered" || isShopifyDelivered(p));

/** Why a parcel isn't tracked by 17TRACK, in words for the flag. */
export function untrackedReason(p, nowMs = Date.now()) {
  if (p.register_error) return "17TRACK rejected the number";
  const shipped = Date.parse(p.shipped_at || p.order_created_at || "");
  if (Number.isFinite(shipped) && shipped < nowMs - MAX_REGISTER_AGE_DAYS * DAY) return "too old to register";
  return "not registered: quota or cap";
}

/**
 * Keep the order-level 'stuck_pickup' flag (what Mission Control and the brief show) in
 * step with its per-parcel rows: open with every stuck parcel listed while any parcel is
 * stuck, resolved once none is. A parcel stuck after an earlier one cleared re-opens it.
 */
async function syncOrderPickupFlag(db, store, orderId, orderName, at, freshSince) {
  const { results: all } = await db.prepare(
    `SELECT tracking_number, detail, resolved_at FROM parcel_pickup_flags WHERE store = ? AND order_id = ? ORDER BY raised_at, tracking_number`
  ).bind(store, orderId).all();
  const open = (all || []).filter((r) => !r.resolved_at);
  if (open.length) {
    await db.prepare(
      `INSERT INTO shipment_flags (store, order_id, order_name, kind, tracking_number, detail, raised_at)
       VALUES (?, ?, ?, 'stuck_pickup', ?, ?, ?)
       ON CONFLICT(store, order_id, kind) DO UPDATE SET
         detail = excluded.detail, tracking_number = excluded.tracking_number,
         raised_at = CASE WHEN shipment_flags.resolved_at IS NOT NULL THEN excluded.raised_at ELSE shipment_flags.raised_at END,
         resolved_at = NULL`
    ).bind(store, orderId, orderName, open[0].tracking_number, open.map((r) => r.detail).join("; "), at).run();
    return;
  }
  if ((all || []).length) {
    await db.prepare(`UPDATE shipment_flags SET resolved_at = ? WHERE store = ? AND order_id = ? AND kind = 'stuck_pickup' AND resolved_at IS NULL`)
      .bind(at, store, orderId).run();
    return;
  }
  // A flag from before per-parcel rows existed: clears when its own parcel has a fresh scan.
  await db.prepare(
    `UPDATE shipment_flags SET resolved_at = ?
      WHERE store = ? AND order_id = ? AND kind = 'stuck_pickup' AND resolved_at IS NULL
        AND EXISTS (SELECT 1 FROM shipments s WHERE s.tracking_number = shipment_flags.tracking_number
                     AND s.state IS NOT NULL AND s.state != 'awaiting_pickup' AND s.polled_at >= ?)`
  ).bind(at, store, orderId, freshSince).run();
}

export async function runChecks(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  if (!LIVE_STORE_IDS.length) return { raised: [] };
  const at = nowIso(nowMs);
  const freshSince = nowIso(nowMs - STATUS_FRESH_MS);
  const raised = [];
  const { results } = await db.prepare(
    `SELECT * FROM shipments WHERE store IN (${liveMarks()}) AND order_created_at >= ?`
  ).bind(...LIVE_STORE_IDS, nowIso(nowMs - 60 * DAY)).all();
  const rows = results || [];
  const pickupOrders = new Map(); // orders whose per-parcel pickup rows may have changed

  // Per parcel: stuck pickup, failed delivery, waiting at a pickup point.
  for (const s of rows) {
    const fresh = s.polled_at && s.polled_at >= freshSince;
    if (!fresh) continue; // a stale or missing status is not evidence (rules 4 and 6)
    const label = `${storeName(s.store)} ${s.order_name}`;
    if (s.state === "awaiting_pickup" && s.shipped_at && Date.parse(s.shipped_at) <= nowMs - PICKUP_STUCK_DAYS * DAY &&
        s.order_created_at >= nowIso(nowMs - LOOKBACK_DAYS * DAY)) {
      const days = Math.floor((nowMs - Date.parse(s.shipped_at)) / DAY);
      const detail = `${s.tracking_number}: shipped ${shortDate(s.shipped_at)}, no carrier scan after ${days} days (${s.last_status})`;
      // Once per PARCEL: a second parcel of the same order stuck later is still raised.
      const ins = await db.prepare(
        `INSERT INTO parcel_pickup_flags (tracking_number, store, order_id, order_name, detail, raised_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tracking_number) DO NOTHING`
      ).bind(s.tracking_number, s.store, s.order_id, s.order_name, detail, at).run();
      if (ins.meta && ins.meta.changes === 1) {
        raised.push("stuck_pickup");
        pickupOrders.set(`${s.store}|${s.order_id}`, s);
        await logEvent(db, {
          actor: ACTOR, kind: "tracking.stuck_pickup", store: s.store, target: "sup.relay",
          summary: `${label} (${s.tracking_number}) shipped ${shortDate(s.shipped_at)} but the carrier hasn't picked it up; it goes in the next KFB message`,
          data: { tracking: s.tracking_number, shipped_at: s.shipped_at, status: s.last_status }, at,
        });
      }
    } else if (s.state && s.state !== "awaiting_pickup") {
      // Scanned now: clears THIS parcel only; the order stays flagged while another is stuck.
      const u = await db.prepare(`UPDATE parcel_pickup_flags SET resolved_at = ? WHERE tracking_number = ? AND resolved_at IS NULL`)
        .bind(at, s.tracking_number).run();
      if (u.meta && u.meta.changes) pickupOrders.set(`${s.store}|${s.order_id}`, s);
    }
    if (s.state === "failed_attempt" || s.state === "pickup_ready") {
      const kind = s.state === "failed_attempt" ? "failed_delivery" : "pickup_ready";
      const where = s.last_event_location ? ` at ${s.last_event_location}` : "";
      const detail = `${s.tracking_number}: ${s.state === "failed_attempt" ? "delivery failed" : "waiting for pickup"}${where}` +
        `${s.last_event_text ? ` — "${String(s.last_event_text).slice(0, 140)}"` : ""}. Customer email needed.`;
      if (await raiseFlag(db, { ...s, kind, detail }, at)) {
        raised.push(kind);
        await logEvent(db, {
          actor: ACTOR, kind: `tracking.${kind}`, store: s.store, target: "cs.reply_writer",
          summary: `${label}: ${s.state === "failed_attempt" ? "delivery failed" : "parcel is waiting at a pickup point"}${where}. Customer email needed (drafting comes later).`,
          data: { tracking: s.tracking_number, status: s.last_status, sub_status: s.last_sub_status }, at,
        });
      }
    }
  }
  // Orders with an open stuck-pickup flag are re-synced too (covers flags from before 0008).
  const { results: openPickup } = await db.prepare(
    `SELECT store, order_id, order_name FROM shipment_flags WHERE kind = 'stuck_pickup' AND resolved_at IS NULL`
  ).all();
  for (const f of openPickup || []) if (!pickupOrders.has(`${f.store}|${f.order_id}`)) pickupOrders.set(`${f.store}|${f.order_id}`, f);
  for (const o of pickupOrders.values()) await syncOrderPickupFlag(db, o.store, o.order_id, o.order_name, at, freshSince);

  // Per order: day 15 and day 20.
  let newApprovals = 0;
  const held = [];
  const orders = new Map();
  for (const s of rows) {
    const k = `${s.store}|${s.order_id}`;
    if (!orders.has(k)) orders.set(k, []);
    orders.get(k).push(s);
  }
  for (const parcels of orders.values()) {
    const o = parcels[0];
    if (!o.order_created_at) continue;
    const open = parcels.filter((p) => !isDelivered(p));
    if (!open.length) {
      await db.prepare(`UPDATE shipment_flags SET resolved_at = ? WHERE store = ? AND order_id = ? AND resolved_at IS NULL`)
        .bind(at, o.store, o.order_id).run();
      await db.prepare(`UPDATE parcel_pickup_flags SET resolved_at = ? WHERE store = ? AND order_id = ? AND resolved_at IS NULL`)
        .bind(at, o.store, o.order_id).run();
      continue;
    }
    // Evidence, parcel by parcel. Delivered parcels never block the order (they're not
    // re-polled). A registered parcel counts only with a fresh status (rules 4 and 6). A
    // parcel 17TRACK isn't tracking (quota, age, rejected) counts from the order date
    // alone, so it can never go silent, but it is never enough for a day-20 approval.
    const late = [];
    let trackedLate = 0;
    for (const p of open) {
      if (p.registered_at) {
        if (p.polled_at && p.polled_at >= freshSince && p.state) {
          late.push(`${p.tracking_number}: ${STATE_LABELS[p.state] || p.state}`);
          trackedLate++;
        }
      } else {
        late.push(`${p.tracking_number}: not tracked by 17TRACK (${untrackedReason(p, nowMs)})`);
      }
    }
    if (!late.length) continue;
    const delivered = parcels.length - open.length;
    const where = late.join("; ") + (delivered ? `; ${delivered} other parcel${delivered === 1 ? "" : "s"} delivered` : "");
    const days = easternDaysSince(o.order_created_at, nowMs);
    const label = `${storeName(o.store)} ${o.order_name || o.order_id}`;
    if (days >= DAY15) {
      const detail = `Day ${days} since the order (${shortDate(o.order_created_at)}), not delivered. ${where}`;
      if (await raiseFlag(db, { ...o, tracking_number: null, kind: "day15", detail }, at)) {
        raised.push("day15");
        await logEvent(db, {
          actor: LATE_ACTOR, kind: "tracking.day15", store: o.store, target: "cs.reply_writer",
          summary: `${label}: day ${days} and not delivered (${where}). Day-15 heads-up email due (drafting comes later).`,
          data: { order_id: o.order_id, days }, at,
        });
      }
    }
    if (days >= DAY20) {
      const detail = `Day ${days} since the order (${shortDate(o.order_created_at)}), not delivered. ${where}`;
      if (!trackedLate || days > DAY20_MAX_AGE_DAYS) {
        // No fresh 17TRACK evidence, or too old to act on automatically: a flag only.
        const why = !trackedLate ? "no parcel is tracked by 17TRACK with a fresh status" : `older than ${DAY20_MAX_AGE_DAYS} days`;
        if (await raiseFlag(db, { ...o, tracking_number: null, kind: "day20_verify", detail: `${detail}. Verify manually (${why}); no reship/refund approval raised.` }, at)) {
          raised.push("day20_verify");
        }
        continue;
      }
      await raiseFlag(db, { ...o, tracking_number: null, kind: "day20", detail }, at);
      // Fresh 17TRACK evidence now: an earlier "verify manually" flag is superseded.
      await db.prepare(`UPDATE shipment_flags SET resolved_at = ? WHERE store = ? AND order_id = ? AND kind = 'day20_verify' AND resolved_at IS NULL`)
        .bind(at, o.store, o.order_id).run();
      const flag = await db.prepare(`SELECT approval_id, resolved_at FROM shipment_flags WHERE store = ? AND order_id = ? AND kind = 'day20'`)
        .bind(o.store, o.order_id).first();
      if (flag && flag.approval_id == null && !flag.resolved_at) {
        // Idempotent: the flag is never deleted, and an approval already made for this
        // order (say the run crashed after createApproval wrote it) is re-linked, not
        // asked again. The title starts with "<store> <order> not delivered ", which is
        // the order's key; any status counts, so Reilly is never asked twice.
        const prefix = `${label} not delivered `;
        const existing = await db.prepare(
          `SELECT id FROM approvals WHERE dept = 'ful' AND requested_by = ? AND store = ?
              AND substr(title, 1, length(?)) = ? ORDER BY id DESC LIMIT 1`
        ).bind(LATE_ACTOR, o.store, prefix, prefix).first();
        if (!existing && newApprovals >= DAY20_APPROVALS_PER_RUN) { held.push(o.order_name || o.order_id); continue; }
        const approvalId = existing ? existing.id : await createApproval(db, {
          dept: "ful", requestedBy: LATE_ACTOR, store: o.store,
          title: `${prefix}${days} days after the order (${where}). Reship or refund?`,
          options: [{ id: "reship", label: "Reship" }, { id: "refund", label: "Refund" }],
        });
        if (!existing) newApprovals++;
        await db.prepare(`UPDATE shipment_flags SET approval_id = ? WHERE store = ? AND order_id = ? AND kind = 'day20' AND approval_id IS NULL`)
          .bind(approvalId, o.store, o.order_id).run();
        raised.push(existing ? "day20_relinked" : "day20");
      }
    }
  }
  if (held.length) {
    await logEvent(db, {
      actor: LATE_ACTOR, kind: "tracking.day20_held", target: "core.approvals",
      summary: `Day-20 reship/refund approvals: ${newApprovals} asked this run (cap ${DAY20_APPROVALS_PER_RUN}), ${held.length} more held back for the next runs (${held.slice(0, 10).join(", ")}${held.length > 10 ? ", ..." : ""})`,
      data: { held: held.length, asked: newApprovals, cap: DAY20_APPROVALS_PER_RUN, orders: held }, at,
    });
  }
  return { raised, held: held.length, asked: newApprovals };
}

/* ---------------- the cron entry ---------------- */

async function stage(env, name, fn, at) {
  try {
    return { ok: true, result: await fn() };
  } catch (err) {
    const msg = String(err && err.message).slice(0, 200);
    if (err instanceof Track17Error && err.code !== "NOT_WIRED") {
      await markFeedFailed(env.DB, FEED_ID, msg, at).catch(() => {});
    }
    await logEvent(env.DB, {
      actor: ACTOR, kind: `error.tracking_${name}`, target: err instanceof Track17Error ? SYS : undefined,
      summary: `Tracking ${name} failed; it will try again in 15 minutes (${msg})`, at,
    }).catch(() => {});
    return { ok: false, error: msg };
  }
}

/**
 * Called by the 15-minute cron. Each stage has its own try, so one failing never stops
 * the next (and never reaches the order pull, KFB composer or sentinel).
 */
/**
 * Parcel tracking switched off (stores.js PARCEL_TRACKING). Once: record Reilly's words in
 * `decisions`, close every open parcel flag, and drop the 17TRACK feed so it can't show
 * as stale. Nothing registers, polls or raises flags while it's off.
 */
export async function trackingOff(env, nowMs = Date.now()) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const d = PARCEL_TRACKING_DECISION;
  // Through the Decision Keeper's guard: never recorded twice, never over Reilly's newer words.
  const seeded = await seedDecision(db, { at: d.at, topic: d.topic, words: d.words, scope: "all", source: "src/config/stores.js PARCEL_TRACKING_DECISION" }, { nowMs });
  const had = !seeded.added;
  const open = await db.prepare(`UPDATE shipment_flags SET resolved_at = ? WHERE resolved_at IS NULL`).bind(at).run();
  const cleared = (open && open.meta && open.meta.changes) || 0;
  await db.prepare(`DELETE FROM feeds WHERE id = ?`).bind(FEED_ID).run();
  // Reship-or-refund questions from the switched-off Late-Shipment Watcher are withdrawn,
  // not answered: 'expired' is not a decision and never runs anything.
  const ap = await db.prepare(`UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND requested_by = ?`).bind(at, LATE_ACTOR).run();
  const withdrawn = (ap && ap.meta && ap.meta.changes) || 0;
  // Unsent KFB messages lose their carrier-pickup lines (they came from tracking).
  // Imported here, not at the top: kfbMessage.js already imports this module.
  const { stripPickupLines } = await import("./kfbMessage.js");
  await stripPickupLines(db, at).catch(() => null);
  if (!had || cleared || withdrawn) {
    await logEvent(db, {
      actor: ACTOR, kind: "tracking.switched_off",
      summary: `Parcel tracking is off (Reilly, Oct 13): 17TRACK and the day-15/day-20 parcel flags stopped` + (cleared ? `; ${cleared} open parcel flag${cleared === 1 ? "" : "s"} cleared` : "") +
        (withdrawn ? `; ${withdrawn} reship-or-refund question${withdrawn === 1 ? "" : "s"} withdrawn (not answered)` : ""),
      data: { cleared, withdrawn }, at,
    });
  }
  return { off: true, cleared, withdrawn };
}

export async function runTracking(env, { nowMs = Date.now(), fetchImpl = fetch, sleep = sleepDefault } = {}) {
  if (!parcelTrackingOn(env)) return trackingOff(env, nowMs);
  const at = nowIso(nowMs);
  const out = {};
  const hourly = await claimStage(env.DB, "collect", nowMs, COLLECT_EVERY_MS);
  if (hourly) {
    out.collect = await stage(env, "collect", () => collectShipments(env, { nowMs, fetchImpl }), at);
    if (out.collect.ok) await stageOk(env.DB, "collect", at, null).catch(() => {});
  }
  if (env.TRACKING_API_KEY) {
    if (hourly) out.register = await stage(env, "register", () => registerNew(env, { nowMs, fetchImpl, sleep }), at);
    out.poll = await stage(env, "poll", () => pollTracking(env, { nowMs, fetchImpl, sleep }), at);
  }
  out.checks = await stage(env, "checks", () => runChecks(env, { nowMs }), at);
  return out;
}

/* ---------------- 17TRACK push (webhook) ---------------- */

const MAX_PUSH_BYTES = 512 * 1024;

/**
 * A refused push is counted, not logged one by one: anyone can POST junk at the URL, and
 * an event per request would flood the Event Log. The first refusal is logged at once;
 * after that, at most one summary event per hour, carrying the count since the last one.
 */
export async function noteRejectedPush(db, nowMs = Date.now()) {
  const at = nowIso(nowMs);
  const STAGE = "push_rejected";
  await db.prepare(`INSERT INTO tracking_runs (stage) VALUES (?) ON CONFLICT(stage) DO NOTHING`).bind(STAGE).run();
  await db.prepare(`UPDATE tracking_runs SET count = count + 1 WHERE stage = ?`).bind(STAGE).run();
  const claimed = await claimStage(db, STAGE, nowMs, PUSH_REJECT_LOG_EVERY_MS);
  if (!claimed) return { logged: false };
  const row = await db.prepare(`SELECT count FROM tracking_runs WHERE stage = ?`).bind(STAGE).first();
  const n = row ? row.count : 1;
  // Subtract what we report (not "= 0") so refusals counted meanwhile aren't lost.
  await db.prepare(`UPDATE tracking_runs SET count = count - ?, last_ok_at = ? WHERE stage = ?`).bind(n, at, STAGE).run();
  await logEvent(db, {
    actor: ACTOR, kind: "tracking.push_rejected", target: SYS,
    summary: `Refused ${n} tracking push${n === 1 ? "" : "es"} whose signature didn't verify (not from 17TRACK with our key). ` +
      `Further refusals are counted and summarised at most once an hour.`,
    data: { refused: n }, at,
  });
  return { logged: true, refused: n };
}

/**
 * POST /webhooks/17track. Accepted only when the `sign` header verifies against our key.
 * Even then the body's status is not trusted: known numbers are queued for a re-read from
 * the API on the next 15-minute run; unknown numbers are ignored.
 */
export async function handleTrackingPush(request, env, nowMs = Date.now()) {
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  if (!parcelTrackingOn(env)) return json({ ok: true, ignored: "parcel tracking is off" });
  if (!env.TRACKING_API_KEY) return json({ ok: false, error: "not wired" }, 503);
  const raw = await request.text();
  if (raw.length > MAX_PUSH_BYTES) return json({ ok: false, error: "too large" }, 413);
  const at = nowIso(nowMs);
  if (!(await verifyPush(raw, request.headers.get("sign"), env.TRACKING_API_KEY))) {
    await noteRejectedPush(env.DB, nowMs).catch(() => {});
    return json({ ok: false, error: "bad signature" }, 401);
  }
  let body = null;
  try { body = JSON.parse(raw); } catch { return json({ ok: false, error: "bad json" }, 400); }
  const d = body && body.data;
  const candidates = [];
  if (d && d.number) candidates.push(d.number);
  if (d && Array.isArray(d.accepted)) for (const a of d.accepted) if (a && a.number) candidates.push(a.number);
  let queued = 0, ignored = 0;
  for (const c of candidates) {
    const n = normaliseNumber(c);
    const row = n && await env.DB.prepare(`SELECT store, order_name FROM shipments WHERE tracking_number = ?`).bind(n).first();
    if (!row) { ignored++; continue; }
    await env.DB.prepare(`UPDATE shipments SET push_at = ? WHERE tracking_number = ?`).bind(at, n).run();
    queued++;
  }
  if (queued) {
    await logEvent(env.DB, {
      actor: ACTOR, kind: "tracking.push_received", target: SYS,
      summary: `17TRACK says ${queued} parcel${queued === 1 ? "" : "s"} changed (${String(body.event || "update")}); re-checking from the API within 15 minutes`,
      data: { queued, ignored, event: body.event || null }, at,
    });
  }
  // 200 even when ignored: 17TRACK retries anything else, and an unknown number won't become known.
  return json({ ok: true, queued, ignored });
}

/* ---------------- Mission Control ---------------- */

export async function shippingState(env, nowMs = Date.now()) {
  const db = env.DB;
  const empty = { off: !parcelTrackingOn(env), wired: !!env.TRACKING_API_KEY, counts: {}, total: 0, unregistered: 0, notTracked: { quota: 0, age: 0, shopifyDelivered: 0, rejected: 0 }, registerErrors: [], flags: [], quota: null, quotaLow: false, lastSync: null, lastCollect: null };
  if (!LIVE_STORE_IDS.length || !parcelTrackingOn(env)) return empty;
  const since = nowIso(nowMs - 60 * DAY);
  // Parcels 17TRACK isn't tracking are counted by why: Shopify says delivered, too old,
  // rejected, or waiting on quota/cap (decided from the last register run's reason).
  const { results: counts } = await db.prepare(
    `SELECT CASE
              WHEN state IS NOT NULL THEN state
              WHEN registered_at IS NOT NULL THEN 'not_checked'
              WHEN register_error IS NOT NULL THEN 'not_tracked_rejected'
              WHEN ${SHOPIFY_DELIVERED_SQL} THEN 'not_tracked_delivered'
              WHEN order_created_at < ? OR COALESCE(shipped_at, order_created_at) < ? THEN 'not_tracked_age'
              ELSE 'not_registered' END AS state, COUNT(*) AS n
       FROM shipments WHERE store IN (${liveMarks()}) AND order_created_at >= ? GROUP BY 1`
  ).bind(nowIso(nowMs - LOOKBACK_DAYS * DAY), nowIso(nowMs - MAX_REGISTER_AGE_DAYS * DAY), ...LIVE_STORE_IDS, since).all();
  const { results: errs } = await db.prepare(
    `SELECT store, order_name, tracking_number, register_error FROM shipments
      WHERE register_error IS NOT NULL AND store IN (${liveMarks()}) AND order_created_at >= ? ORDER BY shipped_at DESC LIMIT 20`
  ).bind(...LIVE_STORE_IDS, since).all();
  const { results: flags } = await db.prepare(
    `SELECT f.*, s.last_status, s.last_event_text, s.last_event_at, s.shipped_at, a.status AS approval_status
       FROM shipment_flags f
       LEFT JOIN shipments s ON s.tracking_number = f.tracking_number
       LEFT JOIN approvals a ON a.id = f.approval_id
      WHERE f.resolved_at IS NULL AND f.store IN (${liveMarks()})
      ORDER BY CASE f.kind WHEN 'day20' THEN 0 WHEN 'day20_verify' THEN 0 WHEN 'failed_delivery' THEN 1 WHEN 'pickup_ready' THEN 2 WHEN 'stuck_pickup' THEN 3 ELSE 4 END, f.raised_at DESC
      LIMIT 100`
  ).bind(...LIVE_STORE_IDS).all();
  const quotaRow = await stageRow(db, "quota");
  const pollRow = await stageRow(db, "poll");
  const collectRow = await stageRow(db, "collect");
  const registerRow = await stageRow(db, "register");
  const pushRow = await stageRow(db, "push_rejected");
  const quota = quotaRow && quotaRow.detail ? quotaRow.detail : null;
  const hold = registerRow && registerRow.detail ? registerRow.detail : null;
  const c = {};
  let total = 0;
  for (const r of counts || []) { c[r.state] = r.n; total += r.n; }
  // Held back by quota, the cap or the reserve: say so instead of "will register next hour".
  if (hold && hold.reason && c.not_registered) { c.not_tracked_quota = c.not_registered; delete c.not_registered; }
  return {
    wired: !!env.TRACKING_API_KEY,
    counts: c,
    labels: {
      ...STATE_LABELS, not_registered: "Not registered yet", not_checked: "Registered, not checked yet",
      not_tracked_quota: "Not tracked (quota/cap)", not_tracked_age: "Not tracked (21+ days old)",
      not_tracked_delivered: "Not tracked (Shopify says delivered)", not_tracked_rejected: "Not tracked (17TRACK rejected)",
    },
    total,
    unregistered: (c.not_registered || 0) + (c.not_tracked_quota || 0),
    notTracked: {
      quota: c.not_tracked_quota || 0, age: c.not_tracked_age || 0,
      shopifyDelivered: c.not_tracked_delivered || 0, rejected: c.not_tracked_rejected || 0,
    },
    registerCap: registerCap(env),
    registerHold: hold && hold.reason ? { reason: hold.reason, held: hold.held, cap: hold.cap, used: hold.used } : null,
    pushesRefused: pushRow ? { sinceLastReport: pushRow.count || 0, lastReported: pushRow.last_ok_at || null } : null,
    registerErrors: (errs || []).map((r) => ({ ...r, store_name: storeName(r.store) })),
    flags: (flags || []).map((f) => ({ ...f, store_name: storeName(f.store), label: FLAG_LABELS[f.kind] || f.kind })),
    quota,
    quotaLow: !!(quota && quota.remain != null && quota.remain < QUOTA_LOW),
    lastSync: pollRow ? pollRow.last_ok_at : null,
    lastCollect: collectRow ? collectRow.last_ok_at : null,
  };
}

export { mapStatus };
