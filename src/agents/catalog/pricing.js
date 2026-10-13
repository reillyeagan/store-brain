/**
 * cat.pricing — Pricing (SHADOW, L0: proposes only).
 *
 * Does: once a day per live store, checks every ACTIVE product's variant prices and
 *   compare-ats against Reilly's rules (pricingRules.js): under the floor, over the $144.95
 *   ceiling, not ending in .95, COGS outside the band (when the cost is known), compare-at not
 *   clean or not printing an exact 10/20/30/40 badge. Also reports the compare-at tier spread
 *   against the 20%-each target.
 * Inputs: the product copy in `cat_products` (sync.js; must be fresh), costs from the Core.
 * Outputs: one `cat_runs` row (findings, worst first, with old → new proposals), ONE digest
 *   event per store per day, and at most ONE pending pricing approval per store (worst issues
 *   only, deduped). Approving records Reilly's yes; nothing is written to Shopify (no write
 *   scopes exist; a price writer is a later, separately approved build).
 */
import { createApproval } from "../../lib/approvals.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { STORES } from "../../config/stores.js";
import { validatePrice, rulesFor, tierDistribution } from "./pricingRules.js";
import { DEPT, SEVERITY_RANK, getRun, saveRun, readCosts, productCost, isHeld, money, pct } from "./common.js";

export const AGENT = "cat.pricing";
/** At most this many products go into one approval (the worst ones; the page lists the rest). */
export const APPROVAL_MAX_ITEMS = 8;
/** Only these problems are worth interrupting Reilly for; everything else waits on the page. */
const APPROVAL_CODES = new Set(["below_floor", "above_ceiling", "cogs_above_band"]);
const COGS_CODES = new Set(["cogs_above_band", "cogs_below_band", "off_target", "ceiling_blocks_band"]);

/** Check one product (all its variants). Returns a finding or null when everything is in rule. */
export function checkProduct(storeId, product, cost) {
  const results = [];
  let held = false;
  for (const v of product.variants || []) {
    if (v.price == null) continue;
    const r = validatePrice(storeId, { price: v.price, compareAt: v.compareAt, cost: cost ? cost.usd : null });
    if (!r) continue;
    if (isHeld(storeId, product, v.price)) {
      // Standing hold (Reilly 09-01): leave the COGS position alone; other rules still apply.
      held = true;
      r.issues = r.issues.filter((i) => !COGS_CODES.has(i.code));
      if (r.proposed && Math.abs(r.proposed.price - v.price) > 0.004) r.proposed = null;
    }
    results.push({ v, r });
  }
  const tier = results.length ? results[0].r.tier : 0;
  const issues = new Map();
  for (const { r } of results) for (const i of r.issues) if (!issues.has(i.code)) issues.set(i.code, i);
  const real = [...issues.values()].filter((i) => i.severity !== "info");
  const changes = results.filter(({ r }) => r.proposed).map(({ v, r }) => ({
    variant_id: v.id, variant: v.title, old_price: v.price, new_price: r.proposed.price,
    old_compare_at: v.compareAt, new_compare_at: r.proposed.compareAt, tier: r.proposed.tier, reason: r.proposed.reason,
  }));
  const worst = real.reduce((m, i) => Math.max(m, SEVERITY_RANK[i.severity]), -1);
  const prices = results.map(({ v }) => v.price);
  const base = {
    product_id: product.product_id, handle: product.handle, title: product.title,
    price_min: prices.length ? Math.min(...prices) : null, price_max: prices.length ? Math.max(...prices) : null,
    cogs: results.length && results[0].r.cogs != null ? Math.max(...results.map(({ r }) => r.cogs ?? 0)) : null,
    cost_usd: cost ? cost.usd : null, cost_fx_estimated: !!(cost && cost.fxEstimated), held, tier,
  };
  if (worst < 0 && !changes.length) return { ...base, ok: true, notes: [...issues.values()].map((i) => i.message) };
  return {
    ...base, ok: false,
    severity: Object.keys(SEVERITY_RANK).find((k) => SEVERITY_RANK[k] === Math.max(worst, 0)),
    issues: [...issues.values()].map(({ code, severity, message }) => ({ code, severity, message })),
    changes: changes.slice(0, 10), changes_total: changes.length,
  };
}

/** Rank findings: severity first, then the biggest dollar move. */
export function rankFindings(list) {
  const move = (f) => Math.max(0, ...(f.changes || []).map((c) => Math.abs(c.new_price - c.old_price)));
  return list.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || move(b) - move(a));
}

