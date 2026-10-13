/**
 * Chargeback Agent (risk.chargebacks) — SHADOW.
 *
 * What it does: every hour, reads each live store's Shopify Payments disputes (read-only,
 * scope read_shopify_payments_disputes) and stores them. For every dispute that still
 * needs a response it:
 *   - raises ONE approval for Reilly (order, amount, due date), never a second one;
 *   - logs a reminder 7 days and 2 days before the evidence is due (spec: "Reminders 7 days
 *     and 2 days before the deadline"), and one "overdue" line if the date passes;
 *   - builds an evidence pack DRAFT in the ledger: code gathers the order, customer,
 *     fulfillment and tracking numbers, delivery info, customer emails (if the CS tables
 *     exist) and policy facts from the Core; Claude writes a rebuttal draft ONCE per dispute.
 *
 * Inputs: Shopify Admin GraphQL `disputes` (via Store Guard), the ledger's shipments and
 * core_facts tables, CS tables when they exist (optional).
 * Outputs: risk_disputes, risk_evidence_packs, approvals, events.
 *
 * It NEVER submits evidence: there is no write scope, and Reilly submits in Shopify
 * (CLAUDE.md rule 12). Due dates always come from Shopify's own answer, never from notes.
 */
import { LIVE_STORE_IDS, STORES } from "../../config/stores.js";
import { shopifyGraphQL } from "../../lib/storeGuard.js";
import { createApproval } from "../../lib/approvals.js";
import { logEvent } from "../../lib/eventlog.js";
import { askClaude } from "../../lib/ai.js";
import { nowIso, localDay } from "../../lib/time.js";
import {
  DEPT, moneyOf, currencyOf, fmtMoney, fmtDay, daysLeft, logProblem, logOnce, safeJson, tableExists,
} from "./shared.js";

export const ACTOR = "risk.chargebacks";

/** Spec (Reilly-approved): reminders 7 days and 2 days before the deadline. */
export const REMINDER_DAYS = Object.freeze([7, 2]);
/** At most this many rebuttal drafts per run: AI is capped, and each dispute gets one. */
export const MAX_AI_DRAFTS_PER_RUN = 1;
export const DISPUTES_PER_STORE = 25;

/** Validated against the Admin 2026-07 schema (disputes is a QueryRoot field). */
export const DISPUTES_QUERY = `query RiskDisputes($first: Int!) {
  disputes(first: $first, reverse: true) {
    nodes {
      id legacyResourceId status type initiatedAt evidenceDueBy evidenceSentOn finalizedOn
      amount { amount currencyCode }
      reasonDetails { reason networkReasonCode }
      order {
        id name createdAt email displayFulfillmentStatus
        totalPriceSet { shopMoney { amount currencyCode } }
        customer { id displayName numberOfOrders }
        shippingAddress { name city provinceCode countryCodeV2 zip }
        billingAddress { countryCodeV2 zip }
        fulfillments(first: 5) { createdAt displayStatus deliveredAt trackingInfo(first: 3) { number company url } }
        lineItems(first: 10) { nodes { title variantTitle quantity sku } }
      }
    }
  }
}`;

/** A dispute Reilly still has to answer. */
export const needsResponse = (d) => d && d.status === "NEEDS_RESPONSE" && !d.evidence_sent_on;

/** Shopify node → ledger row fields. */
export function disputeFromNode(n) {
  const o = n.order || null;
  return {
    dispute_id: n.id,
    legacy_id: n.legacyResourceId != null ? String(n.legacyResourceId) : null,
    order_id: o ? o.id : null,
    order_name: o ? o.name : null,
    status: n.status || null,
    type: n.type || null,
    reason: (n.reasonDetails && n.reasonDetails.reason) || null,
    network_reason_code: (n.reasonDetails && n.reasonDetails.networkReasonCode) || null,
    amount: moneyOf(n.amount),
    currency: currencyOf(n.amount),
    initiated_at: n.initiatedAt || null,
    evidence_due_by: n.evidenceDueBy || null,
    evidence_sent_on: n.evidenceSentOn || null,
    finalized_on: n.finalizedOn || null,
    order_snapshot: o,
  };
}

