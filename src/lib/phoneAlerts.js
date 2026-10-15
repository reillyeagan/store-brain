/**
 * Urgent phone alerts — one small notifier that reads the Event Log (go-live, 2026-10-14).
 *
 * Why one central place: the urgent things are already logged as events by the agents that
 * find them (Risk, Media, the Incident Desk, Store Guard, P&L Sheets, CS). Hooking a phone call
 * into each of them would scatter the rate limit and the "no names, no emails" rule across six
 * files. Instead, every 15-minute cron this reads the new events (cursor in agent_cursors,
 * name "phone_alerts"), keeps only the URGENT ones, and pushes each through one gate:
 *
 *   - a chargeback whose evidence is due within 48 h      risk.dispute_reminder, daysLeft <= 2
 *   - a spend alarm (once per type, store and day)         media.spend_alarm (the Spend Alarm
 *     already dedupes; "stopped" is the Auberlane-style "money stopped going out" alarm)
 *   - a HIGH fraud flag                                    risk.order_high
 *   - an incident the Incident Desk asks Reilly about      approval.requested by core.incidents
 *   - a Store Guard stop / store timezone alarm            store.check_failed (STORE_MISMATCH),
 *                                                          error.* "STORE MISMATCH",
 *                                                          cs.draft_guard_stop, error.store_timezone
 *
 * Limits: at most ALERT_CAP_PER_DAY alerts per New York day in total, and at most one per item
 * (phone_alerts.item_key is UNIQUE, so two overlapping runs can't both alert). A send that
 * Pushover refuses is retried on later runs (up to MAX_ATTEMPTS, same day): a failed probe is
 * evidence about the probe (rule 6).
 *
 * Text: built here from known-safe parts (store name, order number, amount, dates, agent ids),
 * never copied from free text, and scrubbed of anything shaped like an email as a last guard.
 * No secrets, no customer names, no emails.
 *
 * Switch: PHONE_ALERTS_LIVE = "1" sends; anything else = shadow: the alert is recorded and
 * logged (phone.alert_shadow) but nothing reaches the phone.
 */
import { logEvent } from "./eventlog.js";
import { localDay, nowIso } from "./time.js";
import { sendPhone, approvalPageUrl } from "./phone.js";
import { getApproval } from "./approvals.js";
import { STORES } from "../config/stores.js";
import { modeFor } from "../config/live.js";

const ACTOR = "core.approvals";
const CURSOR = "phone_alerts";
export const ALERT_CAP_PER_DAY = 6;
export const MAX_ATTEMPTS = 3;
export const PAGE = 200;
export const MAX_PAGES = 5;
/** On the very first run, events from the last hour still count (history is not replayed). */
export const FIRST_RUN_LOOKBACK_MIN = 60;
const TZ = "America/New_York";

/** Event kinds worth reading at all (the pure alertFor decides the rest). */
export const WATCHED_KINDS = Object.freeze([
  "risk.dispute_reminder", "media.spend_alarm", "risk.order_high", "approval.requested",
  "store.check_failed", "cs.draft_guard_stop", "error.store_timezone",
]);

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
/** Last guard: no email address ever leaves in an alert, and nothing runs long. */
export function scrubAlertText(s, max = 600) {
  return String(s ?? "").replace(EMAIL, "[email removed]").replace(/\s+/g, " ").trim().slice(0, max);
}

