/**
 * Store Brain — Cloudflare Worker entry point (Phase 1: foundation).
 *
 * Routes
 *   GET  /health                         public, no data — is the brain up?
 *   GET  /api/state                      Mission Control data (key required)
 *   GET  /api/pnl?store=all|hc|aub|mar    every stored P&L day + payouts for the P&L page (key required)
 *   GET  /api/agents/:id/events          one agent's latest events, for its page (key required)
 *   POST /api/brief/rewrite              compose today's brief again from fresh numbers (key required)
 *   GET  /api/dept/:id                   one department's dashboard data (cs, media, catalog, risk, supplier, core, pnl, fulfillment)
 *   GET  /api/funnel?store&from&to        Shopify sessions funnel for the P&L page (key required)
 *   GET  /api/vault/outbox               facts/decisions waiting to be copied to the Eagano vault (key required)
 *   POST /api/vault/outbox/copied        mark them copied, body {ids:[...]} (key required)
 *   POST /api/approvals/:id/decide       Reilly's decision (key OR a signed phone link)
 *   POST /api/size-charts                add a factory size chart by hand {store, product_handle|product_id, unit, flat, rows} (key required; saved unchecked)
 *   POST /api/size-charts/image          the brain reads a chart image {store, product_handle, image_base64, media_type} (key required; always unchecked)
 *   POST /api/size-charts/:id/confirm    Reilly checked that chart (key required)
 *   POST /api/import/kfb                 the KFB morning import the bookmarklet read (key required; ≤ 5 MB; nothing goes to KFB)
 *   POST /webhooks/shopify               Shopify webhooks (HMAC-verified per store)
 *   POST /webhooks/17track               17TRACK pushes (`sign` header verified; known numbers re-read from the API)
 *   POST /api/admin/check-stores         Store Guard check for every live store (key required)
 *   POST /api/admin/webhooks             connect order/refund notifications (key required)
 *   POST /api/admin/test-notification    send a test message to Reilly's phone (key required)
 *   GET  /approve/:id                    phone approval page (signed link from a notification)
 *   GET  /kfb/:id                        KFB copy-paste message page (signed link from a notification)
 *   POST /api/kfb/:id/sent               Reilly sent the KFB message (key OR a signed "sent" link)
 *   GET  /brief/:id                      morning brief page (signed 48-hour link from the 8:00 notification)
 *   POST /api/admin/google/start         one-time Google consent URL (key required)
 *   GET  /oauth/google/callback          Google sends Reilly back here after consent
 *   GET  /api/admin/connections          which secrets exist (names only) + Google status (key required)
 *   GET  /                               Mission Control page (static, no data until a key is given)
 *
 * Crons
 *   every 15 min  reconciliation pull → orders backfill (history for the P&L) → money feeds (Ads spend and refunds every
 *                 15 min, payouts hourly; throttled in job_runs) → tracking (collect hourly, 17TRACK polls as due, checks)
 *                 → P&L recompute (last 3 days + a few missing history days, every tick) → morning brief (once per day after 08:00 ET)
 *                 → KFB import reminder (once per day from 09:00 ET, only when no import landed)
 *                 → KFB composer (once per day after 18:45 ET) → urgent phone alerts (new events by kind,
 *                 cursor; at most 6 a day, one per item) → Freshness Sentinel
 *   every 5 min   (minutes 1, 6, 11, ... 56) one department agent run, in rotation (src/agents/index.js)
 *   daily 05:00Z  P&L day close (01:00 EDT / 00:00 EST: "yesterday" is always the day that just ended)
 *
 * Secrets (Reilly adds these in Cloudflare; never in this repo):
 *   MC_KEY                 key for Mission Control + API
 *   APPROVAL_SIGNING_KEY   signs phone Approve/Reject links
 *   PUSHOVER_APP_TOKEN     Pushover application token (phone notifications)
 *   PUSHOVER_USER_KEY      Reilly's Pushover user key
 *   ANTHROPIC_API_KEY      Claude API (thinking agents)
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   Google OAuth client (Gmail, Ads, Merchant Center, Sheets)
 *   TRACKING_API_KEY       17TRACK API security key (also verifies 17TRACK pushes)
 *
 *   GOOGLE_ADS_DEVELOPER_TOKEN  optional; Google retired developer tokens on 2026-09-09, so leave it unset
 *
 * Variables (not secret):
 *   GOOGLE_ADS_API_VERSION Google Ads API version, e.g. "v25" (wrangler.toml)
 *   SUPPLIER_MESSAGES_LIVE "1" = KFB messages go to the phone; anything else = shadow
 *   PUBLIC_BASE_URL        this worker's https address, for links in phone notifications sent by crons
 *   BRIEF_MODEL            Claude model id for the morning brief (wrangler.toml)
 *   BRIEF_PHONE_LIVE       "1" = the 8:00 brief also goes to the phone; anything else = shadow
 *   KFB_REMINDER_LIVE      "1" = the 9:00 "KFB import not done today" reminder goes to the phone; else shadow
 *   CS_DRAFTS_LIVE         "1" = customer replies are saved as Gmail DRAFTS (never sent); else they stay on the CS page
 *   PHONE_ALERTS_LIVE      "1" = urgent alerts (chargeback due in 48 h, spend alarm, HIGH fraud, incident, Store Guard)
 *                          go to the phone; else logged only
 *   GO_LIVE                "1" = the watching/reporting agents are labelled live (Reilly's go-live, 2026-10-14)
 *   All six are "1" in wrangler.toml since go-live; see src/config/live.js. Reilly turns one off with "0".
 *   SB_<STORE>_CLIENT_ID / SB_<STORE>_CLIENT_SECRET   per-store Shopify app credentials
 */
