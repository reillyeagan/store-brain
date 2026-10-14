/**
 * cat.hygiene — monthly Feed Hygiene report (SHADOW: proposals only, never drafts or edits).
 *
 * The course's recurring feed work, as numbers for Reilly (vault, 04 Resources/Courses/Google
 * Ads Dropshipping):
 *   - Zombies. Module 8.5 "Lever 2 — Kill zombie products (monthly)": "a product listed a while
 *     ago getting no sales ... clog the feed and starve other products of spend"; "Action: DRAFT
 *     them (not delete, not archive)"; "Frequency: MONTHLY ... drafting a lot at once can trigger
 *     a misrep"; "Never draft newly-imported products". The course's window is 90 days
 *     (Module 8.5; Master Playbook coaching nuggets "Draft zombies (0 sales/90 days)"); this
 *     report uses ZOMBIE_DAYS = 60 as asked for the brain and marks which ones also pass the
 *     course's 90 days. "Never draft a bestseller" (Master Playbook) holds by definition here.
 *   - Best-sellers with no compare-at. Module 8.5 "Lever 1 — The weekly best-seller discount
 *     sweep": "Any best-seller NOT on sale → put it on sale ... it's already selling without a
 *     discount, so adding one boosts it hard." Never for a product younger than the GMC
 *     Playbook's 30 days (prepublish.js NO_COMPARE_AT_DAYS), and Reilly's own tier spread
 *     (cat.pricing) decides the depth: listed, not priced.
 *   - SKU count vs ad spend. Module 8.6: "GMC 'total products' = SKUs (products x variants).
 *     Balance SKUs to ad spend ... ~$100/day → build to ~10k SKUs". So ~100 SKUs per $1/day.
 * Inputs: cat_products (fresh copy only), order_lines + orders (with order_coverage), ad_spend_days
 * (with the Freshness Sentinel's verdict). Outputs: a cat_runs row (agent cat.hygiene, the page's
 * "state section") and one catalog.hygiene_report event per store per month.
 * Honesty: a zombie list needs complete order history for the whole window and line items for
 * every order in it; otherwise it is null with the reason (0 sales from missing data is not a claim).
 */
import { logEvent } from "../../lib/eventlog.js";
import { localDay, nowIso } from "../../lib/time.js";
import { feedState } from "../../lib/freshness.js";
import { minusDays } from "../../lib/adsSpend.js";
import { STORES } from "../../config/stores.js";
import { saveRun, storeTz } from "./common.js";
import { productAgeDays, NO_COMPARE_AT_DAYS } from "./prepublish.js";

export const AGENT = "cat.hygiene";
export const ZOMBIE_DAYS = 60;          // asked for the brain; the course says 90 (marked per product)
export const COURSE_ZOMBIE_DAYS = 90;   // Module 8.5 / Master Playbook
export const BESTSELLER_DAYS = 30;      // "sort by best-selling": units over the last 30 days
export const BESTSELLER_TOP = 20;       // the "first pages" of the sweep (Module 8.5: 4-6 pages at volume)
export const BESTSELLER_MIN_UNITS = 2;  // one sale is luck, not a best-seller
export const SKUS_PER_DOLLAR_DAY = 100; // Module 8.6: ~$100/day ↔ ~10k SKUs
export const SPEND_DAYS = 30;
export const LIST_CAP = 50;

const hasCompareAt = (p) => (p.variants || []).some((v) => v.compareAt != null && v.price != null && v.compareAt > v.price);

/** Units sold per product since a moment (order_lines joined to their order's time). */
async function unitsSince(db, storeId, sinceIso) {
  const { results } = await db.prepare(
    `SELECT l.product_id AS pid, SUM(COALESCE(l.quantity, 0)) AS units FROM order_lines l
       JOIN orders o ON o.store = l.store AND o.order_id = l.order_id
      WHERE l.store = ? AND o.created_at >= ? AND l.product_id IS NOT NULL GROUP BY l.product_id`
  ).bind(storeId, sinceIso).all();
  return new Map((results || []).map((r) => [r.pid, Number(r.units)]));
}