async function upsertDispute(db, storeId, d, at) {
  const before = await db.prepare(`SELECT * FROM risk_disputes WHERE store = ? AND dispute_id = ?`).bind(storeId, d.dispute_id).first();
  await db.prepare(
    `INSERT INTO risk_disputes (store, dispute_id, legacy_id, order_id, order_name, status, type, reason, network_reason_code,
       amount, currency, initiated_at, evidence_due_by, evidence_sent_on, finalized_on, order_snapshot, reminders, first_seen_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
     ON CONFLICT(store, dispute_id) DO UPDATE SET legacy_id = excluded.legacy_id, order_id = excluded.order_id,
       order_name = excluded.order_name, status = excluded.status, type = excluded.type, reason = excluded.reason,
       network_reason_code = excluded.network_reason_code, amount = excluded.amount, currency = excluded.currency,
       initiated_at = excluded.initiated_at, evidence_due_by = excluded.evidence_due_by,
       evidence_sent_on = excluded.evidence_sent_on, finalized_on = excluded.finalized_on,
       order_snapshot = excluded.order_snapshot, fetched_at = excluded.fetched_at`
  ).bind(storeId, d.dispute_id, d.legacy_id, d.order_id, d.order_name, d.status, d.type, d.reason, d.network_reason_code,
    d.amount, d.currency, d.initiated_at, d.evidence_due_by, d.evidence_sent_on, d.finalized_on,
    d.order_snapshot ? JSON.stringify(d.order_snapshot) : null, at, at).run();
  const after = await db.prepare(`SELECT * FROM risk_disputes WHERE store = ? AND dispute_id = ?`).bind(storeId, d.dispute_id).first();
  return { before, after };
}

const label = (d) => d.order_name || `dispute ${d.legacy_id || d.dispute_id}`;
const reasonText = (r) => (r ? String(r).toLowerCase().replace(/_/g, " ") : "reason not given");

/**
 * The approval title: order, amount and due date, as the spec and brief ask. No countdown:
 * the title is stored once and would go stale ("18 days left" read a week later is wrong).
 * The countdown lives in the option detail, dated (see countdownAsOf).
 */
export function approvalTitle(storeId, d) {
  const kind = d.type === "INQUIRY" ? "Inquiry" : "Chargeback";
  return `${kind} ${label(d)} · ${fmtMoney(d.amount, d.currency)} · evidence due ${fmtDay(d.evidence_due_by)} · ${STORES[storeId].name}`;
}

/** "As of Oct 13: 18 days left" (or due today / N days overdue). Dated, so it can't mislead later. */
export function countdownAsOf(d, nowMs) {
  const dl = daysLeft(d.evidence_due_by, nowMs);
  if (dl == null) return "Shopify gave no due date";
  const asOf = `As of ${fmtDay(localDay(nowMs, "America/New_York"))}`;
  if (dl < 0) return `${asOf}: ${-dl} day${dl === -1 ? "" : "s"} OVERDUE`;
  if (dl === 0) return `${asOf}: due TODAY`;
  return `${asOf}: ${dl} day${dl === 1 ? "" : "s"} left`;
}

/**
 * One approval per dispute, ever. The claim is atomic (approval_id NULL → -1) so two
 * overlapping runs can't both create one; the real id replaces -1 straight after.
 */
async function ensureApproval(db, storeId, d, nowMs) {
  if (d.approval_id != null) return null;
  const claim = await db.prepare(`UPDATE risk_disputes SET approval_id = -1 WHERE store = ? AND dispute_id = ? AND approval_id IS NULL`)
    .bind(storeId, d.dispute_id).run();
  if (!claim.meta || claim.meta.changes !== 1) return null;
  try {
    const id = await createApproval(db, {
      dept: DEPT, requestedBy: ACTOR, store: storeId,
      title: approvalTitle(storeId, d),
      options: [
        { id: "will_submit", label: "I'll submit the evidence in Shopify", detail: `${countdownAsOf(d, nowMs)}. Reason: ${reasonText(d.reason)}. The evidence draft is on the Risk page; the brain never submits.` },
        { id: "accept_loss", label: "Don't fight it (I'll accept it in Shopify)", detail: `${fmtMoney(d.amount, d.currency)} is lost if accepted.` },
      ],
    });
    await db.prepare(`UPDATE risk_disputes SET approval_id = ? WHERE store = ? AND dispute_id = ?`).bind(id, storeId, d.dispute_id).run();
    return id;
  } catch (err) {
    // Give the claim back so the next run tries again (never leave a dispute without its approval).
    await db.prepare(`UPDATE risk_disputes SET approval_id = NULL WHERE store = ? AND dispute_id = ? AND approval_id = -1`).bind(storeId, d.dispute_id).run();
    throw err;
  }
}

