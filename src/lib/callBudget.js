/**
 * Outbound-call budget for one Worker run.
 *
 * Why: a Worker invocation may make at most 50 outbound subrequests (free plan; the catalog
 * sync keeps its own page budget for the same reason, see agents/catalog/sync.js). The P&L
 * department slot runs several jobs that all call Google or Shopify, so they share ONE budget:
 * each job checks `left` before a unit of work that needs several calls (a workbook read, a
 * write with its re-reads) and stops cleanly, resuming next run, instead of failing half-way.
 * The wrapped fetch refuses any call past the limit (code CALL_BUDGET), as a last guard.
 */
export class CallBudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = "CallBudgetError";
    this.code = "CALL_BUDGET";
  }
}

export function callBudget(limit, fetchImpl = fetch) {
  const b = {
    limit,
    used: 0,
    get left() { return Math.max(0, b.limit - b.used); },
    /** True when `n` more calls fit. */
    has(n) { return b.left >= n; },
    fetch: async (...args) => {
      if (b.used >= b.limit) throw new CallBudgetError(`outbound call budget for this run (${b.limit}) used up`);
      b.used++;
      return fetchImpl(...args);
    },
  };
  return b;
}

/** No limit (direct calls, tests): same shape. */
export const unlimited = (fetchImpl = fetch) => callBudget(Infinity, fetchImpl);
