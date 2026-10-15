/**
 * KFB copy-paste messages — plain code, no AI.
 *
 * Decided by Reilly 2026-10-11: no WhatsApp API. The brain writes the message for the
 * KFB group, Reilly gets a phone notification with a link to a signed page showing the
 * message and a Copy button, and he pastes and sends it himself (rule 12).
 *
 * It asks for two things (each a "kind" of line):
 *   express  add express shipping to the orders whose customers paid for it
 *   pickup   check a parcel KFB marked shipped 3+ days ago that no carrier has scanned yet
 *            (status from 17TRACK, see tracking.js; only a fresh status counts)
 *
 * When: once per Eastern day, on the first 15-minute cron run at/after 18:45 New York
 * time. KFB's working day in China starts ~20:00 Eastern and processes the previous
 * day's orders, so the ask must be in the group before then.
 *
 * Mode (rule 11): without SUPPLIER_MESSAGES_LIVE = "1" the message is saved and logged, nothing
 * reaches the phone. `SUPPLIER_MESSAGES_LIVE = "1"` (in wrangler.toml since go-live, 2026-10-14)
 * also notifies. Either way Reilly sends it to KFB himself (decision sup.kfb_channel).
 *
 * Every order asked about is recorded in `kfb_message_items` with a UNIQUE
 * (store, order, kind), so an order is never asked for twice, even across days.
 * Pickup asks are per PARCEL: their kind is `pickup:<tracking number>`, so a second
 * parcel of the same order that gets stuck later is still asked about, once.
 */
import { STORES, STORE_IDS, LIVE_STORE_IDS, parcelTrackingOn } from "../config/stores.js";
import { logEvent } from "./eventlog.js";
import { evaluateFeeds } from "./freshness.js";
import { sendPhone, phoneReady } from "./phone.js";
import { hmacHex, sameText, LINK_TTL_MS } from "./approvals.js";
import { page, esc } from "./approvalPage.js";
import { localDay, nowIso } from "./time.js";
import { modeFor } from "../config/live.js";
import { PICKUP_STUCK_DAYS, LOOKBACK_DAYS as TRACKING_LOOKBACK_DAYS, STATUS_FRESH_MS, shortDate } from "./tracking.js";

export const KFB_TZ = "America/New_York";
/** 18:45 Eastern, in minutes after midnight. */
export const COMPOSE_AFTER_MIN = 18 * 60 + 45;
/**
 * How far back an express order is still asked about. Covers a missed day or two
 * (outage), but keeps orders imported from long ago (the first pull brings in 25 recent
 * orders, some already expressed by hand) out of the message.
 */
export const LOOKBACK_DAYS = 3;
/** Orders in these payment states are not worth an express ask. */
const SKIP_STATUSES = ["refunded", "voided"];

const ACTOR = "sup.relay";

/** SUPPLIER_MESSAGES_LIVE, read in one place (src/config/live.js). */
export function supplierMode(env) {
  return modeFor(env, "supplier");
}

/** Eastern calendar day and minutes past midnight, at a moment. */
export function easternClock(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: KFB_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { day: localDay(nowMs, KFB_TZ), minutes: get("hour") * 60 + get("minute") };
}