/**
 * Which reminder (if any) is due now. On first sight of a dispute that is already close to
 * its date, only the most urgent reminder is sent and the earlier ones count as passed.
 */
export function reminderDue(dl, sent) {
  if (dl == null || dl < 0) return null;
  const crossed = REMINDER_DAYS.filter((t) => dl <= t && !sent.includes(t));
  if (!crossed.length) return null;
  return { send: Math.min(...crossed), mark: crossed };
}

async function remindIfDue(db, storeId, d, nowMs) {
  const dl = daysLeft(d.evidence_due_by, nowMs);
  const sent = safeJson(d.reminders, []) || [];
  const due = reminderDue(dl, sent);
  if (due) {
    const pack = await db.prepare(`SELECT status FROM risk_evidence_packs WHERE store = ? AND dispute_id = ?`).bind(storeId, d.dispute_id).first();
    const packLine = pack && pack.status === "draft" ? "Evidence draft is ready to review." : "Evidence draft is not finished yet (facts gathered, rebuttal pending).";
    await db.prepare(`UPDATE risk_disputes SET reminders = ? WHERE store = ? AND dispute_id = ?`)
      .bind(JSON.stringify([...sent, ...due.mark].sort((a, b) => b - a)), storeId, d.dispute_id).run();
    await logEvent(db, {
      actor: ACTOR, kind: "risk.dispute_reminder", store: storeId, target: "core.approvals",
      summary: `Reminder: ${label(d)} chargeback (${fmtMoney(d.amount, d.currency)}) evidence due ${fmtDay(d.evidence_due_by)}, ${dl === 0 ? "TODAY" : `${dl} day${dl === 1 ? "" : "s"} left`}. ${packLine}`,
      data: { disputeId: d.dispute_id, daysLeft: dl, threshold: due.send, approvalId: d.approval_id },
      at: nowIso(nowMs),
    });
    return true;
  }
  if (dl != null && dl < 0 && !d.overdue_noted_at) {
    await db.prepare(`UPDATE risk_disputes SET overdue_noted_at = ? WHERE store = ? AND dispute_id = ?`).bind(nowIso(nowMs), storeId, d.dispute_id).run();
    await logEvent(db, {
      actor: ACTOR, kind: "risk.dispute_overdue", store: storeId,
      summary: `${label(d)} chargeback (${fmtMoney(d.amount, d.currency)}): evidence was due ${fmtDay(d.evidence_due_by)} and Shopify still shows no response.`,
      data: { disputeId: d.dispute_id, daysLeft: dl }, at: nowIso(nowMs),
    });
  }
  return false;
}

/* ---------------- evidence pack (code part) ---------------- */

/**
 * Remove personal details from free text before it is stored in a pack or sent to Claude:
 * email addresses, phone numbers, street addresses, and the customer's own name, city and
 * ZIP (passed in as `known`). Errs towards removing too much: a redacted word costs nothing,
 * a leaked address can't be taken back.
 */
export function redactPii(text, known = []) {
  let s = String(text || "");
  s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");
  s = s.replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]");
  s = s.replace(/\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){0,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|way|court|ct|place|pl|terrace|circle|cir|highway|hwy|parkway|pkwy)\b\.?(?:\s*(?:apt|apartment|suite|ste|unit|#)\s*[\w-]+)?/gi, "[address]");
  for (const k of known) {
    for (const w of String(k || "").split(/\s+/)) {
      if (w.length < 3) continue;
      s = s.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "[redacted]");
    }
  }
  return s;
}

