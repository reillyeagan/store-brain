/**
 * cat.status — Product Status (SHADOW: read-only, proposals only).
 *
 * Does: once a day per live store, spots products whose status probably needs to change:
 *   - ACTIVE but sold out: inventory is tracked on every variant, continue-selling is off on
 *     every variant, and nothing is in stock → customers see "sold out" (propose: draft it, or
 *     turn continue-selling on if KFB can still supply it — Reilly's call);
 *   - ACTIVE with no images (propose: draft until it has photos);
 *   - DRAFT/ARCHIVED but still in a collection (propose: take it out, so the collection is clean).
 * Inputs: `cat_products` (fresh copy).
 * Outputs: a `cat_runs` row (proposals listed on the Catalog page) and one digest event per
 *   store per day. No approvals and no writes: Reilly drafts products himself; a status writer
 *   (with backup, Store Guard and Write-Verifier) is a later build that needs write_products.
 * Not built yet: drafting KFB-denied products (needs the Supplier team's Denial Sync).
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { STORES } from "../../config/stores.js";
import { saveRun } from "./common.js";

export const AGENT = "cat.status";

/** The status proposals for one product (empty array = nothing to propose). */
export function statusProposals(p) {
  const out = [];
  const vs = p.variants || [];
  if (p.status === "ACTIVE") {
    const allTracked = vs.length > 0 && vs.every((v) => v.tracked === true);
    const noneContinue = vs.length > 0 && vs.every((v) => v.policy === "DENY");
    const allEmpty = vs.length > 0 && vs.every((v) => v.qty != null && v.qty <= 0);
    // Only judge when every variant was read: a partly-read product could have stock elsewhere.
    const complete = (p.variants_count || vs.length) <= vs.length;
    if (allTracked && noneContinue && allEmpty && complete) {
      out.push({ code: "sold_out_active", severity: "medium", proposal: "Draft it, or turn on 'continue selling' if KFB can still supply it",
        message: "Active but sold out: inventory tracked, continue-selling off, 0 in stock on every variant" });
    }
    if (p.image_count === 0) {
      out.push({ code: "no_images", severity: "medium", proposal: "Draft it until it has photos", message: "Active with no images" });
    }
  } else if ((p.status === "DRAFT" || p.status === "ARCHIVED") && p.collections_count > 0) {
    out.push({ code: "inactive_in_collections", severity: "low", proposal: "Remove it from its collections",
      message: `${p.status === "DRAFT" ? "Draft" : "Archived"} but still in ${p.collections_count >= 3 ? "3+" : p.collections_count} collection(s)` });
  }
  return out;
}

export async function runStatusStore(env, storeId, products, { nowMs, day }) {
  const findings = [];
  for (const p of products) {
    const props = statusProposals(p);
    if (props.length) {
      findings.push({ product_id: p.product_id, handle: p.handle, title: p.title, status: p.status,
        severity: props.some((x) => x.severity === "medium") ? "medium" : "low", issues: props });
    }
  }
  findings.sort((a, b) => (b.severity === "medium") - (a.severity === "medium"));
  const byCode = {};
  for (const f of findings) for (const i of f.issues) byCode[i.code] = (byCode[i.code] || 0) + 1;
  const summary = { checked: products.length, active: products.filter((p) => p.status === "ACTIVE").length, proposals: findings.length, by_code: byCode,
    not_built: "draft proposals for KFB-denied products (needs Denial Sync)" };
  await saveRun(env.DB, { agent: AGENT, store: storeId, day, nowMs, status: "ok", summary, findings });
  await logEvent(env.DB, {
    actor: AGENT, kind: "catalog.status_digest", store: storeId, at: nowIso(nowMs),
    summary: `${STORES[storeId].name}: ${findings.length} status proposal(s) (${Object.entries(byCode).map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`).join(", ") || "none"}). Read-only: nothing changed.`,
    data: summary,
  });
  return { status: "ok", proposals: findings.length };
}