import { STORES, LIVE_STORE_IDS } from "./config/stores.js";
import { DEPARTMENTS, SERVICES, SYSTEMS, isKnownActor, RETIRED_AGENTS, agentsWithMode } from "./config/agents.js";
import { recentEvents, costSince, logEvent, agentEvents } from "./lib/eventlog.js";
import { evaluateFeeds, runSentinel, ensureFeeds } from "./lib/freshness.js";
import { listPending, decide, verifyDecisionSig, getApproval } from "./lib/approvals.js";
import { sendTestNotification } from "./lib/phone.js";
import { handleApprovalPage } from "./lib/approvalPage.js";
import { handleShopifyWebhook } from "./lib/shopifyWebhooks.js";
import { localDay } from "./lib/time.js";
import { checkStores, registerWebhooks } from "./lib/setup.js";
import { reconcileOrders } from "./lib/reconcile.js";
import { runOrderBackfill } from "./lib/orderBackfill.js";
import { runHistoryExtension } from "./lib/historyExtend.js";
import { applyRefundHistory } from "./lib/refundHistoryImport.js";
import { runMoneyJobs } from "./lib/moneyJobs.js";
import { moneyState } from "./lib/moneyState.js";
import { payoutsState } from "./lib/payoutsState.js";
import { startGoogleConnect, handleGoogleCallback, googleStatus, mailboxStatus, secretPresence } from "./lib/google.js";
import {
  runKfbComposer, handleKfbPage, handleKfbSent, listKfbMessages, expressOrdersToday, supplierMode,
} from "./lib/kfbMessage.js";
import { runTracking, handleTrackingPush, shippingState } from "./lib/tracking.js";
import { runPnlCron, runDayClose, pnlState, pnlHistory } from "./lib/pnl.js";
import { runBrief, latestBrief, handleBriefPage, briefMode, rewriteBrief } from "./lib/brief.js";
import { runDepartmentSlot, departmentState, DEPARTMENTS_RUN, DEPT_CRON } from "./agents/index.js";
import { funnelFor } from "./agents/pnl/index.js";
import { vaultOutbox, markVaultCopied } from "./agents/core/librarian.js";
import { addPastedChart, addChartFromImage, confirmChart } from "./agents/supplier/sizeIntake.js";
import { handleKfbImport, runKfbReminder, kfbReminderMode } from "./lib/kfbImport.js";
import { kfbImportStatus } from "./lib/kfbReads.js";
import { runPhoneAlerts, phoneAlertsState } from "./lib/phoneAlerts.js";
import { liveSwitches } from "./config/live.js";
import { csCards } from "./agents/cs/index.js";