/** The customer's own identifying words (name, city, ZIP) from the order, for redaction. */
function knownPii(o) {
  if (!o) return [];
  const a = o.shippingAddress || {}, b = o.billingAddress || {};
  return [o.customer && o.customer.displayName, a.name, a.city, a.zip, b.zip].filter(Boolean);
}

/**
 * Customer emails about this order, from the CS department's cs_tickets table when it exists
 * (optional input). Only the date, subject and a clipped, redacted body are taken: never the
 * sender's address or name, CS's drafts, triage or order context.
 *
 * Matched ONLY on the order CS verified (cs_tickets.order_id, set by Order Context when the
 * sender's email matches the order) and never on a ticket CS marked order_mismatch. The
 * number a customer typed (order_ref) proves nothing: a stranger writing "#1053" must not
 * land in #1053's chargeback evidence, nor reach Claude.
 */
async function customerMessages(db, storeId, d, o) {
  if (!d.order_id || !(await tableExists(db, "cs_tickets"))) return [];
  try {
    const { results } = await db.prepare(
      `SELECT received_at, subject, body FROM cs_tickets
        WHERE order_id = ? AND COALESCE(order_mismatch, 0) = 0
          AND (order_store = ? OR (order_store IS NULL AND store = ?))
        ORDER BY received_at LIMIT 10`
    ).bind(d.order_id, storeId, storeId).all();
    const known = knownPii(o);
    return (results || []).map((r) => ({
      received_at: r.received_at || null,
      subject: redactPii(String(r.subject || "").slice(0, 200), known),
      body: redactPii(String(r.body || "").slice(0, 600), known),
    }));
  } catch {
    return []; // CS schema changed: the pack still builds; "emails" shows as missing evidence
  }
}

/** Everything code can gather for one dispute. Pure facts; no judgement. */
export async function gatherFacts(db, storeId, d) {
  const o = safeJson(d.order_snapshot, null);
  const fulfillments = (o && Array.isArray(o.fulfillments) ? o.fulfillments : []).map((f) => ({
    shipped_at: f.createdAt || null, status: f.displayStatus || null, delivered_at: f.deliveredAt || null,
    tracking: (f.trackingInfo || []).map((t) => ({ number: t.number || null, company: t.company || null, url: t.url || null })),
  }));
  let ledgerShipments = [];
  if (d.order_id && (await tableExists(db, "shipments"))) {
    const { results } = await db.prepare(
      `SELECT tracking_number, carrier_hint, shipped_at, state, last_status, last_event_at, last_event_text, last_event_location,
              pickup_at, delivered_at, pod, shopify_status, shopify_delivered_at
         FROM shipments WHERE store = ? AND order_id = ? LIMIT 5`
    ).bind(storeId, d.order_id).all().catch(() => ({ results: [] }));
    ledgerShipments = results || [];
  }
  const { results: policies } = await db.prepare(
    `SELECT key, value, source, observed_at FROM core_facts WHERE live = 1 AND area = 'policy' AND (store = ? OR store IS NULL) ORDER BY id DESC LIMIT 10`
  ).bind(storeId).all();
  const messages = await customerMessages(db, storeId, d, o);
  const ship = o && o.shippingAddress, bill = o && o.billingAddress;
  return {
    store: STORES[storeId].name,
    dispute: {
      type: d.type, reason: d.reason, network_reason_code: d.network_reason_code, amount: d.amount, currency: d.currency,
      initiated_at: d.initiated_at, evidence_due_by: d.evidence_due_by, status: d.status,
    },
    order: o ? {
      name: o.name, created_at: o.createdAt, total: moneyOf(o.totalPriceSet), currency: currencyOf(o.totalPriceSet),
      fulfillment_status: o.displayFulfillmentStatus || null,
      lines: ((o.lineItems && o.lineItems.nodes) || []).map((l) => ({ title: l.title, variant: l.variantTitle, qty: l.quantity, sku: l.sku })),
    } : null,
    customer: o ? {
      name: (o.customer && o.customer.displayName) || (ship && ship.name) || null,
      email: o.email || null,
      orders_with_store: o.customer ? o.customer.numberOfOrders ?? null : null,
    } : null,
    shipping_address: ship ? { name: ship.name, city: ship.city, province: ship.provinceCode, country: ship.countryCodeV2, zip: ship.zip } : null,
    billing_address: bill ? { country: bill.countryCodeV2, zip: bill.zip } : null,
    fulfillments,
    ledger_shipments: ledgerShipments,
    customer_messages: messages,
    policies: (policies || []).map((p) => ({ key: p.key, value: String(p.value).slice(0, 800), source: p.source })),
  };
}