function dayMinus(day, n) {
  const ms = Date.parse(`${day}T12:00:00Z`) - n * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

const storeOrder = (id) => {
  const i = STORE_IDS.indexOf(id);
  return i < 0 ? 99 : i;
};

/**
 * The message Reilly pastes. Always names the store: order numbers overlap across
 * stores (H&C #1231 and Auberlane #1231 can both exist).
 */
export function composeExpressBody(items) {
  if (!items.length) return null;
  const sorted = [...items].sort((a, b) => storeOrder(a.store) - storeOrder(b.store) ||
    String(a.order_name).localeCompare(String(b.order_name), "en", { numeric: true }));
  return "Please add express shipping to these orders:\n" +
    sorted.map((i) => `• ${STORES[i.store] ? STORES[i.store].name : i.store} ${i.order_name}`).join("\n");
}

/** One line per order whose parcel hasn't been picked up. Store name in every line. */
export function composePickupBody(items) {
  if (!items.length) return null;
  const sorted = [...items].sort((a, b) => storeOrder(a.store) - storeOrder(b.store) ||
    String(a.order_name).localeCompare(String(b.order_name), "en", { numeric: true }));
  return sorted.map((i) =>
    `Please check ${STORES[i.store] ? STORES[i.store].name : i.store} ${i.order_name} (${i.tracking}) — shipped ${shortDate(i.shipped_at)}, not picked up by the carrier yet.`
  ).join("\n");
}

/**
 * Parcel tracking switched off (Reilly, Oct 13): take the carrier-pickup lines out of every
 * KFB message he hasn't sent yet, rebuilding the text from what's left (the express asks).
 * A message with nothing left is marked 'cleared' so it stops waiting on him.
 */
export const CLEARED_NOTE = "Nothing to send: this message only had carrier-pickup checks, and parcel tracking was switched off (Oct 13).";
export async function stripPickupLines(db, at = nowIso()) {
  const { results: msgs } = await db.prepare(`SELECT id, body FROM kfb_messages WHERE status != 'sent' AND status != 'cleared'`).all();
  let changed = 0, cleared = 0, removed = 0;
  for (const m of msgs || []) {
    const { results: items } = await db.prepare(`SELECT store, order_id, order_name, kind, detail FROM kfb_message_items WHERE message_id = ?`).bind(m.id).all();
    const pick = (items || []).filter((i) => isPickupKind(i.kind));
    if (!pick.length) continue;
    await db.prepare(`DELETE FROM kfb_message_items WHERE message_id = ? AND (kind = 'pickup' OR kind LIKE 'pickup:%')`).bind(m.id).run();
    removed += pick.length;
    const left = (items || []).filter((i) => !isPickupKind(i.kind));
    const body = composeKfbBody(left);
    if (body) await db.prepare(`UPDATE kfb_messages SET body = ?, items = ? WHERE id = ?`).bind(body, JSON.stringify(left), m.id).run();
    else {
      // Nothing left: replace the text too, so the old pickup lines can't be copied and sent.
      await db.prepare(`UPDATE kfb_messages SET status = 'cleared', body = ?, items = '[]' WHERE id = ?`).bind(CLEARED_NOTE, m.id).run();
      cleared++;
    }
    changed++;
  }
  if (changed) {
    await logEvent(db, {
      actor: ACTOR, kind: "kfb.pickup_lines_removed", target: "sys.kfb",
      summary: `Parcel tracking is off: removed ${removed} carrier-pickup line${removed === 1 ? "" : "s"} from ${changed} unsent KFB message${changed === 1 ? "" : "s"}` +
        (cleared ? ` (${cleared} had nothing else and no longer wait on Reilly)` : ""),
      data: { changed, cleared, removed }, at,
    }).catch(() => {});
  }
  return { changed, cleared, removed };
}

/** The whole message: one section per kind, express first (it's time-critical). */
export const isPickupKind = (kind) => kind === "pickup" || String(kind || "").startsWith("pickup:");

export function composeKfbBody(items) {
  const parts = [
    composeExpressBody(items.filter((i) => i.kind === "express")),
    composePickupBody(items.filter((i) => isPickupKind(i.kind))),
  ].filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}

/**
 * Parcels with tracking that no carrier has picked up 3+ days after KFB shipped them,
 * judged on a FRESH 17TRACK status only, and never asked about before (per parcel).
 * One line per parcel, each naming the store and the order.
 */
async function pickupCandidates(db, nowMs) {
  if (!LIVE_STORE_IDS.length) return [];
  const marks = LIVE_STORE_IDS.map(() => "?").join(", ");
  const { results } = await db.prepare(
    `SELECT s.store, s.order_id, s.order_name, s.tracking_number, s.shipped_at
       FROM shipments s
      WHERE s.store IN (${marks})
        AND s.state = 'awaiting_pickup'
        AND s.polled_at >= ?
        AND s.shipped_at <= ?
        AND s.order_created_at >= ?
        AND NOT EXISTS (SELECT 1 FROM kfb_message_items i
                         WHERE i.store = s.store AND i.order_id = s.order_id
                           AND (i.kind = 'pickup:' || s.tracking_number
                                -- older per-order lines (kind 'pickup') listed their numbers in detail
                                OR (i.kind = 'pickup' AND instr(COALESCE(i.detail, ''), s.tracking_number) > 0)))
      ORDER BY s.shipped_at, s.tracking_number`
  ).bind(...LIVE_STORE_IDS, nowIso(nowMs - STATUS_FRESH_MS), nowIso(nowMs - PICKUP_STUCK_DAYS * 86400000),
    nowIso(nowMs - TRACKING_LOOKBACK_DAYS * 86400000)).all();
  return (results || []).map((r) => ({
    store: r.store, order_id: r.order_id, order_name: r.order_name || r.order_id, kind: `pickup:${r.tracking_number}`,
    tracking: r.tracking_number, shipped_at: r.shipped_at,
    detail: `${r.tracking_number}; shipped ${String(r.shipped_at || "").slice(0, 10)}`,
  }));
}

/** Plain-English list for the event summary, per kind. */
function describeItems(items) {
  const parts = [];
  const ex = items.filter((i) => i.kind === "express");
  const pk = items.filter((i) => isPickupKind(i.kind));
  const names = (xs) => xs.map((i) => `${STORES[i.store].name} ${i.order_name}`).join(", ");
  if (ex.length) parts.push(`express shipping for ${ex.length} order${ex.length === 1 ? "" : "s"}: ${names(ex)}`);
  if (pk.length) parts.push(`carrier pickup check for ${pk.length} parcel${pk.length === 1 ? "" : "s"}: ${pk.map((i) => `${STORES[i.store].name} ${i.order_name} (${i.tracking})`).join(", ")}`);
  return parts.join("; ");
}

/** Express orders not yet asked about, newest few days only, live stores only. */
async function expressCandidates(db, today) {
  if (!LIVE_STORE_IDS.length) return [];
  const marks = LIVE_STORE_IDS.map(() => "?").join(", ");
  const { results } = await db.prepare(
    `SELECT o.store, o.order_id, o.name, o.shipping_title, o.shipping_code, o.created_at
       FROM orders o
      WHERE o.express = 1
        AND o.store IN (${marks})
        AND o.local_day >= ?
        AND COALESCE(o.financial_status, '') NOT IN (${SKIP_STATUSES.map(() => "?").join(", ")})
        AND NOT EXISTS (SELECT 1 FROM kfb_message_items i
                         WHERE i.store = o.store AND i.order_id = o.order_id AND i.kind = 'express')
      ORDER BY o.created_at`
  ).bind(...LIVE_STORE_IDS, dayMinus(today, LOOKBACK_DAYS), ...SKIP_STATUSES).all();
  return results || [];
}

/**
 * Rule 4: freshness before numbers. If an orders feed isn't fresh, the list may be
 * missing orders. The message still goes out (late express is worse), but it says so.
 */
async function staleOrderFeeds(db, nowMs) {
  const feeds = await evaluateFeeds(db, nowMs);
  return LIVE_STORE_IDS
    .map((id) => feeds.find((f) => f.id === `shopify.orders.${id}`))
    .filter((f) => !f || f.current !== "fresh")
    .map((f) => (f ? `${f.label} is ${f.current.replace("_", " ")}` : "an orders feed is missing"));
}

/**
 * The cron step. Safe to call every 15 minutes: does nothing before 18:45 Eastern, and
 * only the first run after it (per Eastern day) composes.
 * @returns {Promise<object>} what happened, for tests and logs
 */
export async function runKfbComposer(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const db = env.DB;
  const { day, minutes } = easternClock(nowMs);
  if (minutes < COMPOSE_AFTER_MIN) return { ran: false, reason: "before 18:45 Eastern" };

  const at = nowIso(nowMs);
  // Claim today atomically. A second (or overlapping) run finds the claim and stops.
  const claim = await db.prepare(
    `INSERT INTO kfb_runs (local_day, ran_at) VALUES (?, ?) ON CONFLICT(local_day) DO NOTHING`
  ).bind(day, at).run();
  if (!claim.meta || claim.meta.changes !== 1) return { ran: false, reason: "already ran today" };

  let notified = false;
  let messageId = null;
  try {
    const rows = await expressCandidates(db, day);
    // Pickup lines come from the tracking ledger. A fault there must not cost the express asks.
    let pickups = [];
    try {
      // Parcel tracking is off (Reilly, Oct 13): no carrier-pickup lines from old statuses.
      pickups = parcelTrackingOn(env) ? await pickupCandidates(db, nowMs) : [];
    } catch (err) {
      await logEvent(db, {
        actor: ACTOR, kind: "error.kfb_pickup_lines", target: "sys.kfb",
        summary: `KFB message: couldn't read stuck parcels, so no pickup lines today (${String(err && err.message).slice(0, 150)})`, at,
      }).catch(() => {});
    }
    const warnings = await staleOrderFeeds(db, nowMs);
    if (!rows.length && !pickups.length) {
      await logEvent(db, {
        actor: ACTOR, kind: "kfb.nothing_to_ask", target: "sys.kfb",
        summary: `KFB check ${day}: no new express orders or stuck parcels, so no message today` +
          (warnings.length ? ` (but ${warnings.join("; ")}: an order may be missing)` : ""),
        data: { day, warnings }, at,
      });
      return { ran: true, day, messageId: null, items: [] };
    }

    const items = rows.map((r) => ({
      store: r.store, order_id: r.order_id, order_name: r.name || r.order_id, kind: "express",
      detail: r.shipping_title || r.shipping_code || null,
    })).concat(pickups);
    const body = composeKfbBody(items);
    const mode = supplierMode(env);
    const ins = await db.prepare(
      `INSERT INTO kfb_messages (created_at, local_day, mode, body, items, status) VALUES (?, ?, ?, ?, ?, 'draft')`
    ).bind(at, day, mode, body, JSON.stringify(items)).run();
    messageId = ins.meta.last_row_id;
    for (const it of items) {
      await db.prepare(
        `INSERT INTO kfb_message_items (message_id, store, order_id, order_name, kind, detail)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(store, order_id, kind) DO NOTHING`
      ).bind(messageId, it.store, it.order_id, it.order_name, it.kind, it.detail).run();
    }
    await db.prepare(`UPDATE kfb_runs SET message_id = ?, item_count = ? WHERE local_day = ?`)
      .bind(messageId, items.length, day).run();

    const list = describeItems(items);
    const warnText = warnings.length ? ` Warning: ${warnings.join("; ")}, so an order may be missing.` : "";
    let phone = null;
    if (mode === "live") {
      phone = await notifyKfbMessage(env, { id: messageId, created_at: at, body }, { nowMs, fetchImpl, warnings });
      notified = !!phone.sent;
      if (phone.sent) {
        await db.prepare(`UPDATE kfb_messages SET status = 'notified' WHERE id = ? AND status = 'draft'`).bind(messageId).run();
      }
    }
    await logEvent(db, {
      actor: ACTOR,
      kind: mode === "shadow" ? "kfb.message_drafted" : phone.sent ? "kfb.message_notified" : "kfb.notify_failed",
      target: mode === "live" ? "sys.phone" : "sys.kfb",
      summary: (mode === "shadow"
        ? `KFB message drafted (shadow, not sent to phone): ${list}`
        : phone.sent
          ? `KFB message ready on Reilly's phone: ${list}`
          : `KFB message drafted but the phone notification failed (${phone.reason}): ${list}`) + warnText,
      data: { messageId, day, mode, orders: items.map((i) => ({ store: i.store, order: i.order_name, kind: i.kind })), warnings },
      at,
    });
    return { ran: true, day, messageId, mode, body, items, phone, warnings };
  } catch (err) {
    // Already on Reilly's phone: keep the message and the day claimed; a resend would
    // make him paste the same orders twice. Only the bookkeeping after the send failed.
    if (notified) throw err;
    // Undo the half-done day so the next 15-minute run tries again.
    if (messageId != null) {
      await db.prepare(`DELETE FROM kfb_message_items WHERE message_id = ?`).bind(messageId).run().catch(() => {});
      await db.prepare(`DELETE FROM kfb_messages WHERE id = ?`).bind(messageId).run().catch(() => {});
    }
    await db.prepare(`DELETE FROM kfb_runs WHERE local_day = ?`).bind(day).run().catch(() => {});
    throw err;
  }
}

/* ---------- signed links ---------- */

/**
 * Same HMAC approach as approval links: binds the message id AND its creation time (a
 * recreated ledger can't reuse an old link), the action ("view" or "sent") and the expiry.
 */
export const signKfb = (secret, msg, action, expMs) =>
  hmacHex(secret, `kfb:${msg.id}:${msg.created_at}:${action}:${expMs}`);

export async function verifyKfbSig(secret, msg, action, sig, expMs, nowMs = Date.now()) {
  if (!secret || !sig || !msg) return false;
  const exp = Number(expMs);
  if (!Number.isFinite(exp) || exp < nowMs) return false;
  return sameText(await signKfb(secret, msg, action, exp), sig);
}

export async function kfbPageUrl(env, msg, baseUrl, nowMs = Date.now()) {
  const exp = nowMs + LINK_TTL_MS;
  const sig = await signKfb(env.APPROVAL_SIGNING_KEY, msg, "view", exp);
  return `${baseUrl}/kfb/${msg.id}?exp=${exp}&sig=${sig}`;
}

/**
 * Push the message to Reilly's phone with a link to the copy page.
 * The cron has no request to learn its own address from, so the link's base comes from
 * the PUBLIC_BASE_URL variable (e.g. https://store-brain.<subdomain>.workers.dev).
 */
export async function notifyKfbMessage(env, msg, { nowMs = Date.now(), fetchImpl = fetch, warnings = [] } = {}) {
  const baseUrl = String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!phoneReady(env)) return { sent: false, reason: "Pushover keys are not set in Cloudflare yet" };
  if (!env.APPROVAL_SIGNING_KEY) return { sent: false, reason: "APPROVAL_SIGNING_KEY is not set" };
  if (!baseUrl) return { sent: false, reason: "PUBLIC_BASE_URL is not set" };
  return sendPhone(env, {
    title: "Store Brain: KFB message ready to send",
    message: msg.body + (warnings.length ? `\n\n⚠ ${warnings.join("; ")}: an order may be missing.` : ""),
    url: await kfbPageUrl(env, msg, baseUrl, nowMs),
    urlTitle: "Open to copy",
  }, { fetchImpl });
}