const storeName = (id) => (id && STORES[id] ? STORES[id].name : id ? String(id).toUpperCase() : "a store");
const usd = (n) => (n == null || !Number.isFinite(Number(n)) ? null : `$${Number(n).toFixed(2)}`);
const parse = (s) => { if (s && typeof s === "object") return s; try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
/** Shopify order numbers look like "#1098": nothing else from a summary is trusted as an order label. */
const orderLabel = (s) => { const m = /#\d{3,8}\b/.exec(String(s || "")); return m ? m[0] : null; };
const amountIn = (s) => { const m = /\$\s?\d[\d,]*(?:\.\d{2})?/.exec(String(s || "")); return m ? m[0].replace(/\s/g, "") : null; };

/**
 * Pure: the alert an event raises, or null when it isn't urgent. Returns
 * { key, kind, title, message, approvalId?, hash, store }.
 */
export function alertFor(e) {
  if (!e || !e.kind) return null;
  const d = parse(e.data);
  const store = e.store || null;
  const name = storeName(store);
  const day = e.at ? localDay(e.at, TZ) : null;

  if (e.kind === "risk.dispute_reminder") {
    const dl = Number(d.daysLeft);
    if (!Number.isFinite(dl) || dl < 0 || dl > 2) return null; // within 48 h only
    if (!d.disputeId) return null;
    const order = orderLabel(e.summary);
    const amt = amountIn(e.summary);
    const when = dl === 0 ? "due TODAY" : `due in ${dl} day${dl === 1 ? "" : "s"}`;
    return {
      key: `chargeback:${store}:${d.disputeId}`, kind: "chargeback", store,
      title: `Chargeback evidence ${when}`,
      message: `${name}: ${order ? `${order} chargeback` : "chargeback"}${amt ? ` (${amt})` : ""}, evidence ${when}. Submit it in Shopify (the brain never submits); the draft is on the Risk page.`,
      approvalId: d.approvalId > 0 ? d.approvalId : null, hash: "#/agents/page/risk",
    };
  }

  if (e.kind === "media.spend_alarm") {
    const type = d.type || (Array.isArray(d.alarms) && d.alarms[0]) || "alarm";
    const spend = usd(d.spend_today), usual = usd(d.usual_day);
    const text = type === "stopped"
      ? `${name}: ad spend STOPPED on an account that normally spends${usual ? ` about ${usual} a day` : ""}. Billing failed or campaigns paused?`
      : type === "no_orders"
        ? `${name}: ${spend || "money"} spent on ads today with 0 orders.`
        : type === "runaway"
          ? `${name}: ${spend || "spend"} on ads today, far over a normal day${usual ? ` (${usual})` : ""}, with 0 orders.`
          : `${name}: spend alarm (${type}).`;
    return {
      key: `spend:${store}:${type}:${d.day || day}`, kind: "spend_alarm", store,
      title: type === "stopped" ? `Ad spend stopped: ${name}` : `Spend alarm: ${name}`,
      message: `${text} Watch only: nothing was changed in Google Ads.`,
      approvalId: null, hash: "#/agents/page/media",
    };
  }

  if (e.kind === "risk.order_high") {
    if (!d.orderId) return null;
    const order = orderLabel(e.summary);
    const amt = amountIn(e.summary);
    return {
      key: `fraud:${store}:${d.orderId}`, kind: "fraud", store,
      title: `HIGH fraud risk: ${name}`,
      message: `${name}: ${order ? `order ${order}` : "an order"}${amt ? ` (${amt})` : ""} is rated HIGH risk by Shopify. Decide before paying KFB for it.`,
      approvalId: d.approvalId > 0 ? d.approvalId : null, hash: "#/agents/page/risk",
    };
  }

  if (e.kind === "approval.requested") {
    if (e.target !== "core.incidents" || !(d.approvalId > 0)) return null;
    // The Incident Desk's title: "Ongoing problem: <actor> (<kind>) has failed N times since ...".
    const m = /Ongoing problem: ([a-z0-9_.]{1,60}) \(([a-z0-9_.]{1,60})\) has failed (\d+) times/.exec(String(e.summary || ""));
    return {
      key: `incident:${d.approvalId}`, kind: "incident", store,
      title: "Ongoing problem needs you",
      message: m
        ? `${m[1]} keeps failing (${m[2]}, ${m[3]} times) and its retries have not fixed it.`
        : "A job keeps failing and its retries have not fixed it.",
      approvalId: d.approvalId, hash: "#/agents/page/core",
    };
  }

  const mismatch = (e.kind === "store.check_failed" && d.code === "STORE_MISMATCH")
    || (String(e.kind).startsWith("error.") && /STORE[ _]MISMATCH/.test(String(e.summary || "")));
  if (mismatch) {
    return {
      key: `guard:${store}:${day}`, kind: "store_guard", store,
      title: `Store Guard stop: ${name}`,
      message: `${name}: the credentials answered as a different shop. Store Guard stopped; nothing was written.`,
      approvalId: null, hash: "#/agents/page/setup",
    };
  }

  if (e.kind === "cs.draft_guard_stop") {
    return {
      key: `gmail_guard:${store}:${day}`, kind: "store_guard", store,
      title: `Gmail guard stop: ${name}`,
      message: `${name}: the inbox is connected as a different Google account than expected. Drafts stay on the CS page until it is reconnected.`,
      approvalId: null, hash: "#/agents/page/cs",
    };
  }

  if (e.kind === "error.store_timezone") {
    const shop = String(d.shopify || "?").slice(0, 40), cfg = String(d.config || "?").slice(0, 40);
    return {
      key: `tz:${store}:${shop}:${cfg}`, kind: "store_guard", store,
      title: `Store timezone mismatch: ${name}`,
      message: `${name}: Shopify runs on ${shop} but the brain counts days in ${cfg}. P&L days are cut at the wrong hour; day cells are not written until stores.js is fixed.`,
      approvalId: null, hash: "#/agents/page/pnl-extras",
    };
  }
  return null;
}

async function getCursor(db) {
  const r = await db.prepare(`SELECT value FROM agent_cursors WHERE name = ?`).bind(CURSOR).first();
  return r ? Number(r.value) : null;
}
async function setCursor(db, value, at) {
  await db.prepare(`INSERT INTO agent_cursors (name, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(CURSOR, value, at).run();
}

/** The link an alert opens: the signed approval page, or a dashboard route. */
async function linkFor(env, row, nowMs) {
  const base = String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!base) return null;
  if (row.approval_id && env.APPROVAL_SIGNING_KEY) {
    const ap = await getApproval(env.DB, row.approval_id).catch(() => null);
    if (ap && ap.status === "pending") return { url: await approvalPageUrl(env, ap, base, nowMs), title: "Open to decide" };
  }
  return { url: `${base}/${row.hash || "#/"}`, title: "Open Mission Control" };
}

/** Send (live) or record (shadow) one claimed row, then log what happened. */
async function deliver(env, row, { mode, nowMs, fetchImpl }) {
  const db = env.DB;
  const at = nowIso(nowMs);
  if (mode !== "live") {
    await db.prepare(`UPDATE phone_alerts SET status = 'shadow', reason = 'PHONE_ALERTS_LIVE is not 1' WHERE id = ?`).bind(row.id).run();
    await logEvent(db, { actor: ACTOR, kind: "phone.alert_shadow", store: row.store, target: "sys.phone", at,
      summary: `Urgent alert (shadow, not sent to the phone): ${row.title}`, data: { alertId: row.id, item: row.item_key, eventId: row.event_id } });
    return "shadow";
  }
  const link = await linkFor(env, row, nowMs);
  const r = await sendPhone(env, {
    title: scrubAlertText(`Store Brain: ${row.title}`, 250),
    message: scrubAlertText(row.message, 1000),
    url: link ? link.url : null, urlTitle: link ? link.title : null,
  }, { fetchImpl });
  const attempts = Number(row.attempts || 0) + 1;
  if (r.sent) {
    await db.prepare(`UPDATE phone_alerts SET status = 'sent', attempts = ?, sent_at = ?, reason = NULL WHERE id = ?`).bind(attempts, at, row.id).run();
  } else {
    await db.prepare(`UPDATE phone_alerts SET status = 'failed', attempts = ?, reason = ? WHERE id = ?`).bind(attempts, String(r.reason || "not sent").slice(0, 200), row.id).run();
  }
  await logEvent(db, { actor: ACTOR, kind: r.sent ? "phone.alert_sent" : "phone.alert_failed", store: row.store, target: "sys.phone", at,
    summary: r.sent ? `Urgent alert sent to Reilly's phone: ${row.title}` : `Urgent alert not delivered (try ${attempts} of ${MAX_ATTEMPTS}): ${row.title}: ${r.reason}`,
    data: { alertId: row.id, item: row.item_key, eventId: row.event_id, attempts } });
  return r.sent ? "sent" : "failed";
}

/**
 * Claim one item atomically: inserted only if the item is new AND today still has a slot.
 * Returns "claimed" | "duplicate" | "capped".
 */
async function claim(db, a, e, day, at) {
  const title = scrubAlertText(a.title, 200), message = scrubAlertText(a.message, 1000);
  const res = await db.prepare(
    `INSERT INTO phone_alerts (item_key, local_day, kind, store, event_id, title, message, approval_id, hash, status, attempts, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', 0, ?
     WHERE (SELECT COUNT(*) FROM phone_alerts WHERE local_day = ? AND status IN ('claimed', 'sent', 'shadow', 'failed')) < ?
     ON CONFLICT(item_key) DO NOTHING`
  ).bind(a.key, day, a.kind, a.store, e.id, title, message, a.approvalId || null, a.hash || null, at, day, ALERT_CAP_PER_DAY).run();
  if (res.meta && res.meta.changes === 1) return "claimed";
  const seen = await db.prepare(`SELECT id FROM phone_alerts WHERE item_key = ?`).bind(a.key).first();
  if (seen) return "duplicate";
  // Over today's cap: record it once as capped (never tried again), and say so in the log.
  const capped = await db.prepare(
    `INSERT INTO phone_alerts (item_key, local_day, kind, store, event_id, title, message, approval_id, hash, status, attempts, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'capped', 0, ?, ?) ON CONFLICT(item_key) DO NOTHING`
  ).bind(a.key, day, a.kind, a.store, e.id, title, message, a.approvalId || null, a.hash || null, `daily cap of ${ALERT_CAP_PER_DAY} reached`, at).run();
  if (capped.meta && capped.meta.changes === 1) {
    await logEvent(db, { actor: ACTOR, kind: "phone.alert_capped", store: a.store, target: "sys.phone", at,
      summary: `Urgent alert not sent: today's limit of ${ALERT_CAP_PER_DAY} phone alerts is used up (${title}). It is on Mission Control.`,
      data: { item: a.key, eventId: e.id } });
  }
  return "capped";
}

/**
 * One run (every 15-minute cron). Never throws past its caller's try. Returns counts.
 */
export async function runPhoneAlerts(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const day = localDay(nowMs, TZ);
  const mode = modeFor(env, "alerts");
  const out = { mode, read: 0, claimed: 0, sent: 0, shadow: 0, failed: 0, capped: 0, duplicate: 0, retried: 0 };

  // Retries first: today's alerts Pushover refused earlier (they already hold a slot).
  if (mode === "live") {
    const { results: retry } = await db.prepare(`SELECT * FROM phone_alerts WHERE status = 'failed' AND local_day = ? AND attempts < ? ORDER BY id`)
      .bind(day, MAX_ATTEMPTS).all();
    for (const row of retry || []) {
      out.retried++;
      out[await deliver(env, row, { mode, nowMs, fetchImpl })]++;
    }
  }

  let from = await getCursor(db);
  if (from == null) {
    // Start just before the first event of the last hour; with none, at the newest event.
    const r = await db.prepare(`SELECT MIN(id) AS first, (SELECT COALESCE(MAX(id), 0) FROM events) AS last FROM events WHERE at >= ?`)
      .bind(nowIso(nowMs - FIRST_RUN_LOOKBACK_MIN * 60000)).first();
    from = r && r.first != null ? Number(r.first) - 1 : Number((r && r.last) || 0);
  }
  const marks = WATCHED_KINDS.map(() => "?").join(", ");
  let last = from;
  for (let p = 0; p < MAX_PAGES; p++) {
    const { results } = await db.prepare(
      `SELECT id, at, actor, kind, store, target, summary, data FROM events
        WHERE id > ? AND (kind IN (${marks}) OR (kind LIKE 'error.%' AND summary LIKE '%STORE%MISMATCH%'))
        ORDER BY id LIMIT ?`
    ).bind(last, ...WATCHED_KINDS, PAGE).all();
    const page = results || [];
    for (const e of page) {
      out.read++;
      last = e.id;
      const a = alertFor(e);
      if (!a) continue;
      const c = await claim(db, a, e, day, at);
      out[c]++;
      if (c !== "claimed") continue;
      const row = await db.prepare(`SELECT * FROM phone_alerts WHERE item_key = ?`).bind(a.key).first();
      out[await deliver(env, row, { mode, nowMs, fetchImpl })]++;
    }
    if (page.length < PAGE) break;
  }
  if (last !== from || (await getCursor(db)) == null) await setCursor(db, last, at);
  return out;
}

/** For the dashboard: today's alerts and the switch. */
export async function phoneAlertsState(env, { nowMs = Date.now() } = {}) {
  const day = localDay(nowMs, TZ);
  const { results } = await env.DB.prepare(`SELECT id, kind, store, title, status, created_at, sent_at, reason FROM phone_alerts WHERE local_day = ? ORDER BY id DESC LIMIT 20`).bind(day).all();
  const rows = results || [];
  return { mode: modeFor(env, "alerts"), cap: ALERT_CAP_PER_DAY, used: rows.filter((r) => r.status !== "capped").length, today: rows };
}
