/**
 * Store Brain — Cloudflare Worker entry point (Phase 1: foundation).
 *
 * Routes
 *   GET  /health                         public, no data — is the brain up?
 *   GET  /api/state                      Mission Control data (key required)
 *   POST /api/approvals/:id/decide       Reilly's decision (key OR a signed phone link)
 *   POST /webhooks/shopify               Shopify webhooks (HMAC-verified per store)
 *   POST /api/admin/check-stores         Store Guard check for every live store (key required)
 *   POST /api/admin/webhooks             connect order/refund notifications (key required)
 *   POST /api/admin/test-notification    send a test message to Reilly's phone (key required)
 *   GET  /                               Mission Control page (static, no data until a key is given)
 *
 * Crons
 *   every 15 min  Freshness Sentinel
 *   daily 05:00Z  day-close marker (P&L close logic arrives in Phase 2)
 *
 * Secrets (Reilly adds these in Cloudflare; never in this repo):
 *   MC_KEY                 key for Mission Control + API
 *   APPROVAL_SIGNING_KEY   signs phone Approve/Reject links
 *   NTFY_TOPIC             private ntfy topic for phone notifications
 *   SB_<STORE>_CLIENT_ID / SB_<STORE>_CLIENT_SECRET   per-store Shopify app credentials
 */
import { STORES, LIVE_STORE_IDS } from "./config/stores.js";
import { DEPARTMENTS, AGENTS, SERVICES, SYSTEMS } from "./config/agents.js";
import { recentEvents, costSince, logEvent } from "./lib/eventlog.js";
import { evaluateFeeds, runSentinel, ensureFeeds } from "./lib/freshness.js";
import { listPending, decide, verifyDecisionSig, getApproval, sendTestNotification } from "./lib/approvals.js";
import { handleShopifyWebhook } from "./lib/shopifyWebhooks.js";
import { localDay } from "./lib/time.js";
import { checkStores, registerWebhooks } from "./lib/setup.js";
import { reconcileOrders } from "./lib/reconcile.js";

export const VERSION = "0.1.0-foundation";

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
  const [events, feeds, approvals, aiCostToday] = await Promise.all([
    recentEvents(env.DB, { limit: 300 }),
    evaluateFeeds(env.DB),
    listPending(env.DB),
    costSince(env.DB, todayStart),
  ]);
  return json({
    version: VERSION,
    now: new Date().toISOString(),
    stores: Object.values(STORES).map(({ id, name, live }) => ({ id, name, live })),
    departments: DEPARTMENTS,
    agents: AGENTS,
    services: SERVICES,
    systems: SYSTEMS,
    events,
    feeds: feeds.map(({ id, store, label, max_age_min, last_ok_at, last_error, current }) => ({
      id, store, label, max_age_min, last_ok_at, last_error, state: current,
    })),
    approvals,
    aiCostToday,
    todayStart,
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
      if (path === "/api/state" && request.method === "GET") {
        if (!hasKey(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
        return await handleState(env);
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
          await logEvent(env.DB, {
            actor: "pnl.ledger", kind: "day.close",
            summary: "Day close reached. P&L close logic arrives in Phase 2 (shadow mode first).",
          });
          return;
        }
        await ensureFeeds(env.DB);
        await reconcileOrders(env); // backstop behind webhooks; keeps the orders feed honest
        await runSentinel(env.DB);
      })()
    );
  },
};
