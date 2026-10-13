/**
 * Sourcing Scout (sup.scout) — plain code, FLAG ONLY, SHADOW.
 *
 * Spec: wakes when a whole category fails (denials cluster, COGS above band even at the
 * ceiling) and proposes a new factory. Reilly, 2026-10-11 (Q7): "i havent tried this and havent
 * needed to" → not in scope for v1, "the brain only flags quality/margin problems".
 *
 * So this only FLAGS failing categories from the Quote Desk's own plans. It does not search for
 * or propose suppliers (no data source exists for that). Idle until quotes arrive.
 *
 * Inputs: supplier_plans (last 30 days). Output: sourcing_flags, an event when a flag is new or grows.
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { STORES } from "../../config/stores.js";

const ACTOR = "sup.scout";
export const WINDOW_DAYS = 30;
export const MIN_COUNT = 3;

export async function runScout(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const since = nowIso(nowMs - WINDOW_DAYS * 86400000);
  const { results } = await db.prepare(
    `SELECT store, COALESCE(NULLIF(TRIM(product_type), ''), 'uncategorised') AS category,
            CASE WHEN kind IN ('draft','already_off') THEN 'denials' ELSE 'over_ceiling' END AS signal,
            COUNT(DISTINCT product_handle) AS n, json_group_array(DISTINCT product_handle) AS examples
       FROM supplier_plans
      WHERE created_at >= ? AND (kind IN ('draft','already_off') OR (kind = 'reprice' AND waiver_price IS NOT NULL))
      GROUP BY store, category, signal HAVING n >= ?`
  ).bind(since, MIN_COUNT).all();
  let raised = 0;
  for (const f of results || []) {
    const prev = await db.prepare(`SELECT count FROM sourcing_flags WHERE store = ? AND category = ? AND signal = ?`).bind(f.store, f.category, f.signal).first();
    await db.prepare(
      `INSERT INTO sourcing_flags (store, category, signal, count, examples, first_at, last_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(store, category, signal) DO UPDATE SET count = excluded.count, examples = excluded.examples, last_at = excluded.last_at`
    ).bind(f.store, f.category, f.signal, f.n, f.examples, at, at).run();
    if (!prev || f.n > prev.count) {
      raised++;
      await logEvent(db, { actor: ACTOR, kind: "sourcing.flagged", store: f.store, at,
        summary: `${STORES[f.store] ? STORES[f.store].name : f.store} "${f.category}": ${f.n} products ${f.signal === "denials" ? "denied by KFB" : "can't reach the COGS band under the $144.95 ceiling"} in ${WINDOW_DAYS} days: this category may need a new source (flag only)`,
        data: { examples: JSON.parse(f.examples).slice(0, 10) } });
    }
  }
  return { flags: (results || []).length, raised };
}
