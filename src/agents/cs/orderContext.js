/**
 * cs.order_context — Order Context (code). SHADOW: reads the ledger (and, when the ledger has no
 * match, Shopify read-only); writes only to cs_tickets / size_complaints / cs_kfb_asks.
 *
 * What it does:
 *   1. Matches each classified ticket to its order: the order number written in the email first,
 *      then the customer's email address against the orders the ledger holds. If the ledger has
 *      nothing and the store is known, one read-only Shopify lookup (capped per run).
 *      An order is attached ONLY when the sender's email is on it. A number that belongs to a
 *      different email is never attached (order_mismatch = 1) and the ticket goes to Reilly.
 *      A where-is-my-order ticket whose ledger data is over 2 hours old gets a fresh read-only
 *      Shopify read, or is marked "status not current" so the reply can't state it as fact.
 *   2. Attaches what the reply writer may quote: payment/fulfillment status, items and sizes,
 *      express, Shopify's own fulfillment tracking numbers (17TRACK carrier status only if parcel tracking is on; it is OFF since 2026-10-13),
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
import { safeJson, clip, logOnce, likeEscape } from "./util.js";
import { normSize } from "../supplier/common.js";

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

/**
 * Find the ledger order for a ticket. An order is only ever attached when the SENDER'S email is
 * on it (privacy: an order number in an email is a claim, not proof; "Apt #1001" or a typo must
 * never show one customer another customer's order).
 * Returns { order, how } | { order: null, mismatch: true, note } | { order: null, unverified: true, note } | { order: null, note }.
 */
export async function findLedgerOrder(db, t) {
  const stores = t.store ? [t.store] : [...LIVE_STORE_IDS];
  const marks = stores.map(() => "?").join(",");
  if (t.order_ref) {
    const { results } = await db.prepare(`SELECT * FROM orders WHERE name IN (?, ?) AND store IN (${marks})`).bind(`#${t.order_ref}`, t.order_ref, ...stores).all();
    const rows = results || [];
    const verified = rows.filter((o) => orderEmails(o.raw).includes(t.from_email));
    if (verified.length === 1) return { order: verified[0], how: "order number + email" };
    if (verified.length > 1) return { order: null, note: `#${t.order_ref} under this email exists in ${verified.map((o) => storeName(o.store)).join(" and ")}; couldn't tell which` };
    if (rows.length) {
      // The ledger's copy of some orders (GraphQL backfill) carries no email: Shopify must confirm.
      if (rows.some((o) => orderEmails(o.raw).length === 0)) return { order: null, unverified: true, note: `#${t.order_ref} found, but its email isn't in the ledger copy` };
      return { order: null, mismatch: true, note: `order #${t.order_ref} belongs to a different email` };
    }
  }
  if (t.from_email) {
    const since = new Date(Date.parse(t.received_at || t.opened_at) - EMAIL_LOOKBACK_DAYS * 86400000).toISOString();
    // LIKE narrows it cheaply (escaped: "_" in an address is a wildcard otherwise); the parsed
    // JSON check below decides, so a substring can never match.
    const { results } = await db.prepare(
      `SELECT * FROM orders WHERE store IN (${marks}) AND created_at >= ? AND lower(raw) LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 10`
    ).bind(...stores, since, `%${likeEscape(t.from_email)}%`).all();
    const rows = (results || []).filter((o) => orderEmails(o.raw).includes(t.from_email));
    if (rows.length) {
      return { order: rows[0], how: rows.length > 1 ? `email (latest of ${rows.length} orders)` : "email" };
    }
  }
  return { order: null, note: t.order_ref ? `#${t.order_ref} not in the ledger` : "no order number and no order under this email" };
}

/** Express from the shipping line; null when the shipping method isn't known (never "false"). */
function expressFrom(title, code, storedFlag = null) {
  if (title == null && code == null) return storedFlag === 1 ? true : null;
  return /express/i.test(String(title || "")) || /express/i.test(String(code || ""));
}

export const CARRIER_MAX_AGE_MS = 24 * 3600000;

