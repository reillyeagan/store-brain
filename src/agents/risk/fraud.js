/**
 * Fraud Screen (risk.fraud) — SHADOW, plain code.
 *
 * Reilly, 2026-10-11: "fraud screen for shopify orders is still good, just know that it is
 * VERY rare i will need to do anything, i have not cancelled any so far." So: low noise.
 *
 * What it does: every hour (Risk's slot in the department rotation), reads each live store's orders from the last 3 days
 * (read-only) and screens each one ONCE:
 *   - Shopify's own verdict: the highest riskLevel among the order's risk assessments and
 *     the overall recommendation (ACCEPT / INVESTIGATE / CANCEL);
 *   - simple code checks: billing country ≠ shipping country; the same email or the same
 *     card (BIN + last digits) on 3+ orders within 24 hours.
 * Verdict: HIGH only when Shopify itself says HIGH or CANCEL (code checks alone never make
 * an order HIGH: that would be noise). MEDIUM when Shopify says MEDIUM/INVESTIGATE or a code
 * check fires. One event per flagged order; an approval ONLY for HIGH. While Shopify's
 * assessment is still PENDING the order is re-checked on later runs (up to 24 hours).
 *
 * Inputs: Shopify Admin GraphQL `orders` with `risk` and transactions (Store Guard).
 * Outputs: risk_order_screens, events, approvals (HIGH only).
 * Never cancels, refunds or edits an order: Reilly does that himself in Shopify.
 *
 * Not built: card-testing spikes (many checkouts, no orders). That needs checkout/session
 * data this agent doesn't read yet; see the Risk build notes.
 */
import { LIVE_STORE_IDS, STORES } from "../../config/stores.js";
import { shopifyGraphQL } from "../../lib/storeGuard.js";
import { createApproval } from "../../lib/approvals.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { DEPT, DAY_MS, moneyOf, currencyOf, fmtMoney, logProblem, logOnce } from "./shared.js";

export const ACTOR = "risk.fraud";
export const LOOKBACK_DAYS = 3;
export const VELOCITY_COUNT = 3;          // same email/card on this many orders...
export const VELOCITY_WINDOW_MS = DAY_MS; // ...within this window
export const PENDING_RECHECK_MS = DAY_MS; // stop waiting on a PENDING Shopify assessment after this

/** Validated against the Admin 2026-07 schema. */
export const ORDERS_QUERY = `query RiskOrders($q: String!) {
  orders(first: 50, query: $q, sortKey: CREATED_AT, reverse: true) {
    nodes {
      id name createdAt email test cancelledAt
      totalPriceSet { shopMoney { amount currencyCode } }
      customer { id }
      billingAddress { countryCodeV2 }
      shippingAddress { countryCodeV2 }
      risk { recommendation assessments { riskLevel facts { description sentiment } provider { title } } }
      transactions(first: 3) { kind status gateway paymentDetails { ... on CardPaymentDetails { bin number company } } }
    }
  }
}`;

const LEVEL_RANK = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

/** Highest Shopify risk level across assessments; PENDING if any is still pending. */
export function shopifyLevel(risk) {
  const list = (risk && Array.isArray(risk.assessments)) ? risk.assessments : [];
  if (!list.length) return null;
  if (list.some((a) => a.riskLevel === "PENDING")) return "PENDING";
  return list.reduce((best, a) => (LEVEL_RANK[a.riskLevel] ?? -1) > (LEVEL_RANK[best] ?? -1) ? a.riskLevel : best, "NONE");
}

/** Card key: BIN + masked last digits. Null when the order wasn't paid by card. */
export function cardKey(order) {
  for (const t of order.transactions || []) {
    const p = t && t.paymentDetails;
    if (p && (p.bin || p.number)) return `${p.bin || "?"}:${String(p.number || "").replace(/[^0-9]/g, "").slice(-4)}`;
  }
  return null;
}