export const VERSION = "0.2.0-eagano-llc";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function hasKey(request, env) {
  if (!env.MC_KEY) return false; // no key configured = API locked, never open
  // Header only: keys in URLs end up in logs and browser history.
  const given = request.headers.get("x-store-brain-key") || "";
  if (given.length !== env.MC_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ env.MC_KEY.charCodeAt(i);
  return diff === 0;
}

/** Start of "today" in Eastern, as a UTC ISO string (for today's cost/event counts). */
function startOfLocalDayIso(tz) {
  const today = localDay(Date.now(), tz);
  // Search the 30h window around UTC midnight for the instant the local day began.
  const base = Date.parse(`${today}T00:00:00Z`);
  for (let h = -14; h <= 14; h++) {
    const t = base + h * 3600000;
    if (localDay(t, tz) === today && localDay(t - 3600000, tz) !== today) return new Date(t).toISOString();
  }
  return new Date(base).toISOString();
}

async function doneTodayItems(db, todayStart) {
  const { results } = await db.prepare(
    `SELECT id, title, store, requested_by, status, decided_at, result FROM approvals
      WHERE status <> 'pending' AND decided_at >= ? ORDER BY decided_at DESC LIMIT 30`
  ).bind(todayStart).all();
  const rows = results || [];
  const cards = await csCards(db, rows).catch(() => ({}));
  return rows.map((a) => {
    let r = {}; try { r = a.result ? JSON.parse(a.result) : {}; } catch { r = {}; }
    const auto = !!(r && r.not_reilly);
    return {
      id: a.id, title: a.title, store: a.store, requested_by: a.requested_by, decided_at: a.decided_at, card: cards[a.id] || null,
      how: r && r.outcome === "replied_in_gmail" ? "you replied in Gmail" : auto ? "closed by the brain" : a.status === "rejected" ? "you dismissed it" : "you ticked it off",
    };
  });
}

async function handleState(env) {
  await ensureFeeds(env.DB);
  const tz = env.TIMEZONE || "America/New_York";
  const todayStart = startOfLocalDayIso(tz);
  const [events, feeds, approvals, aiCostToday, kfbMessages, expressToday, jobs, shipping] = await Promise.all([
    recentEvents(env.DB, { limit: 300 }),
    evaluateFeeds(env.DB),
    listPending(env.DB),
    costSince(env.DB, todayStart),
    listKfbMessages(env.DB, 10),
    expressOrdersToday(env.DB),
    env.DB.prepare(`SELECT job, last_run_at, last_result FROM job_runs WHERE job IN ('ads.spend','payouts','refunds','brain.tick')`).all(),
    shippingState(env),
  ]);
  const money = await moneyState(env.DB, feeds);
  // Short cards for flagged customer emails (the dashboard's "What needs you").
  const cards = await csCards(env.DB, approvals).catch(() => ({}));
  for (const a of approvals) if (cards[a.id]) a.card = cards[a.id];
  // Today's finished to-do items, so the list can show them crossed off: closed by Reilly's
  // own button, or by the brain seeing it done (e.g. he replied in Gmail).
  const doneToday = await doneTodayItems(env.DB, todayStart).catch(() => []);
  const [pnl, brief, kfbImport, alerts] = await Promise.all([pnlState(env.DB), latestBrief(env.DB), kfbImportStatus(env.DB), phoneAlertsState(env)]);
  return json({
    version: VERSION,
    now: new Date().toISOString(),
    stores: Object.values(STORES).map(({ id, name, live, kfbShopCode }) => ({ id, name, live, kfbShopCode })),
    departments: DEPARTMENTS,
    // status = live or not from the real switch (src/config/live.js); build = how far it is built.
    agents: agentsWithMode(env),
    // The go-live switches, read-only (values are not secrets). Reilly changes them in Cloudflare.
    live: liveSwitches(env),
    alerts,
    retired: RETIRED_AGENTS,
    services: SERVICES,
    systems: SYSTEMS,
    events,
    feeds: feeds.map(({ id, store, label, max_age_min, last_ok_at, last_error, current }) => ({
      id, store, label, max_age_min, last_ok_at, last_error, state: current,
    })),
    approvals,
    doneToday,
    aiCostToday,
    todayStart,
    supplier: { mode: supplierMode(env), kfbMessages, expressToday },
    money: { ...money, jobs: (jobs && jobs.results) || [] },
    shipping,
    pnl,
    brief: { mode: briefMode(env), latest: brief },
    // KFB morning import: "not done today" shows in Waiting on you until one lands.
    kfbImport: { ...kfbImport, reminder: kfbReminderMode(env) },
  });
}

async function handleDecide(request, env, id) {
  const url = new URL(request.url);
  let choice = url.searchParams.get("choice");
  let note = null;
  if (request.headers.get("content-type")?.includes("application/json")) {
    const body = await request.json().catch(() => ({}));
    choice = body.choice || choice;
    note = body.note ? String(body.note).slice(0, 2000) : null;
  }
  if (!choice) return json({ ok: false, error: "choice required" }, 400);

  const viaKey = hasKey(request, env);
  let viaSig = false;
  if (!viaKey) {
    const approval = await getApproval(env.DB, id);
    viaSig = await verifyDecisionSig(env.APPROVAL_SIGNING_KEY, approval, choice, url.searchParams.get("sig"), url.searchParams.get("exp"));
  }
  if (!viaKey && !viaSig) return json({ ok: false, error: "unauthorized" }, 401);

  const res = await decide(env.DB, id, { choice, note });
  return json(res, res.ok ? 200 : 409);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/health") {
        return json({ ok: true, version: VERSION, liveStores: LIVE_STORE_IDS });
      }
      if (path === "/webhooks/shopify" && request.method === "POST") {
        return await handleShopifyWebhook(request, env);
      }
      if (path === "/webhooks/17track" && request.method === "POST") {
        return await handleTrackingPush(request, env);
      }
      if (path === "/api/state" && request.method === "GET") {
        if (!hasKey(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
        return await handleState(env);
      }
      if (path === "/api/pnl" && request.method === "GET") {
        if (!hasKey(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
        const which = String(url.searchParams.get("store") || "all").slice(0, 10);
        const r = await pnlHistory(env.DB, which);
        // The P&L page's Payouts block: next payout + recent paid ones, freshness-gated.
        // A payouts fault never takes the P&L page down with it (the block says "not loaded").
        if (r.ok) r.payouts = await payoutsState(env.DB, which).catch(() => ({ ok: false }));
        return json(r, r.ok ? 200 : 400);
      }
      const ae = path.match(/^\/api\/agents\/([a-z0-9_.]{1,60})\/events$/);
      if (ae && request.method === "GET") {
        if (!hasKey(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
        if (!isKnownActor(ae[1])) return json({ ok: false, error: "unknown agent" }, 404);
        return json({ ok: true, id: ae[1], ...(await agentEvents(env.DB, ae[1])) });
      }
      const dm = path.match(/^\/api\/dept\/([a-z]{2,12})$/);
      if (dm && request.method === "GET") {
        if (!hasKey(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
        if (!DEPARTMENTS_RUN[dm[1]]) return json({ ok: false, error: "unknown department" }, 404);
        return json({ ok: true, dept: dm[1], state: await departmentState(env, dm[1]) });
      }
      if (path === "/api/funnel" && request.method === "GET") {
        if (!hasKey(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
        const day = (k) => { const v = String(url.searchParams.get(k) || ""); return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; };
        const from = day("from"), to = day("to");
        if (!from || !to || from > to) return json({ ok: false, error: "from/to required (YYYY-MM-DD)" }, 400);
        const r = await funnelFor(env.DB, String(url.searchParams.get("store") || "all").slice(0, 10), from, to);
        return json(r, r.ok ? 200 : 400);
      }
      if (path === "/api/vault/outbox" && request.method === "GET") {
        if (!hasKey(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
        return json({ ok: true, items: await vaultOutbox(env.DB, { limit: url.searchParams.get("limit") || 50 }) });
      }
      if (path === "/api/vault/outbox/copied" && request.method === "POST") {
        if (!hasKey(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
        const body = await request.json().catch(() => ({}));
        return json({ ok: true, marked: await markVaultCopied(env.DB, Array.isArray(body.ids) ? body.ids : []) });
      }
      if (path === "/api/brief/rewrite" && request.method === "POST") {
        if (!hasKey(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
        const r = await rewriteBrief(env);
        return json(r, r.ok ? 200 : 409);
      }
      if (path === "/api/admin/check-stores" && request.method === "POST") {
        if (!hasKey(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
        return json({ ok: true, results: await checkStores(env) });
      }
      if (path === "/api/admin/webhooks" && request.method === "POST") {
        if (!hasKey(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
        return json({ ok: true, results: await registerWebhooks(env, url.origin) });
      }
      if (path === "/api/admin/test-notification" && request.method === "POST") {
        if (!hasKey(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
        const r = await sendTestNotification(env);
        await logEvent(env.DB, {
          actor: "core.approvals", kind: r.sent ? "phone.test_sent" : "phone.test_failed", target: "sys.phone",
          summary: r.sent ? "Test notification sent to Reilly's phone" : `Test notification failed: ${r.reason}`,
        });
        return json({ ok: true, results: [r] });
      }
      if (path === "/api/admin/google/start" && request.method === "POST") {
        if (!hasKey(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
        const body = request.headers.get("content-type")?.includes("application/json") ? await request.json().catch(() => ({})) : {};
        const r = await startGoogleConnect(env, { target: String(body.target || "main").slice(0, 20) });
        return json(r, r.ok ? 200 : 400);
      }
      if (path === "/oauth/google/callback" && request.method === "GET") {
        return await handleGoogleCallback(request, env);
      }
      if (path === "/api/admin/connections" && request.method === "GET") {
        if (!hasKey(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
        return json({ ok: true, secrets: secretPresence(env), google: await googleStatus(env.DB), mailboxes: await mailboxStatus(env) });
      }
      // Size-chart intake (Supplier): saved unchecked; nothing goes to KFB, a customer or the store.
      if ((path === "/api/size-charts" || path === "/api/size-charts/image") && request.method === "POST") {
        if (!hasKey(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object") return json({ ok: false, error: "JSON body required" }, 400);
        const r = path.endsWith("/image") || body.image_base64 ? await addChartFromImage(env, body) : await addPastedChart(env, body);
        return json(r, r.ok ? 200 : r.status || 400);
      }
      // KFB morning import (the bookmarklet's rows, posted by the dashboard). Read-only towards KFB.
      if (path === "/api/import/kfb" && request.method === "POST") {
        if (!hasKey(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
        return await handleKfbImport(request, env);
      }
      const sc = path.match(/^\/api\/size-charts\/(\d{1,12})\/confirm$/);
      if (sc && request.method === "POST") {
        if (!hasKey(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
        const r = await confirmChart(env, parseInt(sc[1], 10));
        return json(r, r.ok ? 200 : r.status || 400);
      }
      const ap = path.match(/^\/approve\/(\d+)$/);
      if (ap && request.method === "GET") {
        return await handleApprovalPage(request, env, parseInt(ap[1], 10));
      }
      const kp = path.match(/^\/kfb\/(\d+)$/);
      if (kp && request.method === "GET") {
        return await handleKfbPage(request, env, parseInt(kp[1], 10));
      }
      const bp = path.match(/^\/brief\/(\d+)$/);
      if (bp && request.method === "GET") {
        return await handleBriefPage(request, env, parseInt(bp[1], 10));
      }
      const ks = path.match(/^\/api\/kfb\/(\d+)\/sent$/);
      if (ks && request.method === "POST") {
        return await handleKfbSent(request, env, parseInt(ks[1], 10), hasKey(request, env));
      }
      const m = path.match(/^\/api\/approvals\/(\d+)\/decide$/);
      if (m && request.method === "POST") {
        return await handleDecide(request, env, parseInt(m[1], 10));
      }
      if (path.startsWith("/api/")) return json({ ok: false, error: "not found" }, 404);
      // Everything else is the static Mission Control page.
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Mission Control assets not bound", { status: 500 });
    } catch (err) {
      // Never leak internals; log the failure so it shows on Mission Control.
      try {
        await logEvent(env.DB, {
          actor: "core.incidents", kind: "error.request",
          summary: `Request to ${path} failed: ${String(err && err.message).slice(0, 200)}`,
        });
      } catch { /* the log itself failed; nothing more we can do here */ }
      return json({ ok: false, error: "internal error" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        // Heartbeat for the dashboard: when the brain last woke up (any schedule).
        await env.DB.prepare(`INSERT INTO job_runs (job, last_run_at, last_result) VALUES ('brain.tick', ?, ?) ON CONFLICT(job) DO UPDATE SET last_run_at = excluded.last_run_at, last_result = excluded.last_result`)
          .bind(new Date(Number(event.scheduledTime) || Date.now()).toISOString(), String(event.cron).slice(0, 60)).run().catch(() => {});
        if (event.cron === DEPT_CRON) {
          await runDepartmentSlot(env, { nowMs: Number(event.scheduledTime) || Date.now() }); // never throws
          return;
        }
        // Only the exact ledger cron runs the ledger steps: an unknown string (a wrangler.toml
        // edit that didn't reach this code) must not run the 15-minute job every 5 minutes.
        if (event.cron !== "*/15 * * * *" && event.cron !== "0 5 * * *") {
          await logEvent(env.DB, { actor: "core.incidents", kind: "error.unknown_cron", summary: `A schedule fired that the brain doesn't know ("${String(event.cron).slice(0, 60)}"); nothing ran` }).catch(() => {});
          return;
        }
        if (event.cron === "0 5 * * *") {
          try {
            await ensureFeeds(env.DB);
            await runDayClose(env);
          } catch (err) {
            await logEvent(env.DB, {
              actor: "pnl.ledger", kind: "error.day_close",
              summary: `P&L day close failed; the hourly recompute will catch up (${String(err && err.message).slice(0, 200)})`,
            }).catch(() => {});
          }
          return;
        }
        await ensureFeeds(env.DB);
        // Each step in its own try: one fault must never stop the steps after it,
        // above all the Freshness Sentinel, which is what notices that something broke.
        try {
          await reconcileOrders(env); // backstop behind webhooks; keeps the orders feed honest
        } catch (err) {
          await logEvent(env.DB, {
            actor: "pnl.pullers", kind: "error.order_pull", target: "sys.shopify",
            summary: `Order check failed; it will try again in 15 minutes (${String(err && err.message).slice(0, 200)})`,
          }).catch(() => {});
        }
        // Order history for the P&L: first a one-time pass since the 1st of last month
        // (a few pages per run, resumable), then hourly re-reads of recently updated orders.
        try {
          await runOrderBackfill(env);
        } catch (err) {
          await logEvent(env.DB, {
            actor: "pnl.pullers", kind: "error.orders_backfill", target: "sys.shopify",
            summary: `Order history check failed to start; it will try again in 15 minutes (${String(err && err.message).slice(0, 200)})`,
          }).catch(() => {});
        }
        // Older history (to 2026-07-01): orders created before the first pass's start, then the
        // matching refunds. Moves coverage back only once each gap is read to the end.
        try {
          await runHistoryExtension(env);
        } catch (err) {
          await logEvent(env.DB, {
            actor: "pnl.pullers", kind: "error.history_extension", target: "sys.shopify",
            summary: `Older order history read failed to start; it will try again in 15 minutes (${String(err && err.message).slice(0, 200)})`,
          }).catch(() => {});
        }
        // One-off refund history read from Shopify by Claude (2026-10-16); does nothing once applied.
        try {
          await applyRefundHistory(env);
        } catch (err) {
          await logEvent(env.DB, { actor: "pnl.refunds", kind: "error.refund_history", target: "sys.shopify", summary: `Loading the refund history failed; it will try again in 15 minutes (${String(err && err.message).slice(0, 200)})` }).catch(() => {});
        }
        // Money feeds: throttled (15 min / hourly) and isolated from each other inside.
        try {
          await runMoneyJobs(env);
        } catch (err) {
          await logEvent(env.DB, {
            actor: "pnl.pullers", kind: "error.money_jobs",
            summary: `Money feeds failed to start; they will try again in 15 minutes (${String(err && err.message).slice(0, 200)})`,
          }).catch(() => {});
        }
        // P&L: last 3 days every tick (after the money feeds, so it uses their latest rows).
        try {
          await runPnlCron(env);
        } catch (err) {
          await logEvent(env.DB, {
            actor: "pnl.ledger", kind: "error.pnl",
            summary: `P&L recompute failed; it will try again in 15 minutes (${String(err && err.message).slice(0, 200)})`,
          }).catch(() => {});
        }
        // Morning brief: once per Eastern day after 08:00. Its own try, like every step.
        try {
          await runBrief(env);
        } catch (err) {
          await logEvent(env.DB, {
            actor: "core.briefer", kind: "error.brief",
            summary: `Morning brief failed; it will try again in 15 minutes (${String(err && err.message).slice(0, 200)})`,
          }).catch(() => {});
        }
        // One phone reminder from 09:00 Eastern when no KFB import has landed today.
        try {
          await runKfbReminder(env);
        } catch (err) {
          await logEvent(env.DB, {
            actor: "svc.kfb_session", kind: "error.kfb_reminder", target: "sys.phone",
            summary: `KFB import reminder failed; it will try again in 15 minutes (${String(err && err.message).slice(0, 200)})`,
          }).catch(() => {});
        }
        // Before the composer, so tonight's KFB message sees the latest parcel statuses.
        // runTracking isolates its own stages; this outer try is the last line of defence.
        try {
          await runTracking(env);
        } catch (err) {
          await logEvent(env.DB, {
            actor: "ful.tracking", kind: "error.tracking", target: "sys.17track",
            summary: `Tracking run failed; it will try again in 15 minutes (${String(err && err.message).slice(0, 200)})`,
          }).catch(() => {});
        }
        // After the pull, so the newest orders are in. Its own try: a composer fault must
        // never stop the Freshness Sentinel.
        try {
          await runKfbComposer(env);
        } catch (err) {
          await logEvent(env.DB, {
            actor: "sup.relay", kind: "error.kfb_composer", target: "sys.kfb",
            summary: `KFB message composer failed; it will try again in 15 minutes (${String(err && err.message).slice(0, 200)})`,
          }).catch(() => {});
        }
        // Urgent phone alerts: reads the events above (and the departments') by kind, from a cursor.
        // Last before the Sentinel so this tick's alarms go out on this tick.
        try {
          await runPhoneAlerts(env);
        } catch (err) {
          await logEvent(env.DB, {
            actor: "core.approvals", kind: "error.phone_alerts", target: "sys.phone",
            summary: `Urgent phone alerts failed; they will try again in 15 minutes (${String(err && err.message).slice(0, 200)})`,
          }).catch(() => {});
        }
        await runSentinel(env.DB);
      })()
    );
  },
};
