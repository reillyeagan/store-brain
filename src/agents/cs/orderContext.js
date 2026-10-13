/**
 * cs.order_context — Order Context (code). SHADOW: reads the ledger (and, when the ledger has no
 * match, Shopify read-only); writes only to cs_tickets / size_complaints / cs_kfb_asks.
 *
 * What it does:
 *   1. Matches each classified ticket to its order: the order number written in the email first,
 *      then the customer's email address against the orders the ledger holds. If the ledger has
 *      nothing and the store is known, one read-only Shopify lookup (capped per tick).
 *   2. Attaches what the reply writer may quote: payment/fulfillment status, items and sizes,
 *      express, Shopify's own fulfillment tracking numbers (no 17TRACK: parcel tracking is OFF),
 *      refunds as recorded events.
 *   3. Feeds Supplier: sizing complaints → size_complaints (Size Checker complaint log);
 *      size / colour / address changes, exchanges, cancellations → cs_kfb_asks (Relay adds
 *      them to the KFB copy-paste message later; CS never writes that message).
 * Inputs: cs_tickets, orders, order_lines, shipments, refunds. Outputs: ticket context, feed rows, events.
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { shopifyGraphQL } from "../../lib/storeGuard.js";
import { LIVE_STORE_IDS } from "../../config/stores.js";
import { CAPS, storeName } from "./config.js";
import { safeJson, clip, logOnce } from "./util.js";

const ACTOR = "cs.order_context";
const EMAIL_LOOKBACK_DAYS = 120;

/** All the email addresses a stored order carries (webhook JSON or GraphQL node). */
export function orderEmails(raw) {
  const r = typeof raw === "string" ? safeJson(raw, {}) : raw || {};
  return [r.email, r.contact_email, r.customer && r.customer.email, r.customer && r.customer.defaultEmailAddress && r.customer.defaultEmailAddress.emailAddress]
    .filter(Boolean).map((e) => String(e).trim().toLowerCase());
}

function rawStatus(raw) {
  const r = safeJson(raw, {}) || {};
  return {
    fulfillment_status: r.fulfillment_status || r.displayFulfillmentStatus || null,
    cancelled_at: r.cancelled_at || r.cancelledAt || null,
  };
}

/** Find the ledger order for a ticket. Returns { order, note }. */
export async function findLedgerOrder(db, t) {
  const stores = t.store ? [t.store] : [...LIVE_STORE_IDS];
  const marks = stores.map(() => "?").join(",");
  if (t.order_ref) {
    const { results } = await db.prepare(`SELECT * FROM orders WHERE name IN (?, ?) AND store IN (${marks})`).bind(`#${t.order_ref}`, t.order_ref, ...stores).all();
    const rows = results || [];
    if (rows.length === 1) return { order: rows[0], how: "order number" };
    if (rows.length > 1) {
      // Same number in two stores: the customer's email decides.
      const byEmail = rows.filter((o) => orderEmails(o.raw).includes(t.from_email));
      if (byEmail.length === 1) return { order: byEmail[0], how: "order number + email" };
      return { order: null, note: `#${t.order_ref} exists in ${rows.map((o) => storeName(o.store)).join(" and ")}; couldn't tell which` };
    }
  }
  if (t.from_email) {
    const since = new Date(Date.parse(t.received_at || t.opened_at) - EMAIL_LOOKBACK_DAYS * 86400000).toISOString();
    // LIKE narrows it cheaply; the parsed JSON check below decides (no false matches on a substring).
    const { results } = await db.prepare(
      `SELECT * FROM orders WHERE store IN (${marks}) AND created_at >= ? AND lower(raw) LIKE ? ORDER BY created_at DESC LIMIT 10`
    ).bind(...stores, since, `%${t.from_email.replace(/[%_]/g, "")}%`).all();
    const rows = (results || []).filter((o) => orderEmails(o.raw).includes(t.from_email));
    if (rows.length) {
      return { order: rows[0], how: rows.length > 1 ? `email (latest of ${rows.length} orders)` : "email" };
    }
  }
  return { order: null, note: t.order_ref ? `#${t.order_ref} not in the ledger` : "no order number and no order under this email" };
}

