/**
 * The department agents (built 2026-10-13, all SHADOW): one place that knows how to run them
 * and read their dashboard state.
 *
 * Why a rotation: the 15-minute cron already does the ledger work (orders, money, P&L,
 * brief, KFB message). Each Cloudflare run has its own limits on outside calls and time, so
 * the departments get their own cron ("1-59/5 * * * *": minutes 1, 6, 11, ...) and each run
 * does ONE department. Inside, every department throttles its agents with job_runs, so a
 * department that comes round more often than it needs simply finds nothing due.
 *
 * Slots per hour (12): CS reads mail most often; everything else at least hourly.
 */
import { runCs, csState } from "./cs/index.js";
import { runMedia, mediaState } from "./media/index.js";
import { runCatalog, catalogState } from "./catalog/index.js";
import { runRisk, riskState } from "./risk/index.js";
import { runSupplier, supplierState } from "./supplier/index.js";
import { runCore, coreState } from "./core/index.js";
import { runPnlExtras, pnlExtrasState } from "./pnl/index.js";
import { runFulfillment, fulfillmentState } from "./fulfillment/index.js";
import { logEvent } from "../lib/eventlog.js";

export const DEPARTMENTS_RUN = Object.freeze({
  cs: { run: runCs, state: csState, actor: "cs.triage", name: "Customer Service" },
  media: { run: runMedia, state: mediaState, actor: "media.performance", name: "Media" },
  catalog: { run: runCatalog, state: catalogState, actor: "cat.pricing", name: "Catalog" },
  risk: { run: runRisk, state: riskState, actor: "risk.chargebacks", name: "Risk" },
  supplier: { run: runSupplier, state: supplierState, actor: "sup.quote_desk", name: "Supplier" },
  core: { run: runCore, state: coreState, actor: "core.incidents", name: "Core" },
  pnl: { run: runPnlExtras, state: pnlExtrasState, actor: "pnl.analyst", name: "P&L extras" },
  fulfillment: { run: runFulfillment, state: fulfillmentState, actor: "ful.order_watch", name: "Fulfillment" },
});

/** Which department runs in each 5-minute slot of the hour (slot = floor(minute / 5)). */
export const ROTATION = Object.freeze(["cs", "media", "catalog", "core", "cs", "risk", "supplier", "pnl", "cs", "media", "catalog", "fulfillment"]);

export function departmentForMinute(minute) {
  return ROTATION[Math.floor((((minute % 60) + 60) % 60) / 5) % ROTATION.length];
}

/** Off switch for every department at once (env AGENTS_OFF = "1"); each also has its own. */
export async function runDepartmentSlot(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  if (env.AGENTS_OFF === "1") return { ran: false, reason: "AGENTS_OFF" };
  const dept = departmentForMinute(new Date(nowMs).getUTCMinutes());
  const d = DEPARTMENTS_RUN[dept];
  try {
    const out = await d.run(env, { nowMs, fetchImpl });
    return { ran: true, dept, out };
  } catch (err) {
    // Departments promise never to throw; this is the last line of defence.
    await logEvent(env.DB, { actor: d.actor, kind: "error.department", summary: `${d.name} run failed; it comes round again within the hour (${String(err && err.message).slice(0, 200)})` }).catch(() => {});
    return { ran: false, dept, error: String(err && err.message) };
  }
}

export async function departmentState(env, dept, { nowMs = Date.now() } = {}) {
  const d = DEPARTMENTS_RUN[dept];
  if (!d) return null;
  return d.state(env, { nowMs });
}