/* ---------- reading + marking sent ---------- */

export async function getKfbMessage(db, id) {
  const row = await db.prepare(`SELECT * FROM kfb_messages WHERE id = ?`).bind(id).first();
  return row ? { ...row, items: safeJson(row.items) || [] } : null;
}

/** Reilly says he sent it. Recorded once; a second tap (or a race) changes nothing. */
export async function markKfbSent(db, id, nowMs = Date.now()) {
  const msg = await getKfbMessage(db, id);
  if (!msg) return { ok: false, error: "not_found" };
  if (msg.status === "sent") return { ok: false, error: "already_sent", sent_at: msg.sent_at };
  if (msg.status === "cleared") return { ok: false, error: "nothing_to_send" };
  const at = nowIso(nowMs);
  const res = await db.prepare(`UPDATE kfb_messages SET status = 'sent', sent_at = ? WHERE id = ? AND status NOT IN ('sent', 'cleared')`)
    .bind(at, id).run();
  if (!res.meta || res.meta.changes !== 1) return { ok: false, error: "already_sent" };
  const n = msg.items.length;
  await logEvent(db, {
    actor: ACTOR, kind: "kfb.message_sent", target: "sys.kfb",
    summary: `Reilly marked the KFB message of ${msg.local_day} as sent (${n} order${n === 1 ? "" : "s"})`,
    data: { messageId: id, mode: msg.mode }, at,
  });
  return { ok: true, status: "sent", sent_at: at };
}