/** What a strong response would include that we could not find (Reilly adds it by hand). */
export function missingEvidence(f) {
  const miss = [];
  const tracking = f.fulfillments.flatMap((x) => x.tracking).filter((t) => t.number);
  const ledgerTracking = f.ledger_shipments.filter((s) => s.tracking_number);
  if (!f.order) miss.push("The order itself (Shopify did not link an order to this dispute)");
  if (!tracking.length && !ledgerTracking.length) miss.push("Tracking number (the order has no fulfillment with tracking in Shopify)");
  const delivered = f.fulfillments.some((x) => x.delivered_at) || f.ledger_shipments.some((s) => s.delivered_at || s.shopify_delivered_at);
  if (!delivered) miss.push("Proof of delivery (no delivery date from Shopify; parcel tracking is off, so check the carrier site and screenshot it)");
  if (!f.customer_messages.length) miss.push("Customer emails about this order (the CS inbox isn't linked to the ledger yet: search Gmail for the order number)");
  if (!f.policies.length) miss.push("Refund/return policy text (not in the Core yet: copy it from the store's policy page)");
  if (f.dispute.reason === "FRAUDULENT" && f.billing_address && f.shipping_address &&
      f.billing_address.zip && f.shipping_address.zip && f.billing_address.zip !== f.shipping_address.zip) {
    miss.push("Billing and shipping ZIP differ: an AVS/CVV match screenshot from the order's payment details would help");
  }
  return miss;
}

async function savePackFacts(db, storeId, d, nowMs) {
  const facts = await gatherFacts(db, storeId, d);
  const missing = missingEvidence(facts);
  const at = nowIso(nowMs);
  await db.prepare(
    `INSERT INTO risk_evidence_packs (store, dispute_id, status, facts, missing, created_at, updated_at)
     VALUES (?, ?, 'facts_only', ?, ?, ?, ?)
     ON CONFLICT(store, dispute_id) DO UPDATE SET facts = excluded.facts, missing = excluded.missing, updated_at = excluded.updated_at`
  ).bind(storeId, d.dispute_id, JSON.stringify(facts), JSON.stringify(missing), at, at).run();
}

/* ---------------- evidence pack (AI rebuttal, once per dispute) ---------------- */

const REBUTTAL_SYSTEM = `You draft a chargeback response for the owner of a small online clothing store. He reviews it and submits it himself in Shopify.
Rules:
- Use ONLY the facts in the JSON. Never invent tracking numbers, dates, delivery confirmations, emails or customer statements.
- Where a piece of evidence is missing, write [ADD: what is needed] so he knows to attach it.
- Answer the specific dispute reason. Factual, calm, under 300 words. No greeting, no sign-off.`;

/**
 * What Claude sees: no email, no name, no street/city/ZIP, no carrier scan locations. A
 * rebuttal doesn't need them (Shopify attaches the order details itself), so personal
 * data never leaves the ledger. Message text is redacted a second time, belt and braces.
 */