/** Run Pricing for one store over the (fresh) product copy. */
export async function runPricingStore(env, storeId, products, { nowMs, day }) {
  const db = env.DB;
  const rules = rulesFor(storeId);
  if (!rules) {
    await saveRun(db, { agent: AGENT, store: storeId, day, nowMs, status: "not_wired", note: "No pricing rules agreed for this store" });
    return { status: "not_wired" };
  }
  const costs = await readCosts(db, storeId);
  const active = products.filter((p) => p.status === "ACTIVE");
  const findings = [], tiers = [];
  let costKnown = 0, held = 0, truncated = 0;
  for (const p of active) {
    const cost = productCost(costs, p);
    if (cost) costKnown++;
    if ((p.variants_count || 0) > (p.variants || []).length) truncated++;
    const f = checkProduct(storeId, p, cost);
    tiers.push(f.tier);
    if (f.held) held++;
    if (!f.ok) findings.push(f);
  }
  rankFindings(findings);
  const byCode = {};
  for (const f of findings) for (const i of f.issues) byCode[i.code] = (byCode[i.code] || 0) + 1;
  const prev = await getRun(db, AGENT, storeId);
  const summary = {
    checked: active.length, with_issues: findings.length, cost_known: costKnown, held, variants_truncated: truncated,
    by_code: byCode, tiers: tierDistribution(tiers), badge_verified: rules.badge.verified, badge_source: rules.badge.source,
    approval_fingerprint: prev && prev.summary ? prev.summary.approval_fingerprint || null : null,
    approval_id: prev && prev.summary ? prev.summary.approval_id || null : null,
  };

  // At most one approval per store, for the worst issues only, never twice for the same set.
  const approval = await maybeApprove(env, storeId, findings, summary);
  if (approval) { summary.approval_fingerprint = approval.fingerprint; summary.approval_id = approval.id; }

  await saveRun(db, { agent: AGENT, store: storeId, day, nowMs, status: "ok", summary, findings });
  const s = STORES[storeId];
  const codes = Object.entries(byCode).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`).join(", ");
  await logEvent(db, {
    actor: AGENT, kind: "catalog.pricing_digest", store: storeId, target: "sys.shopify", at: nowIso(nowMs),
    summary: `${s.name}: ${active.length} active products checked, ${findings.length} break a price rule${codes ? ` (${codes})` : ""}; cost known for ${costKnown}. Shadow: nothing changed.`,
    data: { checked: active.length, with_issues: findings.length, by_code: byCode, tiers: summary.tiers.counts, approval_id: approval ? approval.id : null },
  });
  return { status: "ok", checked: active.length, issues: findings.length, approvalId: approval ? approval.id : null };
}

async function maybeApprove(env, storeId, findings, summary) {
  if (env.CATALOG_APPROVALS === "0") return null;
  const worst = findings.filter((f) => f.severity === "high" && f.changes_total > 0 &&
    f.issues.some((i) => APPROVAL_CODES.has(i.code))).slice(0, APPROVAL_MAX_ITEMS);
  if (!worst.length) return null;
  const fingerprint = worst.map((f) => `${f.product_id}:${f.changes[0].new_price}`).sort().join("|");
  if (fingerprint === summary.approval_fingerprint) return null; // same batch already asked (any answer)
  const pending = await env.DB.prepare(
    `SELECT id FROM approvals WHERE requested_by = ? AND store = ? AND status = 'pending' LIMIT 1`
  ).bind(AGENT, storeId).first();
  if (pending) return null; // one open pricing question per store at a time
  const lines = worst.map((f) => {
    const c = f.changes[0];
    const cmp = c.old_compare_at !== c.new_compare_at ? `, compare-at ${money(c.old_compare_at)} → ${money(c.new_compare_at)}` : "";
    return `${f.title}: ${money(c.old_price)} → ${money(c.new_price)}${cmp} (${f.issues.filter((i) => i.severity === "high").map((i) => i.code.replace(/_/g, " ")).join(", ")}${f.cogs != null ? `; COGS ${pct(f.cogs)}` : ""})${f.changes_total > 1 ? ` [${f.changes_total} variants]` : ""}`;
  });
  const total = findings.length;
  const id = await createApproval(env.DB, {
    dept: DEPT, requestedBy: AGENT, store: storeId,
    title: `${STORES[storeId].name}: ${worst.length} prices break the floor/ceiling/COGS rules${total > worst.length ? ` (${total} findings in all, see Catalog page)` : ""}. Shadow: approving records your yes, nothing is written to Shopify yet.`,
    options: [
      { id: "approve_batch", label: `Approve these ${worst.length} price changes`, detail: lines.join("\n") },
      { id: "leave", label: "Leave these prices as they are", detail: "Nothing changes; they will not be asked again unless the proposal changes." },
    ],
  });
  return { id, fingerprint };
}