/** Latest messages for Mission Control. */
export async function listKfbMessages(db, limit = 10) {
  const { results } = await db.prepare(`SELECT * FROM kfb_messages ORDER BY id DESC LIMIT ?`).bind(limit).all();
  return (results || []).map((r) => {
    const items = safeJson(r.items) || [];
    return { id: r.id, created_at: r.created_at, local_day: r.local_day, mode: r.mode, status: r.status, sent_at: r.sent_at, body: r.body, item_count: items.length };
  });
}

/** Today's (Eastern) express orders on live stores, and whether KFB has been asked yet. */
export async function expressOrdersToday(db, nowMs = Date.now()) {
  if (!LIVE_STORE_IDS.length) return [];
  const today = localDay(nowMs, KFB_TZ);
  const { results } = await db.prepare(
    `SELECT o.store, o.order_id, o.name, o.shipping_title, o.created_at, i.message_id AS asked_in
       FROM orders o
       LEFT JOIN kfb_message_items i ON i.store = o.store AND i.order_id = o.order_id AND i.kind = 'express'
      WHERE o.express = 1 AND o.local_day = ? AND o.store IN (${LIVE_STORE_IDS.map(() => "?").join(", ")})
      ORDER BY o.created_at`
  ).bind(today, ...LIVE_STORE_IDS).all();
  return (results || []).map((r) => ({ ...r, store_name: STORES[r.store] ? STORES[r.store].name : r.store }));
}