export function factsForAi(facts, missing) {
  const f = JSON.parse(JSON.stringify(facts));
  const ship = f.shipping_address || {}, bill = f.billing_address || {};
  const known = [f.customer && f.customer.name, ship.name, ship.city, ship.zip, bill.zip].filter(Boolean);
  if (f.customer) f.customer = { orders_with_store: f.customer.orders_with_store ?? null };
  if (f.shipping_address) {
    f.shipping_address = { province: ship.province || null, country: ship.country || null };
  }
  if (f.billing_address) {
    f.billing_address = {
      country: bill.country || null,
      zip_matches_shipping: bill.zip && ship.zip ? bill.zip === ship.zip : null,
    };
  }
  f.ledger_shipments = (f.ledger_shipments || []).map(({ last_event_location, ...s }) => s);
  f.customer_messages = (f.customer_messages || []).map((m) => ({
    received_at: m.received_at || null, subject: redactPii(m.subject, known), body: redactPii(m.body, known),
  }));
  return { ...f, evidence_we_could_not_find: missing };
}

export async function draftRebuttals(env, { nowMs, fetchImpl, limit = MAX_AI_DRAFTS_PER_RUN }) {
  const { results } = await env.DB.prepare(
    `SELECT p.*, d.order_name, d.legacy_id, d.status AS dispute_status, d.evidence_sent_on
       FROM risk_evidence_packs p JOIN risk_disputes d ON d.store = p.store AND d.dispute_id = p.dispute_id
      WHERE p.ai_attempted_at IS NULL AND p.status IN ('facts_only', 'waiting_ai')
        AND d.status = 'NEEDS_RESPONSE' AND d.evidence_sent_on IS NULL
      ORDER BY d.evidence_due_by LIMIT ?`
  ).bind(limit).all();
  const out = [];
  for (const p of results || []) {
    const facts = safeJson(p.facts, {});
    const missing = safeJson(p.missing, []);
    let r;
    try {
      r = await askClaude(env, {
        system: REBUTTAL_SYSTEM, user: JSON.stringify(factsForAi(facts, missing)), maxTokens: 700,
        actor: ACTOR, label: `Chargeback rebuttal draft ${p.order_name || p.legacy_id || ""}`.trim(), store: p.store,
      }, { fetchImpl, nowMs });
    } catch (err) {
      // A real attempt that failed counts as the one attempt: no retry loop that burns budget.
      await env.DB.prepare(`UPDATE risk_evidence_packs SET status = 'ai_failed', ai_attempted_at = ?, ai_error = ?, updated_at = ? WHERE store = ? AND dispute_id = ?`)
        .bind(nowIso(nowMs), String(err && err.message).slice(0, 300), nowIso(nowMs), p.store, p.dispute_id).run();
      await logEvent(env.DB, { actor: ACTOR, kind: "error.risk", store: p.store, target: "sys.claude",
        summary: `Rebuttal draft for ${p.order_name || "a dispute"} failed; the facts pack is still there for Reilly (${String(err && err.message).slice(0, 160)})`, at: nowIso(nowMs) });
      out.push({ dispute: p.dispute_id, result: "ai_failed" });
      continue;
    }
    if (r.skipped) {
      // No key or budget reached: not an attempt. Wait and try on a later run.
      await env.DB.prepare(`UPDATE risk_evidence_packs SET status = 'waiting_ai', ai_error = ?, updated_at = ? WHERE store = ? AND dispute_id = ?`)
        .bind(r.skipped, nowIso(nowMs), p.store, p.dispute_id).run();
      out.push({ dispute: p.dispute_id, result: `waiting on AI (${r.skipped})` });
      break; // the same reason applies to every other pack this run
    }
    await env.DB.prepare(`UPDATE risk_evidence_packs SET status = 'draft', rebuttal = ?, ai_model = ?, ai_attempted_at = ?, ai_error = NULL, updated_at = ? WHERE store = ? AND dispute_id = ?`)
      .bind(r.text, r.model, nowIso(nowMs), nowIso(nowMs), p.store, p.dispute_id).run();
    await logEvent(env.DB, {
      actor: ACTOR, kind: "risk.evidence_drafted", store: p.store,
      summary: `Evidence draft ready for ${p.order_name || "a dispute"}: rebuttal written, ${missing.length} item${missing.length === 1 ? "" : "s"} for Reilly to add. Not submitted (Reilly submits in Shopify).`,
      data: { disputeId: p.dispute_id, missing }, at: nowIso(nowMs),
    });
    out.push({ dispute: p.dispute_id, result: "draft" });
  }
  return out;
}