/** Can "no sales since X" be claimed? Needs full order history and line items for every order. */
export async function salesCoverage(db, storeId, sinceDay, sinceIso) {
  const cov = await db.prepare(`SELECT covered_from FROM order_coverage WHERE store = ?`).bind(storeId).first().catch(() => null);
  if (!cov) return { ok: false, why: "order history not fully read yet (backfill not finished)" };
  if (cov.covered_from > sinceDay) return { ok: false, why: `order history complete only from ${cov.covered_from}, the window starts ${sinceDay}` };
  const miss = await db.prepare(
    `SELECT COUNT(*) AS n FROM orders o WHERE o.store = ? AND o.created_at >= ?
       AND NOT EXISTS (SELECT 1 FROM order_lines l WHERE l.store = o.store AND l.order_id = o.order_id)`
  ).bind(storeId, sinceIso).first();
  if (miss && Number(miss.n) > 0) return { ok: false, why: `${miss.n} order(s) in the window have no line items read yet` };
  return { ok: true };
}

/** Pure: the report from products, units and spend. */
export function hygieneReport({ products, units60, units90, units30, coverage60, avgDailySpend, spendWhy, nowMs }) {
  const active = products.filter((p) => p.status === "ACTIVE");
  const skus = active.reduce((s, p) => s + Number(p.variants_count || (p.variants || []).length || 0), 0);
  let zombies = null;
  if (coverage60.ok) {
    zombies = active
      .filter((p) => { const age = productAgeDays(p, nowMs); return age != null && age >= ZOMBIE_DAYS; }) // never newly imported
      .filter((p) => !(units60.get(p.product_id) > 0))
      .map((p) => ({ product_id: p.product_id, handle: p.handle, title: p.title, age_days: Math.floor(productAgeDays(p, nowMs)),
        course_90d: productAgeDays(p, nowMs) >= COURSE_ZOMBIE_DAYS && units90 != null && !(units90.get(p.product_id) > 0) }))
      .sort((a, b) => b.age_days - a.age_days);
  }
  const ranked = active.map((p) => ({ p, units: units30.get(p.product_id) || 0 })).filter((x) => x.units >= BESTSELLER_MIN_UNITS)
    .sort((a, b) => b.units - a.units).slice(0, BESTSELLER_TOP);
  const bestNoCompare = ranked.filter((x) => !hasCompareAt(x.p)).map((x) => {
    const age = productAgeDays(x.p, nowMs);
    return { product_id: x.p.product_id, handle: x.p.handle, title: x.p.title, units_30d: x.units, price: x.p.variants[0] ? x.p.variants[0].price : null,
      age_days: age == null ? null : Math.floor(age), too_new: age == null || age < NO_COMPARE_AT_DAYS };
  });
  const benchmark = avgDailySpend == null ? null : Math.round(avgDailySpend * SKUS_PER_DOLLAR_DAY);
  const ratio = benchmark ? Math.round((skus / benchmark) * 100) / 100 : null;
  const verdict = ratio == null ? null : ratio > 2 ? "more SKUs than the spend can test (course: grow budget with SKUs, or draft)" : ratio < 0.5 ? "room to add SKUs for this spend (course: add batches based on winners)" : "in balance";
  return {
    zombies, zombies_note: coverage60.ok ? null : `not claimed: ${coverage60.why}`,
    bestsellers_no_compare_at: bestNoCompare,
    skus: { active_products: active.length, skus, avg_daily_spend: avgDailySpend, course_benchmark_skus: benchmark, ratio, verdict, spend_note: spendWhy || null },
  };
}