/**
 * Pure: screen one order against Shopify's verdict and the other orders read this run.
 * @returns {{level: "HIGH"|"MEDIUM"|null, reasons: string[], shopify: string|null, recommendation: string|null, pending: boolean}}
 */
export function screenOrder(order, others) {
  const reasons = [];
  const shopify = shopifyLevel(order.risk);
  const rec = (order.risk && order.risk.recommendation) || null;
  let level = null;
  if (shopify === "HIGH" || rec === "CANCEL") {
    level = "HIGH";
    reasons.push(rec === "CANCEL" ? "Shopify recommends cancelling this order" : "Shopify rates this order HIGH risk");
  } else if (shopify === "MEDIUM" || rec === "INVESTIGATE") {
    level = "MEDIUM";
    reasons.push(rec === "INVESTIGATE" ? "Shopify recommends investigating" : "Shopify rates this order MEDIUM risk");
  }
  const facts = ((order.risk && order.risk.assessments) || []).flatMap((a) => (a.facts || []))
    .filter((f) => f.sentiment === "NEGATIVE").map((f) => f.description).filter(Boolean).slice(0, 3);
  if (level && facts.length) reasons.push(`Shopify says: ${facts.join("; ")}`);

  const bc = order.billingAddress && order.billingAddress.countryCodeV2;
  const sc = order.shippingAddress && order.shippingAddress.countryCodeV2;
  if (bc && sc && bc !== sc) reasons.push(`Billing country ${bc} ≠ shipping country ${sc}`);

  const t0 = Date.parse(order.createdAt);
  const near = others.filter((o) => o.id !== order.id && Math.abs(Date.parse(o.createdAt) - t0) <= VELOCITY_WINDOW_MS);
  const email = order.email ? String(order.email).toLowerCase() : null;
  if (email) {
    const n = 1 + near.filter((o) => o.email && String(o.email).toLowerCase() === email).length;
    if (n >= VELOCITY_COUNT) reasons.push(`Same email on ${n} orders within 24 hours`);
  }
  const card = cardKey(order);
  if (card) {
    const n = 1 + near.filter((o) => cardKey(o) === card).length;
    if (n >= VELOCITY_COUNT) reasons.push(`Same card on ${n} orders within 24 hours`);
  }
  // Code checks raise MEDIUM at most: HIGH stays Shopify's call, so Reilly is only asked when it matters.
  if (!level && reasons.length) level = "MEDIUM";
  return { level, reasons, shopify, recommendation: rec, pending: shopify === "PENDING" };
}

async function raiseHigh(db, storeId, order, verdict, nowMs) {
  const total = moneyOf(order.totalPriceSet);
  return createApproval(db, {
    dept: DEPT, requestedBy: ACTOR, store: storeId,
    title: `High-risk order ${order.name} (${fmtMoney(total, currencyOf(order.totalPriceSet))}) · ${verdict.reasons[0]} · ${STORES[storeId].name}`,
    options: [
      { id: "keep", label: "It's fine, fulfil as normal", detail: verdict.reasons.join(" · ").slice(0, 300) },
      { id: "cancel_myself", label: "I'll cancel and refund it in Shopify myself", detail: "The brain never cancels orders." },
    ],
  });
}

/** Write (or update) one order's screen. An approval id once saved is never cleared. */
async function saveScreen(db, storeId, order, v, { level, final, approvalId, at }) {
  await db.prepare(
    `INSERT INTO risk_order_screens (store, order_id, order_name, order_created_at, shopify_level, recommendation, level, reasons, final, approval_id, screened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(store, order_id) DO UPDATE SET shopify_level = excluded.shopify_level, recommendation = excluded.recommendation,
       level = excluded.level, reasons = excluded.reasons, final = excluded.final,
       approval_id = COALESCE(excluded.approval_id, risk_order_screens.approval_id), screened_at = excluded.screened_at`
  ).bind(storeId, order.id, order.name, order.createdAt, v.shopify, v.recommendation, level,
    JSON.stringify(v.reasons), final, approvalId, at).run();
}