/** Everything the reply writer may quote about an order, from the ledger. */
export async function ledgerContext(db, order) {
  const { results: lines } = await db.prepare(`SELECT product_id, title, variant_title, size, color, quantity FROM order_lines WHERE store = ? AND order_id = ?`).bind(order.store, order.order_id).all();
  const { results: ships } = await db.prepare(
    `SELECT tracking_number, tracking_url, carrier_hint, shipped_at, shopify_status, shopify_delivered_at FROM shipments WHERE store = ? AND order_id = ?`
  ).bind(order.store, order.order_id).all();
  const { results: refunds } = await db.prepare(`SELECT amount, status, processed_at FROM refunds WHERE store = ? AND order_id = ?`).bind(order.store, order.order_id).all();
  const st = rawStatus(order.raw);
  const shipments = (ships || []).map((s) => ({ tracking_number: s.tracking_number, tracking_url: s.tracking_url, carrier: s.carrier_hint, shipped_at: s.shipped_at, shopify_status: s.shopify_status, delivered_at: s.shopify_delivered_at }));
  return {
    source: "ledger", as_of: order.updated_at,
    store: order.store, order_id: order.order_id, name: order.name, created_at: order.created_at,
    financial_status: order.financial_status, total: order.total, currency: order.currency,
    express: order.express === 1, shipping_method: order.shipping_title || null,
    fulfillment_status: st.fulfillment_status, cancelled_at: st.cancelled_at,
    shipped: shipments.length > 0 || /^(fulfilled|partial|partially_fulfilled)$/i.test(String(st.fulfillment_status || "")) ? true : (st.fulfillment_status ? false : null),
    items: (lines || []).map((l) => ({ product_id: l.product_id, title: l.title, variant: l.variant_title, size: l.size, color: l.color, qty: l.quantity })),
    shipments,
    refunds: (refunds || []).map((r) => ({ amount: r.amount, status: r.status, processed_at: r.processed_at })),
  };
}

const LOOKUP_QUERY = `query CsOrderLookup($q: String!) {
  orders(first: 3, query: $q, sortKey: CREATED_AT, reverse: true) {
    nodes { id name createdAt displayFinancialStatus displayFulfillmentStatus cancelledAt email
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      shippingLine { title code }
      lineItems(first: 10) { nodes { title variantTitle quantity product { id } } }
      fulfillments(first: 5) { createdAt displayStatus deliveredAt trackingInfo(first: 3) { number url company } }
    }
  }
}`;

/** Read-only Shopify lookup when the ledger has no match (Store Guard client; no mutation). */
async function shopifyLookup(env, t, { fetchImpl, nowMs }) {
  const q = t.order_ref ? `name:#${t.order_ref}` : `email:${t.from_email}`;
  const data = await shopifyGraphQL(env, t.store, LOOKUP_QUERY, { q }, { fetchImpl, nowMs });
  const nodes = (data && data.orders && data.orders.nodes) || [];
  const n = t.order_ref ? nodes.find((x) => x.name === `#${t.order_ref}` || x.name === t.order_ref) : nodes.find((x) => String(x.email || "").toLowerCase() === t.from_email);
  if (!n) return null;
  const shipments = [];
  for (const f of n.fulfillments || []) for (const ti of f.trackingInfo || []) {
    shipments.push({ tracking_number: ti.number, tracking_url: ti.url, carrier: ti.company, shipped_at: f.createdAt, shopify_status: f.displayStatus, delivered_at: f.deliveredAt });
  }
  const express = /express/i.test(String((n.shippingLine && n.shippingLine.title) || "")) || /express/i.test(String((n.shippingLine && n.shippingLine.code) || ""));
  return {
    source: "shopify_live", as_of: nowIso(nowMs),
    store: t.store, order_id: n.id, name: n.name, created_at: n.createdAt,
    financial_status: n.displayFinancialStatus, total: n.currentTotalPriceSet ? Number(n.currentTotalPriceSet.shopMoney.amount) : null,
    currency: n.currentTotalPriceSet ? n.currentTotalPriceSet.shopMoney.currencyCode : null,
    express, shipping_method: n.shippingLine ? n.shippingLine.title : null,
    fulfillment_status: n.displayFulfillmentStatus, cancelled_at: n.cancelledAt,
    shipped: shipments.length > 0 || /FULFILLED/i.test(String(n.displayFulfillmentStatus || "")) && !/UNFULFILLED/i.test(String(n.displayFulfillmentStatus || "")),
    items: ((n.lineItems && n.lineItems.nodes) || []).map((l) => ({ product_id: l.product ? l.product.id : null, title: l.title, variant: l.variantTitle, size: null, color: null, qty: l.quantity })),
    shipments, refunds: null, // refunds are read from the ledger's refund events only (rule 7)
  };
}

