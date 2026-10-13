/**
 * Router (core.router) — plain code, L2, shadow-safe (reads events, writes only events).
 *
 * What it does: `routeEvent(event)` (pure) says which agent(s) should act next on an event,
 * from a fixed table of event kinds. The tick walks new events (cursor in agent_cursors) and
 * records each hand-off as a `route.handoff` event with `target` = the next agent, which is
 * what draws a travelling dot on the Mission Control map.
 * Honest by design: it records ROUTING only. It never does the work, never claims the work
 * was done, and never routes to an agent that isn't built yet or is switched off (those are
 * counted as "waiting for a built agent" instead).
 * Inputs: events, the agent registry. Outputs: route.handoff events.
 */
import { AGENTS } from "../../config/agents.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { safeJson } from "./shared.js";

const ACTOR = "core.router";
export const ROUTE_BATCH = 200;        // routable events read per page
export const HANDOFFS_PER_RUN = 400;   // hand-offs logged per run at most
export const ROUTE_TIME_BUDGET_MS = 8000;

/**
 * Event kind → agents that act next, and why. Exact kinds first; a trailing ".*" matches a
 * prefix. `"$target"` means "the agent the event names as its target" (an approved request
 * goes back to the agent that asked).
 */
export const ROUTES = Object.freeze([
  { kind: "size_complaint.logged", to: ["sup.size_charts"], why: "a sizing complaint teaches the size library" },
  { kind: "cs.size_complaint", to: ["sup.size_charts"], why: "a sizing complaint teaches the size library" },
  // Payout mismatches are logged by the Money Map itself; the next one to act is the Ledger
  // Keeper, whose fees for those days come from the same balance transactions.
  { kind: "payout.mismatch", to: ["pnl.ledger"], why: "fees in the P&L come from the same balance transactions" },
  { kind: "dispute.*", to: ["risk.chargebacks"], why: "a chargeback needs its evidence packet before the deadline" },
  { kind: "chargeback.*", to: ["risk.chargebacks"], why: "a chargeback needs its evidence packet before the deadline" },
  { kind: "pnl.restated", to: ["pnl.analyst"], why: "a closed day moved: the explanation must be redone" },
  { kind: "feed.alarm", to: ["core.incidents"], why: "a feed went stale or is failing" },
  { kind: "ful.not_in_kfb", to: ["sup.relay"], why: "an order KFB doesn't have goes into the KFB message" },
  { kind: "cogs.low_vs_estimate", to: ["core.auditor"], why: "good news gets more scrutiny" },
  { kind: "approval.approved", to: ["$target"], why: "Reilly said yes: the requesting agent carries it out" },
  { kind: "order.created", to: ["risk.fraud", "sup.size_charts"], why: "every new order is screened and size-checked" },
]);

const STATUS = new Map(AGENTS.map((a) => [a.id, a.status]));
/** Only agents that exist and run can receive work. */
export const canReceive = (id, status = STATUS) => {
  const s = status.get(id);
  return !!s && s !== "planned" && s !== "off";
};

/**
 * Pure: who acts next on this event. Returns [{to, why}] (empty when no route). Never routes
 * an agent's event back to itself, never routes the Router's own events.
 */
export function routeEvent(event, { status = STATUS } = {}) {
  if (!event || !event.kind || event.actor === ACTOR || String(event.kind).startsWith("route.")) return [];
  const kind = String(event.kind);
  const out = [];
  for (const r of ROUTES) {
    const hit = r.kind.endsWith(".*") ? kind.startsWith(r.kind.slice(0, -1)) : kind === r.kind;
    if (!hit) continue;
    for (const t of r.to) {
      const to = t === "$target" ? event.target : t;
      if (!to || to === event.actor || out.some((o) => o.to === to)) continue;
      out.push({ to, why: r.why, ready: canReceive(to, status) });
    }
  }
  return out;
}

async function cursor(db) {
  const r = await db.prepare(`SELECT value FROM agent_cursors WHERE name = 'router'`).first();
  return r ? Number(r.value) : null;
}
async function setCursor(db, value, at) {
  await db.prepare(`INSERT INTO agent_cursors (name, value, updated_at) VALUES ('router', ?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(value, at).run();
}

/** SQL filter for the kinds the table routes, so unroutable events cost nothing to skip. */
function routableFilter() {
  const exact = ROUTES.filter((r) => !r.kind.endsWith(".*")).map((r) => r.kind);
  const prefixes = ROUTES.filter((r) => r.kind.endsWith(".*")).map((r) => `${r.kind.slice(0, -1)}%`);
  const sql = `(kind IN (${exact.map(() => "?").join(", ")})${prefixes.map(() => " OR kind LIKE ?").join("")})`;
  return { sql, binds: [...exact, ...prefixes] };
}

/**
 * One run: route every event logged since the last run. The Core comes round about twice an
 * hour in the department rotation, so a run keeps reading pages until it has caught up, within
 * a row / hand-off / time budget (then the cursor stops at the last event handled and the
 * next run carries on). The first run starts at the newest event (history isn't replayed).
 */
export async function runRouter(env, { nowMs = Date.now(), clock = Date.now } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const started = clock();
  const from = await cursor(db);
  const max = Number((await db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM events`).first()).id);
  if (from == null) {
    await setCursor(db, max, at);
    return { routed: 0, waiting: 0, started_at_event: max };
  }
  const f = routableFilter();
  let routed = 0, waiting = 0, read = 0, last = from, done = false, budget = false;
  while (!done && !budget) {
    const { results } = await db.prepare(
      `SELECT id, actor, kind, store, target, summary, data FROM events WHERE id > ? AND id <= ? AND ${f.sql} ORDER BY id LIMIT ?`
    ).bind(last, max, ...f.binds, ROUTE_BATCH).all();
    const page = results || [];
    for (const e of page) {
      const routes = routeEvent(e);
      const ready = routes.filter((r) => r.ready);
      if (routed + ready.length > HANDOFFS_PER_RUN || clock() - started > ROUTE_TIME_BUDGET_MS) { budget = true; break; }
      for (const r of ready) {
        const d = safeJson(e.data, {}) || {};
        await logEvent(db, {
          actor: ACTOR, kind: "route.handoff", store: e.store, target: r.to,
          summary: `${e.kind} from ${e.actor} → ${r.to}: ${r.why}`,
          data: { event_id: e.id, from: e.actor, event_kind: e.kind, approvalId: d.approvalId ?? undefined }, at,
        });
        routed++;
      }
      waiting += routes.length - ready.length;
      last = e.id;
      read++;
    }
    if (!budget && page.length < ROUTE_BATCH) { done = true; last = max; } // caught up to the newest event at the start
  }
  if (last !== from) await setCursor(db, last, at);
  return { routed, waiting, read, cursor: last, caught_up: done };
}

export async function routerState(db) {
  const c = await cursor(db);
  const { results } = await db.prepare(`SELECT at, store, target, summary FROM events WHERE actor = ? AND kind = 'route.handoff' ORDER BY id DESC LIMIT 30`).bind(ACTOR).all();
  return {
    cursor: c, recent: results || [],
    routes: ROUTES.map((r) => ({ kind: r.kind, to: r.to, why: r.why, ready: r.to.map((t) => (t === "$target" ? true : canReceive(t))) })),
  };
}
