/**
 * Store Brain — Cloudflare Worker entry point (Phase 1: foundation).
 *
 * Routes
 *   GET  /health                         public, no data — is the brain up?
 *   GET  /api/state                      Mission Control data (key required)
 *   GET  /api/pnl?store=all|hc|aub|mar    every stored P&L day for the P&L page (key required)
 *   GET  /api/agents/:id/events          one agent's latest events, for its page (key required)
 *   POST /api/brief/rewrite              compose today's brief again from fresh numbers (key required)
 *   POST /api/approvals/:id/decide       Reilly's decision (key OR a signed phone link)
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
 *                 → KFB composer (once per day after 18:45 ET) → Freshness Sentinel
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
 *   SUPPLIER_MESSAGES_LIVE "1" = KFB messages go to the phone; anything else = shadow (Reilly flips it)
 *   PUBLIC_BASE_URL        this worker's https address, for links in phone notifications sent by crons
 *   BRIEF_MODEL            Claude model id for the morning brief (wrangler.toml)
 *   BRIEF_PHONE_LIVE       "1" = the 8:00 brief also goes to the phone; anything else = shadow (Reilly flips it)
 *   SB_<STORE>_CLIENT_ID / SB_<STORE>_CLIENT_SECRET   per-store Shopify app credentials
 */
import { STORES, LIVE_STORE_IDS } from "./config/stores.js";
import { DEPARTMENTS, AGENTS, SERVICES, SYSTEMS, AGENT_DOES, isKnownActor } from "./config/agents.js";
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
import { runMoneyJobs } from "./lib/moneyJobs.js";
import { moneyState } from "./lib/moneyState.js";
import { startGoogleConnect, handleGoogleCallback, googleStatus, mailboxStatus, secretPresence } from "./lib/google.js";
import {
  runKfbComposer, handleKfbPage, handleKfbSent, listKfbMessages, expressOrdersToday, supplierMode,
} from "./lib/kfbMessage.js";
import { runTracking, handleTrackingPush, shippingState } from "./lib/tracking.js";
import { runPnlCron, runDayClose, pnlState, pnlHistory } from "./lib/pnl.js";
import { runBrief, latestBrief, handleBriefPage, briefMode, rewriteBrief } from "./lib/brief.js";

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
    env.DB.prepare(`SELECT job, last_run_at, last_result FROM job_runs WHERE job IN ('ads.spend','payouts','refunds')`).all(),
    shippingState(env),
  ]);
  const money = await moneyState(env.DB, feeds);
  const [pnl, brief] = await Promise.all([pnlState(env.DB), latestBrief(env.DB)]);
  return json({
    version: VERSION,
    now: new Date().toISOString(),
    stores: Object.values(STORES).map(({ id, name, live }) => ({ id, name, live })),
    departments: DEPARTMENTS,
    agents: AGENTS.map((a) => ({ ...a, does: AGENT_DOES[a.id] || null })),
    services: SERVICES,
    systems: SYSTEMS,
    events,
    feeds: feeds.map(({ id, store, label, max_age_min, last_ok_at, last_error, current }) => ({
      id, store, label, max_age_min, last_ok_at, last_error, state: current,
    })),
    approvals,
    aiCostToday,
    todayStart,
    supplier: { mode: supplierMode(env), kfbMessages, expressToday },
    money: { ...money, jobs: (jobs && jobs.results) || [] },
    shipping,
    pnl,
    brief: { mode: briefMode(env), latest: brief },
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
        const r = await pnlHistory(env.DB, String(url.searchParams.get("store") || "all").slice(0, 10));
        return json(r, r.ok ? 200 : 400);
      }
      const ae = path.match(/^\/api\/agents\/([a-z0-9_.]{1,60})\/events$/);
      if (ae && request.method === "GET") {
        if (!hasKey(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
        if (!isKnownActor(ae[1])) return json({ ok: false, error: "unknown agent" }, 404);
        return json({ ok: true, id: ae[1], ...(await agentEvents(env.DB, ae[1])) });
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
        await runSentinel(env.DB);
      })()
    );
  },
};