export async function runFraud(env,{ nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const since = new Date(nowMs - LOOKBACK_DAYS * DAY_MS).toISOString();
  const stores = {};
  let flaggedNow = 0;
  for (const storeId of LIVE_STORE_IDS) {
    let data;
    try {
      data = await shopifyGraphQL(env, storeId, ORDERS_QUERY, { q: `created_at:>='${since}'` }, { fetchImpl, nowMs });
    } catch (err) {
      stores[storeId] = await logProblem(db, ACTOR, storeId, err, `${STORES[storeId].name} fraud screen`, nowMs);
      continue;
    }
    const orders = ((data && data.orders && data.orders.nodes) || []).filter((o) => o && !o.test && !o.cancelledAt);
    let screened = 0, flagged = 0;
    for (const order of orders) {
      try {
        const prev = await db.prepare(`SELECT final, level, approval_id FROM risk_order_screens WHERE store = ? AND order_id = ?`).bind(storeId, order.id).first();
        if (prev && prev.final) continue;
        const v = screenOrder(order, orders);
        // Wait for Shopify's own analysis, but not forever: after 24h judge on what we have.
        const waiting = v.pending && nowMs - Date.parse(order.createdAt) < PENDING_RECHECK_MS;
        const flaggedOrder = !waiting && !!v.level;
        let approvalId = (prev && prev.approval_id) || null;
        if (flaggedOrder && v.level === "HIGH" && !approvalId) {
          // Approval FIRST, its id saved at once on a NOT-final row: if anything after this
          // fails, the next run finds the id (no second approval) and finishes the job. If the
          // approval itself fails, nothing is final and the next run tries again.
          approvalId = await raiseHigh(db, storeId, order, v, nowMs);
          await saveScreen(db, storeId, order, v, { level: v.level, final: 0, approvalId, at });
        }
        if (flaggedOrder) {
          await logEvent(db, {
            actor: ACTOR, kind: v.level === "HIGH" ? "risk.order_high" : "risk.order_flagged", store: storeId,
            target: v.level === "HIGH" ? "core.approvals" : undefined,
            summary: `${v.level === "HIGH" ? "HIGH-risk" : "Worth a look"}: ${order.name} (${fmtMoney(moneyOf(order.totalPriceSet), currencyOf(order.totalPriceSet))}): ${v.reasons.join("; ")}`.slice(0, 480),
            data: { orderId: order.id, level: v.level, shopify: v.shopify, recommendation: v.recommendation, reasons: v.reasons, approvalId },
            at,
          });
          flagged++; flaggedNow++;
        }
        // Marked final only now, after the approval and the event exist.
        await saveScreen(db, storeId, order, v, { level: waiting ? null : v.level, final: waiting ? 0 : 1, approvalId, at });
        screened++;
      } catch (err) {
        // One order failing never stops the rest; it stays not-final, so the next run retries it.
        await logProblem(db, ACTOR, storeId, err, `${STORES[storeId].name} fraud screen of ${order.name}`, nowMs);
      }
    }
    stores[storeId] = { orders: orders.length, screened, flagged };
  }
  const ok = Object.values(stores).filter((s) => typeof s === "object");
  if (ok.length && !flaggedNow) {
    // Clean runs: one quiet line every 12 hours at most (Reilly expects this to be rare).
    const n = ok.reduce((s, x) => s + x.screened, 0);
    await logOnce(db, { actor: ACTOR, kind: "risk.fraud_checked", target: "sys.shopify",
      summary: `Fraud screen: nothing flagged (${n} order${n === 1 ? "" : "s"} newly screened this run)`, data: { stores } },
    { windowMin: 12 * 60, nowMs });
  }
  return { stores, flagged: flaggedNow };
}