function safeJson(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}

/* ---------- the phone page ---------- */

const PAGE_CSS = `textarea{width:100%;min-height:140px;background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:12px;font:14px/1.5 Inter,system-ui,sans-serif;resize:vertical}
.row2{display:flex;gap:8px}.row2 button{flex:1}#out{margin-top:12px}`;

/** GET /kfb/:id?exp&sig — the message in a box, Copy, and Mark sent. */
export async function handleKfbPage(request, env, id) {
  const url = new URL(request.url);
  const exp = url.searchParams.get("exp");
  const msg = await getKfbMessage(env.DB, id);
  // Same answer for "no such message" and "bad link": don't confirm what exists.
  if (!msg || !(await verifyKfbSig(env.APPROVAL_SIGNING_KEY, msg, "view", url.searchParams.get("sig"), exp))) {
    return page("Link not valid", `<h1>This link isn't valid</h1><div class="meta">It may have expired (links last 7 days). Open Mission Control → Supplier instead.</div>`, 403);
  }
  const sentSig = await signKfb(env.APPROVAL_SIGNING_KEY, msg, "sent", Number(exp));
  const action = `/api/kfb/${msg.id}/sent?exp=${encodeURIComponent(exp)}&sig=${sentSig}`;
  const n = msg.items.length;
  if (msg.status === "cleared") {
    return page("Nothing to send", `<h1>Nothing to send</h1><div class="meta">${esc(msg.local_day)}</div><p>${esc(CLEARED_NOTE)}</p>`);
  }
  const status = msg.status === "sent"
    ? `<div class="done good">Marked sent ${esc(String(msg.sent_at || "").slice(0, 16).replace("T", " "))} UTC</div>`
    : `<button id="sent" data-a="${esc(action)}">Mark sent</button>`;
  const inner = `<h1>Message for the KFB group</h1>
<div class="meta">${esc(msg.local_day)} · ${n} order${n === 1 ? "" : "s"} · ${esc(msg.mode)}${msg.mode === "shadow" ? " (draft only)" : ""}</div>
<textarea id="body" readonly>${esc(msg.body)}</textarea>
<div class="row2"><button id="copy">Copy</button></div>
${status}<div id="out"></div>
<script>
var out=document.getElementById("out"), box=document.getElementById("body");
document.getElementById("copy").addEventListener("click", async function(){
  try{ await navigator.clipboard.writeText(box.value); }
  catch(e){ box.focus(); box.select(); try{ document.execCommand("copy"); }catch(_){ } }
  this.textContent="Copied";
});
var s=document.getElementById("sent");
if(s) s.addEventListener("click", async function(){
  s.disabled=true;
  try{
    var r=await fetch(s.dataset.a,{method:"POST"}); var j=await r.json();
    out.innerHTML=j.ok?'<div class="done good">Recorded as sent</div>'
      :'<div class="done warn">Not recorded: '+String(j.error||r.status).replace(/[<>&]/g,"")+'</div>';
    if(j.ok) s.hidden=true; else s.disabled=false;
  }catch(e){ out.innerHTML='<div class="done bad">Couldn\\'t reach the brain. Nothing was recorded; try again.</div>'; s.disabled=false; }
});
</script>`;
  return page("KFB message", inner, 200, PAGE_CSS);
}

/** POST /api/kfb/:id/sent — allowed with the Mission Control key or a signed "sent" link. */
export async function handleKfbSent(request, env, id, viaKey) {
  const json = (b, status) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  if (!viaKey) {
    const url = new URL(request.url);
    const msg = await getKfbMessage(env.DB, id);
    const ok = await verifyKfbSig(env.APPROVAL_SIGNING_KEY, msg, "sent", url.searchParams.get("sig"), url.searchParams.get("exp"));
    if (!ok) return json({ ok: false, error: "unauthorized" }, 401);
  }
  const res = await markKfbSent(env.DB, id);
  return json(res, res.ok ? 200 : res.error === "not_found" ? 404 : 409);
}