export async function attachOrderContext(env, { nowMs = Date.now(), fetchImpl = fetch, budget }) {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT * FROM cs_tickets WHERE status IN ('open') AND context_at IS NULL ORDER BY id LIMIT ?`
  ).bind(CAPS.contextPerTick).all();
  let matched = 0, unmatched = 0, lookups = 0;
  for (const t of results || []) {
    const at = nowIso(nowMs);
    let ctx = null, note = null, how = null;
    const found = await findLedgerOrder(db, t);
    if (found.order) { ctx = await ledgerContext(db, found.order); how = found.how; }
    else note = found.note;
    // Ledger has nothing: one read-only Shopify lookup (the webhook may simply not have arrived).
    if (!ctx && t.store && (t.order_ref || t.from_email) && lookups < CAPS.shopifyLookupsPerTick && budget.take(2)) {
      lookups++;
      try {
        ctx = await shopifyLookup(env, t, { fetchImpl, nowMs });
        if (ctx) how = `${t.order_ref ? "order number" : "email"} (live Shopify read)`;
        else note = `${note}; Shopify has no match either`;
      } catch (err) {
        note = `${note}; Shopify lookup not possible (${clip(err.message, 80)})`;
        await logOnce(db, { actor: ACTOR, kind: "error.cs_shopify_lookup", store: t.store, target: "sys.shopify", summary: `Order lookup in Shopify failed for ${storeName(t.store)}: ${clip(err.message, 160)}` }, { key: t.store, nowMs });
      }
    }
    if (ctx) {
      ctx.matched_by = how;
      matched++;
      await db.prepare(`UPDATE cs_tickets SET order_store = ?, order_id = ?, order_name = ?, context = ?, context_at = ?, context_note = NULL, store = COALESCE(store, ?), updated_at = ? WHERE id = ?`)
        .bind(ctx.store, ctx.order_id, ctx.name, JSON.stringify(ctx), at, ctx.store, at, t.id).run();
      await logEvent(db, { actor: ACTOR, kind: "cs.order_matched", store: ctx.store, at, summary: `Ticket ${t.id} → ${storeName(ctx.store)} ${ctx.name} by ${how}: ${ctx.shipped ? "shipped" : ctx.shipped === false ? "not shipped yet" : "shipping unknown"}${ctx.express ? ", express" : ""}`, data: { ticket: t.id } });
    } else {
      unmatched++;
      await db.prepare(`UPDATE cs_tickets SET context_at = ?, context_note = ?, updated_at = ? WHERE id = ?`).bind(at, clip(note, 300), at, t.id).run();
      await logEvent(db, { actor: ACTOR, kind: "cs.order_unmatched", store: t.store, at, summary: `Ticket ${t.id}: no order found (${clip(note, 160)})`, data: { ticket: t.id } });
    }
    const fresh = await db.prepare(`SELECT * FROM cs_tickets WHERE id = ?`).bind(t.id).first();
    await recordSupplierFeeds(db, fresh, at);
  }
  return { matched, unmatched, shopifyLookups: lookups };
}

/* ---------- feeds for the Supplier department ---------- */

/** Which order line a complaint is about: the only sized line, or the one the email names. */
export function pickLine(items, triage) {
  const sized = (items || []).filter((i) => i.size || i.variant);
  if (sized.length === 1) return sized[0];
  const p = String((triage && triage.size && triage.size.product) || "").toLowerCase();
  if (p) {
    const hits = sized.filter((i) => String(i.title || "").toLowerCase().includes(p) || p.includes(String(i.title || "").toLowerCase()));
    if (hits.length === 1) return hits[0];
  }
  const ordered = triage && triage.size && triage.size.ordered;
  if (ordered) {
    const hits = sized.filter((i) => String(i.size || "").toLowerCase() === String(ordered).toLowerCase());
    if (hits.length === 1) return hits[0];
  }
  return null;
}

/** KFB asks a ticket implies (kind + one plain line). Address text is never copied here. */
export function kfbAsksFor(t, triage, line) {
  const asks = [];
  const ordered = (triage.size && triage.size.ordered) || (line && line.size) || null;
  const item = line ? clip(line.title, 50) : null;
  const sizeTo = triage.change.size_to || triage.size.wanted;
  switch (t.category) {
    case "address_change": asks.push({ kind: "address", detail: `New shipping address requested (see ticket ${t.id}; change it in Shopify first)` }); break;
    case "colour_change": asks.push({ kind: "colour", detail: `${item ? `${item}: ` : ""}colour → ${triage.change.colour_to || "see email"}` }); break;
    case "exchange": asks.push({ kind: "exchange", detail: `${item ? `${item}: ` : ""}${ordered || "?"} → ${sizeTo || "see email"}` }); break;
    case "cancel": asks.push({ kind: "cancel", detail: "Customer asked to cancel" }); break;
    case "size_question":
    case "size_complaint":
      if (triage.change.size_to) asks.push({ kind: "size", detail: `${item ? `${item}: ` : ""}${ordered || "?"} → ${triage.change.size_to}` });
      break;
    default: break;
  }
  if (triage.change.address && t.category !== "address_change") asks.push({ kind: "address", detail: `New shipping address requested (see ticket ${t.id}; change it in Shopify first)` });
  return asks;
}

export async function recordSupplierFeeds(db, t, at) {
  if (!t || t.feeds_at) return;
  const triage = safeJson(t.triage, null);
  if (!triage) return;
  const ctx = safeJson(t.context, null);
  const line = ctx ? pickLine(ctx.items, triage) : null;
  const store = t.order_store || t.store;
  const source = `gmail:${t.gmail_id}`;

  // Size Checker complaint log (supplier spec: "keep track of email info from customers who
  // have complained about sizing for certain products").
  const complaint = t.category === "size_complaint" || (triage.size.fit && ["exchange", "return_refund"].includes(t.category));
  if (complaint && store) {
    const dup = await db.prepare(`SELECT id FROM size_complaints WHERE source = ?`).bind(source).first();
    if (!dup) {
      await db.prepare(`INSERT INTO size_complaints (store, order_id, product_id, size_ordered, size_that_fits, said, source, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(store, ctx ? ctx.order_id : null, line ? line.product_id : null, triage.size.ordered || (line && line.size) || null,
          triage.size.wanted || triage.change.size_to || null, triage.size.quote || clip(t.body, 500), source, at).run();
      await logEvent(db, { actor: ACTOR, kind: "cs.size_complaint", store, target: "sup.size_charts", at,
        summary: `Sizing complaint logged: ${line ? clip(line.title, 60) : "product not identified"}${triage.size.ordered ? `, ordered ${triage.size.ordered}` : ""}${triage.size.fit ? ` (${triage.size.fit.replace("_", " ")})` : ""}`, data: { ticket: t.id } });
    }
  }

  for (const a of kfbAsksFor(t, triage, line)) {
    const ins = await db.prepare(`INSERT OR IGNORE INTO cs_kfb_asks (created_at, store, ticket_id, order_id, order_name, kind, detail, shipped) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(at, store, t.id, ctx ? ctx.order_id : null, ctx ? ctx.name : null, a.kind, a.detail, ctx && ctx.shipped != null ? (ctx.shipped ? 1 : 0) : null).run();
    if (ins.meta && ins.meta.changes === 1) {
      await logEvent(db, { actor: ACTOR, kind: "cs.kfb_ask", store, target: "sup.relay", at,
        summary: `KFB ask noted (${a.kind}) for ${ctx ? ctx.name : "an unmatched order"}: ${a.detail}${ctx && ctx.shipped ? " (already shipped)" : ""}`, data: { ticket: t.id } });
    }
  }
  await db.prepare(`UPDATE cs_tickets SET feeds_at = ? WHERE id = ?`).bind(at, t.id).run();
}