export async function runHygieneStore(env, storeId, products, { nowMs = Date.now(), day }) {
  const db = env.DB;
  const tz = storeTz(storeId);
  const today = localDay(nowMs, tz);
  const since = (d) => new Date(nowMs - d * 86400000).toISOString();
  const coverage60 = await salesCoverage(db, storeId, minusDays(today, ZOMBIE_DAYS), since(ZOMBIE_DAYS));
  const coverage90 = await salesCoverage(db, storeId, minusDays(today, COURSE_ZOMBIE_DAYS), since(COURSE_ZOMBIE_DAYS));
  const units60 = await unitsSince(db, storeId, since(ZOMBIE_DAYS));
  const units90 = coverage90.ok ? await unitsSince(db, storeId, since(COURSE_ZOMBIE_DAYS)) : null;
  const units30 = await unitsSince(db, storeId, since(BESTSELLER_DAYS));
  // Ad spend: only from a fresh feed with a full window of closed days (rule 4).
  let avgDailySpend = null, spendWhy = null;
  const feed = await db.prepare(`SELECT * FROM feeds WHERE id = ?`).bind(`ads.spend.${storeId}`).first().catch(() => null);
  const fs = feedState(feed, nowMs);
  if (fs !== "fresh") spendWhy = `Google Ads spend feed is ${fs.replace("_", " ")}`;
  else {
    const s = await db.prepare(`SELECT COUNT(*) AS n, SUM(cost) AS c FROM ad_spend_days WHERE store = ? AND day >= ? AND day < ?`)
      .bind(storeId, minusDays(today, SPEND_DAYS), today).first();
    if (!s || Number(s.n) < SPEND_DAYS) spendWhy = `only ${s ? s.n : 0} of ${SPEND_DAYS} days of spend on file`;
    else avgDailySpend = Math.round((Number(s.c) / SPEND_DAYS) * 100) / 100;
  }
  const rep = hygieneReport({ products, units60, units90, units30, coverage60, avgDailySpend, spendWhy, nowMs });
  const summary = {
    month: day.slice(0, 7), zombies: rep.zombies == null ? null : rep.zombies.length, zombies_course_90d: rep.zombies == null ? null : rep.zombies.filter((z) => z.course_90d).length,
    zombies_note: rep.zombies_note, bestsellers_no_compare_at: rep.bestsellers_no_compare_at.length,
    bestsellers_no_compare_at_ready: rep.bestsellers_no_compare_at.filter((b) => !b.too_new).length, skus: rep.skus,
  };
  const findings = [
    ...(rep.zombies || []).slice(0, LIST_CAP).map((z) => ({ kind: "zombie", severity: "low", ...z, message: `No sales in ${ZOMBIE_DAYS} days (${z.age_days} days live)${z.course_90d ? "; also past the course's 90 days" : ""}: draft candidate (draft 50, launch 50)` })),
    ...rep.bestsellers_no_compare_at.map((b) => ({ kind: "bestseller_no_compare_at", severity: b.too_new ? "info" : "low", ...b,
      message: b.too_new ? `${b.units_30d} sold in 30 days, no compare-at, but under ${NO_COMPARE_AT_DAYS} days old: leave it (GMC Playbook)` : `${b.units_30d} sold in 30 days and not on sale: sweep candidate (depth by your tier spread)` })),
  ];
  await saveRun(db, { agent: AGENT, store: storeId, day, nowMs, status: "ok", summary, findings });
  const name = STORES[storeId] ? STORES[storeId].name : storeId;
  const sk = rep.skus;
  await logEvent(db, {
    actor: AGENT, kind: "catalog.hygiene_report", store: storeId, at: nowIso(nowMs),
    summary: `${name} feed hygiene (${summary.month}): ${rep.zombies == null ? `zombies not claimed (${coverage60.why})` : `${rep.zombies.length} zombie${rep.zombies.length === 1 ? "" : "s"} (no sales in ${ZOMBIE_DAYS} days)`}; ` +
      `${summary.bestsellers_no_compare_at_ready} best-seller${summary.bestsellers_no_compare_at_ready === 1 ? "" : "s"} not on sale; ${sk.skus} SKUs vs ${sk.avg_daily_spend == null ? `spend unknown (${spendWhy})` : `$${sk.avg_daily_spend.toFixed(2)}/day (course: ~${sk.course_benchmark_skus}): ${sk.verdict}`}. Proposals only.`,
    data: summary,
  });
  return { status: "ok", ...summary };
}