/* ---------------- the run ---------------- */

/** A pending approval for a dispute that no longer needs a response is closed as expired. */
async function expireApproval(db, storeId, d, nowMs) {
  if (!d.approval_id || d.approval_id < 0) return;
  const res = await db.prepare(`UPDATE approvals SET status = 'expired', decided_at = ?, note = ? WHERE id = ? AND status = 'pending'`)
    .bind(nowIso(nowMs), `Closed by the brain: Shopify now shows this dispute as ${d.status}`, d.approval_id).run();
  if (res.meta && res.meta.changes === 1) {
    await logEvent(db, { actor: ACTOR, kind: "approval.expired", store: storeId, target: "core.approvals",
      summary: `No longer waiting on Reilly: ${label(d)} dispute is now ${String(d.status).toLowerCase().replace(/_/g, " ")} in Shopify`,
      data: { approvalId: d.approval_id, disputeId: d.dispute_id }, at: nowIso(nowMs) });
  }
}

export async function runChargebacks(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const stores = {};
  let changes = 0;
  for (const storeId of LIVE_STORE_IDS) {
    let data;
    try {
      data = await shopifyGraphQL(env, storeId, DISPUTES_QUERY, { first: DISPUTES_PER_STORE }, { fetchImpl, nowMs });
    } catch (err) {
      stores[storeId] = await logProblem(db, ACTOR, storeId, err, `${STORES[storeId].name} disputes read`, nowMs);
      continue;
    }
    const nodes = (data && data.disputes && data.disputes.nodes) || [];
    let open = 0;
    for (const n of nodes) {
      const { before, after } = await upsertDispute(db, storeId, disputeFromNode(n), at);
      if (!before) {
        changes++;
        await logEvent(db, {
          actor: ACTOR, kind: "risk.dispute_new", store: storeId, target: "sys.shopify",
          summary: `${after.type === "INQUIRY" ? "Inquiry" : "Chargeback"} on ${label(after)}: ${fmtMoney(after.amount, after.currency)}, ${reasonText(after.reason)}, status ${after.status}${after.evidence_due_by ? `, evidence due ${fmtDay(after.evidence_due_by)}` : ""}`,
          data: { disputeId: after.dispute_id, status: after.status, due: after.evidence_due_by }, at,
        });
      } else if (before.status !== after.status) {
        changes++;
        await logEvent(db, {
          actor: ACTOR, kind: "risk.dispute_status", store: storeId,
          summary: `${label(after)} dispute: ${before.status} → ${after.status} (${fmtMoney(after.amount, after.currency)})`,
          data: { disputeId: after.dispute_id, from: before.status, to: after.status }, at,
        });
      }
      if (needsResponse(after)) {
        open++;
        await savePackFacts(db, storeId, after, nowMs);
        await ensureApproval(db, storeId, after, nowMs);
        const fresh = await db.prepare(`SELECT * FROM risk_disputes WHERE store = ? AND dispute_id = ?`).bind(storeId, after.dispute_id).first();
        await remindIfDue(db, storeId, fresh, nowMs);
      } else {
        await expireApproval(db, storeId, after, nowMs);
      }
    }
    stores[storeId] = { read: nodes.length, needsResponse: open };
  }
  const drafts = await draftRebuttals(env, { nowMs, fetchImpl });
  const okStores = Object.values(stores).filter((s) => typeof s === "object");
  if (okStores.length) {
    const openTotal = okStores.reduce((s, x) => s + x.needsResponse, 0);
    // One "checked" line at most every 6 hours unless something changed: no hourly noise.
    const e = { actor: ACTOR, kind: "risk.disputes_checked", target: "sys.shopify",
      summary: `Disputes checked in ${okStores.length} store${okStores.length === 1 ? "" : "s"}: ${openTotal} need${openTotal === 1 ? "s" : ""} a response`,
      data: { stores } };
    if (changes) await logEvent(db, { ...e, at });
    else await logOnce(db, e, { windowMin: 6 * 60, nowMs });
  }
  return { stores, drafts };
}