/** Everything the reply writer may quote about an order, from the ledger. */
export async function ledgerContext(db, order) {
  const { results: lines } = await db.prepare(`SELECT product_id, title, variant_title, size, color, quantity FROM order_lines WHERE store = ? AND order_id = ?`).bind(order.store, order.order_id).all();
  const { results: ships } = await db.prepare(
    `SELECT tracking_number, tracking_url, carrier_hint, shipped_at, shopify_status, shopify_delivered_at, state, last_status, last_event_at, last_event_text, last_event_location, polled_at FROM shipments WHERE store = ? AND order_id = ?`
  ).bind(order.store, order.order_id).all();
  const { results: refunds } = await db.prepare(`SELECT amount, status, processed_at FROM refunds WHERE store = ? AND order_id = ?`).bind(order.store, order.order_id).all();
  const st = rawStatus(order.raw);
  // The CARRIER's own status (17TRACK) when the brain has read it. Shopify's status lags behind
  // the carrier (live 2026-10-15: a draft said "not delivered yet" for a parcel the carrier had
  // delivered four days earlier), so only the carrier's word says delivered or not.
  // Only a carrier reading from the last day counts (parcel tracking has been off since
  // 2026-10-13, so older stored states are stale and say nothing about today).
  const nowMs = Date.now();
  const fresh = (s) => s.polled_at && nowMs - Date.parse(s.polled_at) < CARRIER_MAX_AGE_MS;
  const shipments = (ships || []).map((s) => {
    const known = fresh(s) && s.state && s.state !== "unknown";
    return {
      tracking_number: s.tracking_number, tracking_url: s.tracking_url, carrier: s.carrier_hint, shipped_at: s.shipped_at,
      shopify_status: s.shopify_status, delivered_at: s.shopify_delivered_at,
      carrier_state: known ? s.state : null,
      carrier_delivered: known ? s.state === "delivered" : null,
      carrier_last_event: known && s.last_event_text ? { at: s.last_event_at, text: s.last_event_text, location: s.last_event_location } : null,
    };
  });
  return {
    source: "ledger", as_of: order.updated_at,
    store: order.store, order_id: order.order_id, name: order.name, created_at: order.created_at,
    financial_status: order.financial_status, total: order.total, currency: order.currency,
    express: expressFrom(order.shipping_title, order.shipping_code, order.express), shipping_method: order.shipping_title || null,
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

/**
 * Read-only Shopify lookup (Store Guard client; no mutation). By order number or by email.
 * An order is returned only when Shopify's email for it is the sender's.
 * Returns { ctx } | { mismatch: true } | { unverified: true } | null (no such order).
 */
export async function shopifyLookup(env, t, { fetchImpl, nowMs, name = null }) {
  const num = name ? String(name).replace(/^#/, "") : t.order_ref;
  const q = num ? `name:#${num}` : `email:"${String(t.from_email).replace(/"/g, "")}"`;
  const data = await shopifyGraphQL(env, t.order_store || t.store, LOOKUP_QUERY, { q }, { fetchImpl, nowMs });
  const nodes = (data && data.orders && data.orders.nodes) || [];
  const n = num ? nodes.find((x) => x.name === `#${num}` || x.name === num) : nodes.find((x) => String(x.email || "").toLowerCase() === t.from_email);
  if (!n) return null;
  const email = String(n.email || "").trim().toLowerCase();
  if (!email) return { unverified: true };
  if (email !== t.from_email) return { mismatch: true };
  const shipments = [];
  for (const f of n.fulfillments || []) for (const ti of f.trackingInfo || []) {
    shipments.push({ tracking_number: ti.number, tracking_url: ti.url, carrier: ti.company, shipped_at: f.createdAt, shopify_status: f.displayStatus, delivered_at: f.deliveredAt });
  }
  const sl = n.shippingLine || null;
  return { ctx: {
    source: "shopify_live", as_of: nowIso(nowMs),
    store: t.order_store || t.store, order_id: n.id, name: n.name, created_at: n.createdAt,
    financial_status: n.displayFinancialStatus, total: n.currentTotalPriceSet ? Number(n.currentTotalPriceSet.shopMoney.amount) : null,
    currency: n.currentTotalPriceSet ? n.currentTotalPriceSet.shopMoney.currencyCode : null,
    express: sl ? expressFrom(sl.title, sl.code) : null, shipping_method: sl ? sl.title : null,
    fulfillment_status: n.displayFulfillmentStatus, cancelled_at: n.cancelledAt,
    shipped: shipments.length > 0 || (/FULFILLED/i.test(String(n.displayFulfillmentStatus || "")) && !/UNFULFILLED/i.test(String(n.displayFulfillmentStatus || ""))),
    items: ((n.lineItems && n.lineItems.nodes) || []).map((l) => ({ product_id: l.product ? l.product.id : null, title: l.title, variant: l.variantTitle, size: sizeFromVariant(l.variantTitle), color: null, qty: l.quantity })),
    shipments, refunds: null, // refunds are read from the ledger's refund events only (rule 7)
  } };
}

/** The letter size in a variant title like "M / Navy" (first part that is a size), or null. */
export function sizeFromVariant(v) {
  for (const part of String(v || "").split("/")) { const s = normSize(part); if (s) return s; }
  return null;
}

/** Order data older than this is re-read from Shopify before a where-is-my-order reply. */
export const STATUS_MAX_AGE_MS = 2 * 3600000;

export async function attachOrderContext(env, { nowMs = Date.now(), fetchImpl = fetch, budget }) {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT * FROM cs_tickets WHERE status IN ('open') AND context_at IS NULL ORDER BY id LIMIT ?`
  ).bind(CAPS.contextPerTick).all();
  let matched = 0, unmatched = 0, lookups = 0;
  const canLookup = () => lookups < CAPS.shopifyLookupsPerTick && budget.take(2) && ++lookups;
  for (const t of results || []) {
    const at = nowIso(nowMs);
    let ctx = null, note = null, how = null, mismatch = false;
    const found = await findLedgerOrder(db, t);
    if (found.order) { ctx = await ledgerContext(db, found.order); how = found.how; }
    else { note = found.note; mismatch = !!found.mismatch; }

    // Ledger has nothing (or can't confirm the email): one read-only Shopify lookup.
    if (!ctx && !mismatch && t.store && (t.order_ref || t.from_email) && canLookup()) {
      try {
        const r = await shopifyLookup(env, t, { fetchImpl, nowMs });
        if (r && r.ctx) { ctx = r.ctx; how = `${t.order_ref ? "order number + email" : "email"} (live Shopify read)`; }
        else if (r && r.mismatch) { mismatch = true; note = `order #${t.order_ref} belongs to a different email`; }
        else if (r && r.unverified) note = `${note}; Shopify has no email on #${t.order_ref}, so it can't be confirmed as this customer's`;
        else note = `${note}; Shopify has no match either`;
      } catch (err) {
        note = `${note}; Shopify lookup not possible (${clip(err.message, 80)})`;
        await logOnce(db, { actor: ACTOR, kind: "error.cs_shopify_lookup", store: t.store, target: "sys.shopify", summary: `Order lookup in Shopify failed for ${storeName(t.store)}: ${clip(err.message, 160)}` }, { key: t.store, nowMs });
      }
    }

    // Freshness before numbers (rule 4): a where-is-my-order reply needs current status.
    if (ctx && ctx.source === "ledger" && t.category === "where_is_order") {
      const age = nowMs - Date.parse(ctx.as_of || 0);
      if (!(age <= STATUS_MAX_AGE_MS)) {
        let fresh = null;
        if (canLookup()) {
          try {
            const r = await shopifyLookup(env, { ...t, order_store: ctx.store }, { fetchImpl, nowMs, name: ctx.name });
            if (r && r.ctx) fresh = r.ctx;
          } catch { /* fall through to "status unknown" */ }
        }
        if (fresh) {
          // Keep what only the ledger knows (sizes, refund events).
          fresh.items = ctx.items.length ? ctx.items : fresh.items;
          fresh.refunds = ctx.refunds;
          ctx = fresh;
          how = `${how}; status re-read from Shopify`;
        } else {
          ctx.status_stale = true;
          ctx.age_hours = Number.isFinite(age) ? Math.round(age / 360000) / 10 : null;
        }
      }
    }

    if (ctx) {
      ctx.matched_by = how;
      matched++;
      await db.prepare(`UPDATE cs_tickets SET order_store = ?, order_id = ?, order_name = ?, context = ?, context_at = ?, context_note = NULL, order_mismatch = 0, store = COALESCE(store, ?), updated_at = ? WHERE id = ?`)
        .bind(ctx.store, ctx.order_id, ctx.name, JSON.stringify(ctx), at, ctx.store, at, t.id).run();
      await logEvent(db, { actor: ACTOR, kind: "cs.order_matched", store: ctx.store, at, summary: `Ticket ${t.id} → ${storeName(ctx.store)} ${ctx.name} by ${how}: ${ctx.status_stale ? "status not current" : ctx.shipped ? "shipped" : ctx.shipped === false ? "not shipped yet" : "shipping unknown"}${ctx.express ? ", express" : ""}`, data: { ticket: t.id } });
    } else {
      unmatched++;
      await db.prepare(`UPDATE cs_tickets SET context_at = ?, context_note = ?, order_mismatch = ?, updated_at = ? WHERE id = ?`).bind(at, clip(note, 300), mismatch ? 1 : 0, at, t.id).run();
      await logEvent(db, { actor: ACTOR, kind: mismatch ? "cs.order_mismatch" : "cs.order_unmatched", store: t.store, at, summary: `Ticket ${t.id}: ${mismatch ? "the order number written belongs to a different email; nothing attached, Reilly checks" : `no order found (${clip(note, 160)})`}`, data: { ticket: t.id } });
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

  // An order number that isn't this sender's never reaches KFB (nor anything downstream).
  for (const a of t.order_mismatch ? [] : kfbAsksFor(t, triage, line)) {
    const ins = await db.prepare(`INSERT OR IGNORE INTO cs_kfb_asks (created_at, store, ticket_id, order_id, order_name, kind, detail, shipped) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(at, store, t.id, ctx ? ctx.order_id : null, ctx ? ctx.name : null, a.kind, a.detail, ctx && ctx.shipped != null ? (ctx.shipped ? 1 : 0) : null).run();
    if (ins.meta && ins.meta.changes === 1) {
      await logEvent(db, { actor: ACTOR, kind: "cs.kfb_ask", store, target: "sup.relay", at,
        summary: `KFB ask noted (${a.kind}) for ${ctx ? ctx.name : "an unmatched order"}: ${a.detail}${ctx && ctx.shipped ? " (already shipped)" : ""}`, data: { ticket: t.id } });
    }
  }
  await db.prepare(`UPDATE cs_tickets SET feeds_at = ? WHERE id = ?`).bind(at, t.id).run();
}
