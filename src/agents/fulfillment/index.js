/**
 * Fulfillment department: cron entry point and page data.
 *
 *   runFulfillment(env, {nowMs, fetchImpl}) — department rotation (about hourly). Never throws; throttled hourly.
 *   fulfillmentState(env, {nowMs})          — JSON for the Fulfillment page.
 *
 * Built here: ful.order_watch (Order-to-Supplier Watcher), shadow.
 * The Exception Fixer was removed 2026-10-14 (Reilly). Delivery problems reach CS as customer email.
 */
import { claimJob } from "../../lib/jobRuns.js";
import { PARCEL_TRACKING, PARCEL_TRACKING_DECISION } from "../../config/stores.js";
import { guarded, noteResult, jobInfo } from "../core/shared.js";
import { runOrderWatch, orderWatchState } from "./orderWatch.js";

export const FUL_JOBS = Object.freeze({ "ful.order_watch": 60 });

// eslint-disable-next-line no-unused-vars
export async function runFulfillment(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const out = {};
  try {
    if (!(await claimJob(env.DB, "ful.order_watch", FUL_JOBS["ful.order_watch"], nowMs))) out.order_watch = "not due";
    else {
      // Waiting on the KFB session is a healthy run (nothing to check yet), so it is noted as
      // "ok: …": the Incident Desk reads job_runs and must see an earlier failure as recovered.
      const r = await guarded(env.DB, "ful.order_watch", "ful_order_watch", nowMs, () => runOrderWatch(env, { nowMs }));
      await noteResult(env.DB, "ful.order_watch", r && r.error ? `error: ${r.error}` : r.status === "waiting" ? `ok: ${r.reason}` : `ok: ${JSON.stringify(r).slice(0, 250)}`);
      out.order_watch = r;
    }
  } catch (err) {
    out.order_watch = { error: String(err && err.message) };
  }
  return out;
}

export async function fulfillmentState(env, { nowMs = Date.now() } = {}) {
  let orderWatch;
  try { orderWatch = await orderWatchState(env, { nowMs }); } catch (err) { orderWatch = { error: String(err && err.message) }; }
  return {
    mode: "shadow",
    jobs: { "ful.order_watch": await jobInfo(env.DB, "ful.order_watch") },
    order_watch: orderWatch,
    parcel_tracking: { on: PARCEL_TRACKING, decision: PARCEL_TRACKING_DECISION },
  };
}
