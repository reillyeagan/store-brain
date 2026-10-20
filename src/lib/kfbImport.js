/**
 * KFB Morning Session (svc.kfb_session): the server side of the one-click KFB import.
 *
 * Reilly logs in to KungFuBuy each morning (he types the CAPTCHA; the brain never does), clicks
 * the bookmarklet, and the dashboard posts what it read to POST /api/import/kfb (key required).
 * This module checks every part of that payload and files it in the tables the agents
 * already read:
 *   quotations → kfb_quotes (+ kfb_similar_offers for "only similar ones" remarks)
 *                Quote Desk, Denial Sync, "Similar ones" QC
 *   orders     → kfb_orders                       Order-to-Supplier Watcher
 *   bills      → kfb_bills + kfb_bill_lines       COGS Matcher, Claims & Credits
 *                supplier_bills                   the bills line in the digest / brief
 * then marks the `kfb.morning_sweep` feed fresh, keeps the raw payload in R2 for audit and
 * logs one event with the counts.
 *
 * Rules kept here:
 *   - Nothing is ever sent to KFB. The bookmarklet only GETs; this side only reads the payload.
 *   - A row is tied to a store ONLY by its KFB shop code (un_shop_url), never by order number
 *     (numbers repeat across stores). A row from a shop code that is not in
 *     src/config/stores.js is refused and counted, never guessed.
 *   - un_* fields come from the Shopify store (un_good_price is the store price, un_total_price
 *     the order total): none of them is ever read as a KFB cost.
 *   - KFB times without a zone are China time (UTC+8, vault 09-20); shopify_create_at is UTC.
 *   - Idempotent: unchanged rows are not rewritten. The same rows twice on one Eastern day is
 *     refused as a duplicate before anything is written (UNIQUE payload_hash + day).
 *   - A bill's card amount (usd_charged), FX source and the COGS Matcher's signature are never
 *     touched: the import only knows EUR.
 *   - Unknown is not zero: a bill whose paid state can't be read is stored as 'unknown', not
 *     'unpaid' or 'paid'; a quote without a readable cost has no cost.
 */
import { STORES, STORE_IDS } from "../config/stores.js";
import {
  KFB_ORIGINS, KFB_IMPORT_MAX_BYTES, KFB_IMPORT_MAX_ROWS, KFB_IMPORT_MAX_AGE_H, KFB_FEED,
  KFB_REMINDER_AFTER_MIN, KFB_BILLS_PAGE, KFB_RAW_RETENTION_DAYS,
} from "../config/kfb.js";
import { validateQuoteRow } from "../agents/supplier/quotes.js";
import { handleFrom } from "../agents/supplier/common.js";
import { markFeedOk, markFeedFailed, ensureFeeds } from "./freshness.js";
import { logEvent } from "./eventlog.js";
import { nowIso, localDay } from "./time.js";
import { sendPhone } from "./phone.js";
import { modeFor } from "../config/live.js";
import { kfbImportStatus } from "./kfbReads.js";

const ACTOR = "svc.kfb_session";
const SECTIONS = Object.freeze(["quotes", "orders", "bills"]);
const BATCH = 50;   // statements per D1 batch
const IN_CHUNK = 80; // ids per IN (...) read (D1 allows 100 bound parameters)

/* ------------------------------------------------------------------ small pure helpers */

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const blank = (v) => v == null || (typeof v === "string" && v.trim() === "");
/** First non-blank value among `keys` (only the keys listed; never an un_* field unless listed). */
export function pick(o, keys) {
  if (!isObj(o)) return null;
  for (const k of keys) if (!blank(o[k])) return o[k];
  return null;
}
const num = (v) => {
  if (blank(v)) return null;
  const n = Number(String(v).replace(/[€$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const firstObj = (a) => (Array.isArray(a) ? a.find(isObj) || null : isObj(a) ? a : null);

/** "https://jmzjx1-it.myshopify.com/" → "jmzjx1-it". Lower case, no scheme, no myshopify suffix. */
export function normShopCode(v) {
  if (blank(v)) return null;
  const s = String(v).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.myshopify\.com$/, "");
  return s || null;
}

/** A row's KFB shop code: the row's own un_shop_url, else its first item's. */
export function shopCodeOf(raw) {
  const keys = ["un_shop_url", "shop_url", "shop_code", "un_shop", "shop_domain"];
  const own = pick(raw, keys);
  if (own) return normShopCode(own);
  const item = isObj(raw) ? firstObj(raw.items) : null;
  return item ? normShopCode(pick(item, keys)) : null;
}

/** The store a KFB shop code belongs to, or null (never a guess). */
export function storeForShopCode(code) {
  const c = normShopCode(code);
  if (!c) return null;
  return STORE_IDS.map((id) => STORES[id]).find((s) => s.kfbShopCode && s.kfbShopCode === c) || null;
}

/**
 * A KFB time as UTC ISO. Zone-less "YYYY-MM-DD HH:MM:SS" is read at `offset` (China time by
 * default); a stamp with Z or an offset is taken as written; 10/13-digit numbers are epochs.
 */
export function kfbTime(v, offset = "+08:00") {
  if (blank(v)) return null;
  const s = String(v).trim();
  let ms = NaN;
  if (/^\d{10}$/.test(s)) ms = Number(s) * 1000;
  else if (/^\d{13}$/.test(s)) ms = Number(s);
  else {
    // "2026-10-13 09:15:00", "2026/10/13 09:15", "2026-10-13T09:15:00Z", "2026-10-13 09:15:00+08:00".
    // A zone written in the stamp wins; only a zone-less stamp is read at `offset`.
    const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
    if (m) {
      const p2 = (x) => String(x || "0").padStart(2, "0");
      let zone = m[8] ? m[8].toUpperCase() : offset;
      if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
      ms = Date.parse(`${m[1]}-${p2(m[2])}-${p2(m[3])}T${p2(m[4])}:${p2(m[5])}:${p2(m[6])}${m[7] || ""}${zone}`);
    }
  }
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * KFB's order_no → the Shopify order number it stands for. Vault 10-08: bill details join
 * orders by order_no "stripping a trailing -N/_N for split suborders" (…-1119-1 is a suborder
 * of 1119). The Shopify number must be 3 to 6 digits: a long KFB-only number is NOT read as a
 * Shopify order (it would make every order look missing).
 * @returns {{ref:string, sub:string|null, parent:string|null}|null}
 */
export function parseOrderNo(no) {
  if (blank(no)) return null;
  const s = String(no).trim();
  const parts = s.split(/[-_]/).filter(Boolean);
  let sub = null;
  if (parts.length >= 2 && /^\d{1,2}$/.test(parts[parts.length - 1]) && /\d{3,6}$/.test(parts[parts.length - 2])) sub = parts.pop();
  const m = /(?:^|\D)(\d{3,6})$/.exec(parts[parts.length - 1] || "");
  if (!m) return null;
  return { ref: m[1], sub, parent: sub ? s.slice(0, s.length - sub.length - 1) : null };
}

/** The Shopify order number of a KFB order / bill row (a named field first, then order_no). */
export function orderRefFrom(raw) {
  const named = pick(raw, ["un_order_name", "un_order_number", "shopify_order_name", "shopify_order_no", "order_name"]);
  if (named) { const p = parseOrderNo(String(named).replace(/^#/, "")); if (p) return p; }
  return parseOrderNo(pick(raw, ["order_no", "order_sn"]));
}

/**
 * Quoted cost (EUR, one piece) = product[0].manual_pricing.<Country>.nameOne (vault 09-01).
 * The US entry if there is one; otherwise only when every country gives the same price.
 */
export function quoteCost(raw) {
  const prod = firstObj(raw && raw.product);
  let mp = prod ? prod.manual_pricing : null;
  if (typeof mp === "string") { try { mp = JSON.parse(mp); } catch { mp = null; } }
  if (!isObj(mp)) return { value: null, why: "no manual_pricing" };
  const entries = Object.entries(mp).filter(([, v]) => isObj(v) && num(v.nameOne) > 0);
  if (!entries.length) return { value: null, why: "no one-piece price" };
  const us = entries.find(([k]) => /united\s*states|^us$|^usa$|america/i.test(k));
  if (us) return { value: num(us[1].nameOne), country: us[0] };
  const vals = new Set(entries.map(([, v]) => num(v.nameOne)));
  if (vals.size === 1) return { value: [...vals][0], country: entries[0][0] };
  return { value: null, why: `${entries.length} countries with different prices, none of them the US` };
}

/**
 * The time a quotation row is filed under. Status-change / quote time first (so a row whose
 * status changes becomes a new kfb_quotes row), creation time last. GUESS: the vault names
 * none of these fields; relates_information_time is only known as a filter parameter.
 */
export const QUOTE_TIME_KEYS = Object.freeze(["quote_time", "quotation_time", "quoted_time", "relates_information_time",
  "update_time", "updated_at", "update_at", "create_time", "create_at", "created_at"]);
/** Creation times: they never move, so a re-quote at the same status would hide behind them. */
const CREATE_TIME_KEYS = new Set(["create_time", "create_at", "created_at"]);

/* ------------------------------------------------------------------ payload check */

/**
 * Check the envelope the bookmarklet builds (also what a pasted JSON must look like):
 * { kind:"kfb-import", version:1, origin, fetched_at, sections:{ quotes|orders|bills:
 *   { ok:boolean, endpoint?:string, rows:[{...}], error?:string } } }
 * @returns {{ok:true, value:object}|{ok:false, errors:string[]}}
 */
export function validatePayload(p, nowMs = Date.now()) {
  const errors = [];
  if (!isObj(p)) return { ok: false, errors: ["payload must be a JSON object"] };
  if (p.kind !== "kfb-import") errors.push('kind must be "kfb-import"');
  if (p.version !== 1) errors.push("version must be 1");
  if (!KFB_ORIGINS.includes(p.origin)) errors.push(`origin "${String(p.origin).slice(0, 80)}" is not a KFB origin (${KFB_ORIGINS.join(", ")})`);
  const fetched = typeof p.fetched_at === "string" ? Date.parse(p.fetched_at) : NaN;
  if (!Number.isFinite(fetched)) errors.push("fetched_at must be an ISO time");
  else if (fetched > nowMs + 10 * 60000) errors.push("fetched_at is in the future");
  else if (fetched < nowMs - KFB_IMPORT_MAX_AGE_H * 3600000) errors.push(`fetched_at is older than ${KFB_IMPORT_MAX_AGE_H} h: read KFB again`);
  if (!isObj(p.sections)) errors.push("sections must be an object");
  else {
    const keys = Object.keys(p.sections);
    const extra = keys.filter((k) => !SECTIONS.includes(k));
    if (extra.length) errors.push(`unknown section(s): ${extra.join(", ")}`);
    if (!keys.some((k) => SECTIONS.includes(k))) errors.push("no quotes, orders or bills section");
    for (const k of keys.filter((x) => SECTIONS.includes(x))) {
      const s = p.sections[k];
      if (!isObj(s) || typeof s.ok !== "boolean") { errors.push(`${k}: must be {ok, rows}`); continue; }
      if (s.truncated != null && typeof s.truncated !== "boolean") errors.push(`${k}: truncated must be true or false`);
      if (s.total != null && !(Number.isInteger(s.total) && s.total >= 0)) errors.push(`${k}: total must be a whole number`);
      if (s.ok) {
        if (!Array.isArray(s.rows)) errors.push(`${k}: rows must be an array`);
        else if (s.rows.length > KFB_IMPORT_MAX_ROWS) errors.push(`${k}: ${s.rows.length} rows is more than ${KFB_IMPORT_MAX_ROWS}`);
        else if (s.rows.some((r) => !isObj(r))) errors.push(`${k}: every row must be an object`);
      } else if (s.rows != null && !Array.isArray(s.rows)) errors.push(`${k}: rows must be an array`);
    }
    if (!errors.length && !SECTIONS.some((k) => p.sections[k] && p.sections[k].ok)) errors.push("no section was read (every one failed)");
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: p };
}

/* ------------------------------------------------------------------ row normalisers */

const shopCheck = (code, { allowNotLive = false } = {}) => {
  if (!code) return { reason: "no KFB shop code (un_shop_url)" };
  const s = storeForShopCode(code);
  if (!s) return { reason: `unknown KFB shop "${code}"`, unknownShop: code };
  if (!s.live && !allowNotLive) return { reason: `${s.name} is not live`, notLive: true, store: s.id };
  return { store: s.id };
};

/** One quotation row → an import row for kfb_quotes (validated by the Quote Desk's own check). */
export function normalizeQuoteRow(raw) {
  const code = shopCodeOf(raw);
  const sc = shopCheck(code);
  if (!sc.store || sc.notLive) return { code, ...sc };
  const item = firstObj(raw.items) || {};
  const link = pick(item, ["un_good_url", "store_link", "good_url"]) ?? pick(raw, ["un_good_url", "store_link", "goods_url", "link"]);
  const status = pick(raw, ["status", "quotation_status", "quote_status"]);
  const cost = quoteCost(raw);
  const timeKey = QUOTE_TIME_KEYS.find((k) => !blank(raw[k])) || null;
  const row = {
    store: sc.store,
    link,
    status: status == null ? "" : String(status),
    cost: cost.value,
    currency: "EUR",
    quoted_at: kfbTime(pick(raw, QUOTE_TIME_KEYS)),
    remark: pick(raw, ["order_remark", "remark", "reason"]),
    sku: pick(item, ["un_good_sku", "goods_sku", "sku"]) ?? pick(raw, ["goods_sku", "sku"]),
    kfb_id: pick(raw, ["order_no", "quotation_no", "quotation_id", "sn", "id"]),
  };
  const v = validateQuoteRow(row);
  if (v.reason) return { code, store: sc.store, reason: v.reason };
  return { code, store: sc.store, row, clean: v, timeFromCreation: CREATE_TIME_KEYS.has(timeKey), factory: factoryOf(raw) };
}

/** The 1688 offer behind a factory link, or null (only detail.1688.com/offer/<n>.html counts). */
export function offerFrom(url) {
  const m = String(url || "").match(/^https?:\/\/(?:detail\.1688\.com|m\.1688\.com)\/offer\/(\d{6,20})\.html/i);
  return m ? { offer_id: m[1], offer_url: `https://detail.1688.com/offer/${m[1]}.html` } : null;
}

/**
 * What KFB says it buys for this quote: the factory listing and the factory's name for each
 * store variant (product[].order_items, Reilly 2026-10-20: "every quoted product in KFB has a
 * supplier link"). Pure. Only 1688 offer links are kept.
 */
export function factoryOf(raw) {
  const entries = (Array.isArray(raw && raw.product) ? raw.product : []).filter(isObj);
  const variants = [];
  let offer = null;
  for (const e of entries) {
    const oi = isObj(e.order_items) ? e.order_items : null;
    const o = oi ? offerFrom(oi.goods_url) : null;
    if (o && !offer) offer = o;
    const vid = e.un_variant_id != null && /^\d{1,20}$/.test(String(e.un_variant_id)) ? String(e.un_variant_id) : null;
    if (vid) variants.push({ variant_id: vid, product_id: /^\d{1,20}$/.test(String(e.un_good_id || "")) ? `gid://shopify/Product/${e.un_good_id}` : null,
      shop_spec: e.un_good_spec ? String(e.un_good_spec).slice(0, 120) : null,
      factory_spec: oi && oi.goods_spec ? String(oi.goods_spec).slice(0, 120) : null,
      factory_sku: oi && oi.goods_sku ? String(oi.goods_sku).slice(0, 80) : null, offer_id: o ? o.offer_id : null });
  }
  const productId = (variants.find((v) => v.product_id) || {}).product_id || null;
  return offer || variants.length ? { ...(offer || {}), product_id: productId, variants } : null;
}

/** Store the factory links and factory variant names from this import's quotes. */
async function writeSupplierLinks(db, quotes, at) {
  const out = { links: 0, variants: 0 };
  const stmts = [];
  for (const q of quotes) {
    const f = q.factory, v = q.clean;
    if (!f || !v || !v.handle) continue;
    if (f.offer_id) {
      out.links++;
      stmts.push(db.prepare(
        `INSERT INTO supplier_links (store, product_handle, product_id, offer_id, offer_url, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(store, product_handle, offer_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, product_id = COALESCE(excluded.product_id, supplier_links.product_id)`
      ).bind(v.store, v.handle, f.product_id, f.offer_id, f.offer_url, at, at));
    }
    for (const x of f.variants) {
      out.variants++;
      stmts.push(db.prepare(
        `INSERT INTO factory_variants (store, variant_id, product_handle, shop_spec, factory_spec, factory_sku, offer_id, seen_at) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(store, variant_id) DO UPDATE SET product_handle = excluded.product_handle, shop_spec = excluded.shop_spec,
           factory_spec = COALESCE(excluded.factory_spec, factory_variants.factory_spec), factory_sku = COALESCE(excluded.factory_sku, factory_variants.factory_sku),
           offer_id = COALESCE(excluded.offer_id, factory_variants.offer_id), seen_at = excluded.seen_at`
      ).bind(v.store, x.variant_id, v.handle, x.shop_spec, x.factory_spec, x.factory_sku, x.offer_id, at));
    }
  }
  if (stmts.length) await runBatched(db, stmts);
  return out;
}

/** One order row → a kfb_orders row. */
export function normalizeOrderRow(raw) {
  const code = shopCodeOf(raw);
  const sc = shopCheck(code);
  if (!sc.store || sc.notLive) return { code, ...sc };
  const no = pick(raw, ["order_no", "order_sn"]);
  const id = pick(raw, ["id", "order_id", "kfb_order_id"]);
  if (blank(no) && blank(id)) return { code, store: sc.store, reason: "no KFB order number" };
  const ref = orderRefFrom(raw);
  if (!ref) return { code, store: sc.store, reason: "no Shopify order number in the row" };
  const created = kfbTime(pick(raw, ["shopify_create_at"]), "Z") ?? kfbTime(pick(raw, ["un_create_at", "create_at", "create_time", "order_time"]));
  const status = pick(raw, ["status", "order_status", "state"]);
  return {
    code, store: sc.store,
    row: { kfb_order_id: `${code}:${String(no ?? id).trim()}`, kfb_shop_code: code, order_ref: ref.ref, kfb_created_at: created, status: status == null ? null : String(status) },
  };
}

const LINE_ARRAY_KEYS = ["details", "detail", "bill_details", "lines", "list", "items", "children", "sub_orders", "suborders", "order_list", "orders"];
const BILL_ID_KEYS = ["bill_no", "bill_sn", "bill_id", "bill_order_no", "bill_number", "bill_order_id", "bill_code"];
const BILL_TIME_KEYS = ["bill_time", "billed_at", "bill_date", "create_time", "create_at", "created_at"];
// Paid state. A bill HEADER may use the plain names; a flat bill-detail row is one order line,
// and its own pay_time / pay_status is most likely the CUSTOMER's Shopify payment, so on a flat
// row only fields that name the bill count (review of 7ce2827, finding 1).
const PAY_FLAG_KEYS = ["pay_status", "is_pay", "is_paid", "paid", "payment_status"];
const PAY_TIME_KEYS = ["pay_time", "paid_at", "pay_at", "payment_time"];
const BILL_PAY_FLAG_KEYS = ["bill_pay_status", "bill_is_pay", "bill_is_paid", "bill_paid", "bill_payment_status"];
const BILL_PAY_TIME_KEYS = ["bill_pay_time", "bill_paid_at", "bill_payment_time"];
// A header's bill total. No pay_amount: on an unpaid bill it is the amount paid so far (0).
const BILL_TOTAL_KEYS = ["bill_amount", "bill_price", "bill_total", "total_amount", "total_money", "total_price", "total", "amount", "money"];
// A line's cost (GUESS: the vault does not name KFB's cost field, so every line records which
// field it came from in cost_basis). A line total wins and is never multiplied; a named unit
// price is multiplied by the quantity. No bare "price". un_total_price is the SHOPIFY order
// total and is never read.
const LINE_TOTAL_KEYS = ["goods_total", "goods_amount", "total_goods_price", "product_total", "goods_money", "purchase_amount"];
const LINE_UNIT_KEYS = ["goods_price", "purchase_price", "product_price", "unit_price", "cost"];
const LINE_ANY_TOTAL_KEYS = ["total_price", "amount", "money", "total", "subtotal"];
const FEE_KEYS = ["service_fee", "service_price", "service_charge", "handling_fee", "commission", "fee"];
const SHIP_KEYS = ["freight", "freight_price", "shipping_fee", "shipping_price", "shipping", "logistics_fee", "logistics_price", "postage", "express_fee"];
const QTY_KEYS = ["quantity", "num", "goods_num", "qty", "number"];

/** A pay flag's meaning: true paid · false unpaid · null can't tell. */
function flagValue(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "paid", "yes", "已支付", "已付款"].includes(s)) return true;
  if (["0", "false", "unpaid", "no", "未支付", "未付款", "wait", "pending"].includes(s)) return false;
  return null;
}

/**
 * A bill's paid state from the fields allowed for that kind of row. An explicit flag beats a
 * timestamp; a timestamp alone counts only when there is no flag. Unclear → null (unknown),
 * never "paid".
 */
export function billPaidState(o, { header }) {
  const flags = header ? [...BILL_PAY_FLAG_KEYS, ...PAY_FLAG_KEYS] : BILL_PAY_FLAG_KEYS;
  const times = header ? [...BILL_PAY_TIME_KEYS, ...PAY_TIME_KEYS] : BILL_PAY_TIME_KEYS;
  const rawFlag = pick(o, flags);
  const at = kfbTime(pick(o, times));
  if (rawFlag != null) {
    const f = flagValue(rawFlag);
    return { paid: f, paidAt: f === true ? at : null };
  }
  return at ? { paid: true, paidAt: at } : { paid: null, paidAt: null };
}

function billLine(raw, header) {
  const code = shopCodeOf(raw) || shopCodeOf(header);
  const sc = shopCheck(code, { allowNotLive: true }); // a bill Reilly pays may cover a store that isn't live yet
  if (!sc.store) return { code, ...sc };
  const no = pick(raw, ["order_no", "order_sn", "kfb_order_no"]);
  const ref = orderRefFrom(raw);
  const qty = num(pick(raw, QTY_KEYS));
  let cost = num(pick(raw, LINE_TOTAL_KEYS)), basis = cost != null ? "line_total" : null;
  if (cost == null) {
    const unit = num(pick(raw, LINE_UNIT_KEYS));
    if (unit != null) { cost = qty != null && qty > 1 ? unit * qty : unit; basis = qty != null && qty > 1 ? "unit_x_qty" : "unit"; }
  }
  const fees = num(pick(raw, FEE_KEYS));
  const ship = num(pick(raw, SHIP_KEYS));
  if (cost == null && fees == null && ship == null) { cost = num(pick(raw, LINE_ANY_TOTAL_KEYS)); basis = cost != null ? "any_total" : null; }
  if (cost == null && fees == null && ship == null) return { code, store: sc.store, reason: "no cost on the bill line" };
  return {
    code, store: sc.store, basis: basis || "fees_only",
    line: {
      kfb_shop_code: code, order_ref: ref ? ref.ref : null, kfb_order_id: no == null ? null : String(no).trim(),
      parent_kfb_order_id: ref && ref.parent ? ref.parent : null,
      sku: pick(raw, ["sku", "goods_sku", "un_good_sku"]), quantity: qty == null ? null : Math.round(qty),
      cost_eur: r2(cost), fees_eur: r2(fees), shipping_eur: r2(ship),
    },
    billId: pick(raw, BILL_ID_KEYS), billedAt: kfbTime(pick(raw, BILL_TIME_KEYS)),
  };
}

/** A line's identity for merging (line_no is only a position, so it is not part of it). */
export const lineKey = (l) => [l.kfb_order_id || "", l.order_ref || "", l.sku || "", l.cost_eur ?? "", l.fees_eur ?? "", l.shipping_eur ?? ""].join("|");

/**
 * Bill rows → bills with their lines. A row is either a bill with nested lines (details,
 * list, children, ...) or one bill line itself (KFB's "bill details"); flat lines are grouped
 * by bill id. A bill with no id is filed under its shop + bill day, which is stable.
 * `truncated`: the read stopped before KFB's last row, so the bill of the LAST row read may
 * continue on the next page: it is marked incomplete.
 */
export function normalizeBills(rows, { truncated = false } = {}) {
  const bills = new Map();
  const rejected = [];
  let lastId = null;
  for (const raw of rows || []) {
    const nestedKey = LINE_ARRAY_KEYS.find((k) => Array.isArray(raw[k]) && raw[k].some(isObj));
    const lines = nestedKey ? raw[nestedKey].filter(isObj) : [raw];
    const headerId = nestedKey ? pick(raw, [...BILL_ID_KEYS, "id"]) : null;
    for (const l of lines) {
      const n = billLine(l, raw);
      if (!n.line) { rejected.push({ code: n.code, reason: n.reason, unknownShop: n.unknownShop }); continue; }
      const billedAt = kfbTime(pick(raw, BILL_TIME_KEYS)) || n.billedAt;
      let id = headerId ?? n.billId;
      if (blank(id)) {
        if (!billedAt) { rejected.push({ code: n.code, reason: "no bill id and no bill date" }); continue; }
        id = `kfb-day:${n.code}:${String(pick(raw, BILL_TIME_KEYS) || pick(l, BILL_TIME_KEYS)).slice(0, 10)}`;
      }
      id = String(id).trim();
      lastId = id;
      if (!bills.has(id)) {
        const headerTotal = nestedKey ? r2(num(pick(raw, BILL_TOTAL_KEYS))) : null;
        bills.set(id, {
          bill_id: id, billed_at: billedAt, codes: new Set(), lines: [], states: [], bases: new Set(), nested: !!nestedKey,
          // Only a header's own positive total is the bill total; otherwise the lines are summed.
          total_eur: headerTotal != null && headerTotal > 0 ? headerTotal : null,
        });
        if (nestedKey) bills.get(id).states.push(billPaidState(raw, { header: true }));
      }
      const b = bills.get(id);
      b.codes.add(n.code);
      b.lines.push(n.line);
      b.bases.add(n.basis);
      if (!nestedKey) b.states.push(billPaidState(l, { header: false }));
      if (!b.billed_at && billedAt) b.billed_at = billedAt;
    }
  }
  const out = [];
  for (const b of bills.values()) {
    // Stable line numbers, so the same bill always gets the same line_no for the same line.
    b.lines.sort((a, c) => (lineKey(a) < lineKey(c) ? -1 : lineKey(a) > lineKey(c) ? 1 : 0));
    b.lines.forEach((l, i) => { l.line_no = i + 1; });
    // Every row that states a paid state must agree; none stated, or a disagreement → unknown.
    const stated = b.states.filter((s) => s.paid != null);
    const vals = new Set(stated.map((s) => s.paid));
    const paid = vals.size === 1 ? [...vals][0] : null;
    const paidAt = paid === true ? (stated.map((s) => s.paidAt).filter(Boolean).sort()[0] || null) : null;
    const codes = [...b.codes];
    const linesEur = r2(b.lines.reduce((s, l) => s + (l.cost_eur || 0) + (l.fees_eur || 0) + (l.shipping_eur || 0), 0));
    out.push({
      bill_id: b.bill_id, kfb_shop_code: codes.length === 1 ? codes[0] : null, billed_at: b.billed_at,
      total_eur: b.total_eur, paid_at: paidAt, paid, lines: b.lines, codes, amount_eur: b.total_eur ?? linesEur,
      cost_basis: [...b.bases].sort().join(","), incomplete: !!(truncated && b.bill_id === lastId),
    });
  }
  return { bills: out, rejected };
}

/* ------------------------------------------------------------------ import */

/** Stable JSON (sorted keys), so the same rows always hash the same. */
export function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v === undefined ? null : v);
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function runBatched(db, stmts) {
  const res = [];
  for (let i = 0; i < stmts.length; i += BATCH) res.push(...(await db.batch(stmts.slice(i, i + BATCH))));
  return res;
}

async function readIn(db, sql, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const part = ids.slice(i, i + IN_CHUNK);
    const { results } = await db.prepare(sql.replace("(?)", `(${part.map(() => "?").join(", ")})`)).bind(...part).all();
    out.push(...(results || []));
  }
  return out;
}

const tally = (list) => {
  const m = {};
  for (const r of list) m[r.reason] = (m[r.reason] || 0) + 1;
  return m;
};

/** Sort out every section's rows. Pure. */
export function normalizePayload(p) {
  const out = { quotes: [], orders: [], bills: [], refused: { quotes: [], orders: [], bills: [] }, skippedNotLive: { quotes: 0, orders: 0 }, shops: {} };
  const seenShop = (section, code) => { const k = `${code}|${section}`; out.shops[k] = (out.shops[k] || 0) + 1; };
  const s = p.sections;
  if (s.quotes && s.quotes.ok) {
    for (const raw of s.quotes.rows) {
      const n = normalizeQuoteRow(raw);
      if (n.notLive) { out.skippedNotLive.quotes++; continue; }
      if (!n.row) { out.refused.quotes.push(n); continue; }
      out.quotes.push(n); seenShop("quotes", n.code);
    }
  }
  if (s.orders && s.orders.ok) {
    const ids = new Set();
    for (const raw of s.orders.rows) {
      const n = normalizeOrderRow(raw);
      if (n.notLive) { out.skippedNotLive.orders++; continue; }
      if (!n.row) { out.refused.orders.push(n); continue; }
      if (ids.has(n.row.kfb_order_id)) continue; // the same order twice in one read: first wins
      ids.add(n.row.kfb_order_id);
      out.orders.push(n); seenShop("orders", n.code);
    }
  }
  if (s.bills && s.bills.ok) {
    const nb = normalizeBills(s.bills.rows, { truncated: s.bills.truncated === true });
    out.bills = nb.bills;
    out.refused.bills = nb.rejected;
    for (const b of nb.bills) for (const l of b.lines) seenShop("bills", l.kfb_shop_code);
  }
  return out;
}

/** How many rows an import refused (from its stored counts). */
export function refusedTotal(c) {
  if (!c) return 0;
  const sum = (m) => Object.values(m || {}).reduce((s, x) => s + (Number(x) || 0), 0);
  return sum(c.quotes && c.quotes.refused) + sum(c.orders && c.orders.refused) + sum(c.bills && c.bills.refused_lines) + ((c.unknown_shops || []).length);
}

/**
 * Sections this payload read that an EARLIER-stored import read more recently. Importing it
 * would put older KFB data over newer (a stale pasted file, a tab left open overnight).
 */
async function newerReadsThan(db, payload, fetchedAt) {
  const { results } = await db.prepare(`SELECT sections FROM kfb_imports WHERE fetched_at > ?`).bind(fetchedAt).all();
  const mine = SECTIONS.filter((k) => payload.sections[k] && payload.sections[k].ok);
  const hit = new Set();
  for (const r of results || []) {
    let s = {}; try { s = JSON.parse(r.sections) || {}; } catch { s = {}; }
    for (const k of mine) if (s[k] && s[k].ok) hit.add(k);
  }
  return [...hit];
}

/** Raw payloads hold order data: keep KFB_RAW_RETENTION_DAYS of them, delete the rest. */
async function pruneRaw(env, nowMs) {
  if (!env.BACKUPS || typeof env.BACKUPS.delete !== "function") return 0;
  const cutoff = nowIso(nowMs - KFB_RAW_RETENTION_DAYS * 86400000);
  const { results } = await env.DB.prepare(`SELECT id, r2_key FROM kfb_imports WHERE r2_key IS NOT NULL AND imported_at < ? ORDER BY id LIMIT 50`).bind(cutoff).all();
  for (const r of results || []) {
    await env.BACKUPS.delete(r.r2_key);
    await env.DB.prepare(`UPDATE kfb_imports SET r2_key = NULL WHERE id = ?`).bind(r.id).run();
  }
  return (results || []).length;
}

/**
 * Import one payload. Returns {ok, status?, duplicate?, counts, errors?}.
 * Nothing is written unless the whole payload passes the envelope check, it is not older than
 * a read already imported, and the audit copy is safely in R2.
 */
export async function importKfb(env, payload, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const v = validatePayload(payload, nowMs);
  if (!v.ok) return { ok: false, status: 400, errors: v.errors };
  const at = nowIso(nowMs);
  const day = localDay(nowMs, "America/New_York");
  const fetchedAt = nowIso(Math.min(Date.parse(payload.fetched_at), nowMs));
  const newer = await newerReadsThan(db, payload, fetchedAt);
  if (newer.length) {
    return { ok: false, status: 409, errors: [`KFB ${newer.join(", ")} were already imported from a later read: this older read would roll newer data back. Read KFB again.`] };
  }
  const n = normalizePayload(payload);

  const sectionInfo = {};
  for (const k of SECTIONS) {
    const s = payload.sections[k];
    if (s) {
      sectionInfo[k] = {
        ok: !!s.ok, rows: Array.isArray(s.rows) ? s.rows.length : 0, total: s.total ?? null, truncated: s.ok ? s.truncated === true : null,
        endpoint: s.endpoint ? String(s.endpoint).slice(0, 120) : null, error: s.ok ? null : String(s.error || "not read").slice(0, 300),
      };
    }
  }
  // The hash covers what was read, not when: the same KFB rows twice are the same import.
  const hash = await sha256Hex(stableJson({ origin: payload.origin, sections: payload.sections }));
  const dup = await db.prepare(`SELECT id, counts FROM kfb_imports WHERE payload_hash = ? AND local_day = ?`).bind(hash, day).first();
  let reuseId = null;
  if (dup) {
    let counts = null; try { counts = JSON.parse(dup.counts); } catch { counts = null; }
    // Nothing was refused last time: the same rows again can change nothing.
    if (!refusedTotal(counts)) return { ok: true, duplicate: true, importId: dup.id, message: "Already imported today: nothing changed.", counts };
    reuseId = dup.id; // some rows were refused: try them again (a shop code may have been added since)
  }

  // Audit copy first: if it can't be stored, nothing is imported.
  if (!env.BACKUPS) return { ok: false, status: 503, errors: ["The R2 audit store (BACKUPS) is not bound: nothing imported."] };
  const r2Key = `kfb-imports/${day}/${hash}.json`;
  const body = JSON.stringify({ received_at: at, payload });
  await env.BACKUPS.put(r2Key, body, { httpMetadata: { contentType: "application/json" } });
  const head = await env.BACKUPS.head(r2Key);
  if (!head || head.size !== new TextEncoder().encode(body).length) {
    return { ok: false, status: 503, errors: [`The audit copy ${r2Key} could not be confirmed in R2: nothing imported.`] };
  }
  const pruned = await pruneRaw(env, nowMs);

  const billsTruncated = !!(sectionInfo.bills && sectionInfo.bills.truncated);
  const counts = {
    quotes: await writeQuotes(db, n.quotes, at, fetchedAt),
    supplier_links: await writeSupplierLinks(db, n.quotes, at),
    orders: await writeOrders(db, n.orders, at),
    bills: await writeBills(db, n.bills, at, { truncated: billsTruncated }),
  };
  counts.quotes.refused = tally(n.refused.quotes);
  counts.quotes.skipped_not_live = n.skippedNotLive.quotes;
  counts.orders.refused = tally(n.refused.orders);
  counts.orders.skipped_not_live = n.skippedNotLive.orders;
  counts.bills.refused_lines = tally(n.refused.bills);
  const unknownShops = [...new Set([...n.refused.quotes, ...n.refused.orders, ...n.refused.bills].map((r) => r.unknownShop).filter(Boolean))];
  counts.unknown_shops = unknownShops;
  counts.by_store = byStore(n);
  counts.raw_files_pruned = pruned;

  let importId = reuseId;
  if (reuseId) {
    await db.prepare(`UPDATE kfb_imports SET fetched_at = ?, imported_at = ?, sections = ?, counts = ?, r2_key = ? WHERE id = ?`)
      .bind(fetchedAt, at, JSON.stringify(sectionInfo), JSON.stringify(counts), r2Key, reuseId).run();
    await db.prepare(`DELETE FROM kfb_import_shops WHERE import_id = ?`).bind(reuseId).run();
  } else {
    const ins = await db.prepare(
      `INSERT OR IGNORE INTO kfb_imports (payload_hash, local_day, fetched_at, imported_at, origin, sections, counts, r2_key) VALUES (?,?,?,?,?,?,?,?)`
    ).bind(hash, day, fetchedAt, at, payload.origin, JSON.stringify(sectionInfo), JSON.stringify(counts), r2Key).run();
    importId = ins.meta && ins.meta.changes ? ins.meta.last_row_id : null;
  }
  if (importId) {
    const shopStmts = Object.entries(n.shops).map(([k, rows]) => {
      const [code, section] = k.split("|");
      return db.prepare(`INSERT OR REPLACE INTO kfb_import_shops (import_id, kfb_shop_code, section, rows) VALUES (?,?,?,?)`).bind(importId, code, section, rows);
    });
    if (shopStmts.length) await runBatched(db, shopStmts);
  }

  // The sweep feed means "KFB orders were read": the Order Watcher trusts absences from it.
  // Fresh only when the orders section was read; otherwise it is recorded as failing, with why.
  const ord = sectionInfo.orders;
  if (ord && ord.ok) await markFeedOk(db, KFB_FEED, fetchedAt);
  else {
    await ensureFeeds(db); // the row may not exist yet before the first sentinel run
    await markFeedFailed(db, KFB_FEED, `KFB import ${at.slice(0, 16)}: orders not read (${ord ? ord.error : "not sent"})`, at);
  }

  const failed = Object.entries(sectionInfo).filter(([, s]) => !s.ok).map(([k]) => k);
  const cut = Object.entries(sectionInfo).filter(([, s]) => s.truncated).map(([k]) => k);
  const refusedN = n.refused.quotes.length + n.refused.orders.length + n.refused.bills.length;
  await logEvent(db, {
    actor: ACTOR, kind: "kfb.imported", target: "sys.kfb", at,
    summary: `KFB morning import: quotes ${counts.quotes.inserted} new / ${counts.quotes.unchanged} known · ` +
      `orders ${counts.orders.inserted} new, ${counts.orders.updated} changed · bills ${counts.bills.inserted} new, ${counts.bills.updated} changed (${counts.bills.lines} lines)` +
      (refusedN ? ` · ${refusedN} row${refusedN === 1 ? "" : "s"} refused` : "") +
      (unknownShops.length ? ` (unknown shop ${unknownShops.join(", ")})` : "") +
      (cut.length ? ` · read cut off before the end: ${cut.join(", ")}` : "") +
      (failed.length ? ` · NOT read: ${failed.join(", ")}` : ""),
    data: { importId, fetched_at: fetchedAt, sections: sectionInfo, counts, r2Key },
  });
  return { ok: true, importId, counts, sections: sectionInfo, r2Key };
}

function byStore(n) {
  const out = {};
  const add = (store, k) => { if (!store) return; out[store] = out[store] || { quotes: 0, orders: 0, bill_lines: 0 }; out[store][k]++; };
  for (const q of n.quotes) add(q.store, "quotes");
  for (const o of n.orders) add(o.store, "orders");
  for (const b of n.bills) for (const l of b.lines) add((storeForShopCode(l.kfb_shop_code) || {}).id, "bill_lines");
  return out;
}

/**
 * kfb_quotes: insert-or-ignore on the Quote Desk's own UNIQUE key; similar remarks recorded too.
 * A row filed under its CREATION time (no quote/update time in the row) can't show a re-quote at
 * the same status: when its cost differs from the latest stored one, it is filed under the time
 * KFB was read instead, so the new cost lands (and the same cost again is a no-op).
 */
async function writeQuotes(db, quotes, at, observedAt) {
  const out = { inserted: 0, unchanged: 0, requoted: 0, similar_recorded: 0 };
  if (!quotes.length) return out;
  const qkey = (store, handle, variant, status) => `${store}|${handle}|${variant || ""}|${status}`;
  let latest = null;
  if (quotes.some((q) => q.timeFromCreation)) {
    latest = new Map();
    const { results } = await db.prepare(`SELECT store, product_handle, variant_id, status, cost, quoted_at FROM kfb_quotes ORDER BY quoted_at, id`).all();
    for (const r of results || []) latest.set(qkey(r.store, r.product_handle, r.variant_id, r.status), r);
  }
  const rows = [];
  for (const q of quotes) {
    const v = q.clean;
    let quotedAt = v.quotedAt;
    if (q.timeFromCreation) {
      const prev = latest.get(qkey(v.store, v.handle, v.variantId, v.status));
      if (prev) {
        if (same(prev.cost, v.cost)) { out.unchanged++; continue; }
        quotedAt = observedAt;
        out.requoted++;
      }
    }
    rows.push({ q, v, quotedAt });
  }
  const res = await runBatched(db, rows.map(({ q, v, quotedAt }) => db.prepare(
    `INSERT OR IGNORE INTO kfb_quotes (store, product_handle, variant_id, sku, kfb_quote_id, status_code, status, cost, currency,
       quoted_at, remark, similar, source, imported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(v.store, v.handle, v.variantId, q.row.sku == null ? null : String(q.row.sku), q.row.kfb_id == null ? null : String(q.row.kfb_id), v.code, v.status,
    v.cost, v.currency, quotedAt, q.row.remark == null ? null : String(q.row.remark).slice(0, 500), v.similar ? 1 : 0, "kfb_session", at)));
  for (const r of res) { if (r.meta && r.meta.changes) out.inserted++; else out.unchanged++; }
  // "Only similar ones" quotes: one offer each for the Similar QC (keyed by the quote's own time).
  const sim = rows.filter(({ v }) => v.similar);
  if (sim.length) {
    const sres = await runBatched(db, sim.map(({ q, v, quotedAt }) => db.prepare(
      `INSERT OR IGNORE INTO kfb_similar_offers (store, context, product_handle, order_name, remark, photo_url, cost, currency, received_at, source)
       VALUES (?, 'quote', ?, '', ?, NULL, ?, ?, ?, 'kfb_session')`
    ).bind(v.store, handleFrom(q.row.link) || "", q.row.remark == null ? null : String(q.row.remark).slice(0, 500), v.cost, v.currency, quotedAt)));
    out.similar_recorded = sres.filter((r) => r.meta && r.meta.changes).length;
  }
  return out;
}

/** kfb_orders: new rows inserted, changed rows updated, the rest left alone (imported_at = first seen). */
async function writeOrders(db, orders, at) {
  const out = { inserted: 0, updated: 0, unchanged: 0 };
  if (!orders.length) return out;
  const existing = new Map((await readIn(db, `SELECT * FROM kfb_orders WHERE kfb_order_id IN (?)`, orders.map((o) => o.row.kfb_order_id))).map((r) => [r.kfb_order_id, r]));
  const stmts = [];
  for (const { row } of orders) {
    const old = existing.get(row.kfb_order_id);
    if (!old) {
      stmts.push(db.prepare(`INSERT OR IGNORE INTO kfb_orders (kfb_order_id, kfb_shop_code, order_ref, kfb_created_at, status, imported_at) VALUES (?,?,?,?,?,?)`)
        .bind(row.kfb_order_id, row.kfb_shop_code, row.order_ref, row.kfb_created_at, row.status, at));
      out.inserted++;
      continue;
    }
    const created = row.kfb_created_at ?? old.kfb_created_at;
    if (old.kfb_shop_code === row.kfb_shop_code && old.order_ref === row.order_ref && (old.kfb_created_at ?? null) === (created ?? null) && (old.status ?? null) === (row.status ?? null)) { out.unchanged++; continue; }
    stmts.push(db.prepare(`UPDATE kfb_orders SET kfb_shop_code = ?, order_ref = ?, kfb_created_at = ?, status = ? WHERE kfb_order_id = ?`)
      .bind(row.kfb_shop_code, row.order_ref, created, row.status, row.kfb_order_id));
    out.updated++;
  }
  if (stmts.length) await runBatched(db, stmts);
  return out;
}

const lineSig = (lines) => lines.map((l) => [l.line_no, l.kfb_shop_code ?? "", l.order_ref ?? "", l.kfb_order_id ?? "", l.parent_kfb_order_id ?? "", l.sku ?? "",
  l.quantity ?? "", l.cost_eur ?? "", l.fees_eur ?? "", l.shipping_eur ?? ""].join(":")).join("|");
const lineEurOf = (l) => (Number(l.cost_eur) || 0) + (Number(l.fees_eur) || 0) + (Number(l.shipping_eur) || 0);

/** Equal as stored: null with null, numbers to the cent, everything else as text. */
function same(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "number" || typeof b === "number") return Math.abs(Number(a) - Number(b)) < 0.005;
  return String(a) === String(b);
}

/**
 * kfb_bills + kfb_bill_lines (what the COGS Matcher reads), kfb_bill_flags, and supplier_bills
 * (bills to pay). Only changed bills are rewritten.
 *   Complete read: a bill's lines are replaced as a set when any line differs.
 *   Truncated read (the bookmark stopped before KFB's last row): lines are only ADDED, never
 *   deleted, and the bill at the cut is flagged incomplete (the COGS Matcher waits on it, and
 *   it is not listed to pay from a partial line sum).
 * usd_charged / fx_source / matched_sig are never written here.
 */
async function writeBills(db, bills, at, { truncated = false } = {}) {
  const out = { inserted: 0, updated: 0, unchanged: 0, lines: 0, lines_added: 0, incomplete: 0,
    to_pay: { inserted: 0, updated: 0, unchanged: 0, no_amount: 0, incomplete: 0, paid_state_unknown: 0 } };
  if (!bills.length) return out;
  const ids = bills.map((b) => b.bill_id);
  const oldBills = new Map((await readIn(db, `SELECT * FROM kfb_bills WHERE bill_id IN (?)`, ids)).map((r) => [r.bill_id, r]));
  const oldLines = new Map();
  for (const l of await readIn(db, `SELECT * FROM kfb_bill_lines WHERE bill_id IN (?)`, ids)) {
    if (!oldLines.has(l.bill_id)) oldLines.set(l.bill_id, []);
    oldLines.get(l.bill_id).push(l);
  }
  const oldPay = new Map((await readIn(db, `SELECT * FROM supplier_bills WHERE bill_id IN (?)`, ids)).map((r) => [r.bill_id, r]));
  const oldFlags = new Map((await readIn(db, `SELECT * FROM kfb_bill_flags WHERE bill_id IN (?)`, ids)).map((r) => [r.bill_id, r]));
  const stmts = [];
  for (const b of bills) {
    out.lines += b.lines.length;
    if (b.incomplete) out.incomplete++;
    const old = oldBills.get(b.bill_id);
    const prevLines = (oldLines.get(b.bill_id) || []).sort((x, y) => x.line_no - y.line_no);
    let storedLines = b.lines;
    let linesChanged;
    if (truncated) {
      // Additive only: a partial read never removes a line KFB showed before.
      const have = new Set(prevLines.map(lineKey));
      let next = prevLines.reduce((m, l) => Math.max(m, Number(l.line_no) || 0), 0);
      const add = b.lines.filter((l) => !have.has(lineKey(l))).map((l) => ({ ...l, line_no: ++next }));
      linesChanged = add.length > 0;
      for (const l of add) stmts.push(insertLine(db, b.bill_id, l));
      out.lines_added += add.length;
      storedLines = [...prevLines, ...add];
    } else {
      linesChanged = lineSig(prevLines) !== lineSig(b.lines);
      if (linesChanged) {
        stmts.push(db.prepare(`DELETE FROM kfb_bill_lines WHERE bill_id = ?`).bind(b.bill_id));
        for (const l of b.lines) stmts.push(insertLine(db, b.bill_id, l));
        out.lines_added += b.lines.length;
      }
    }
    const billedAt = b.billed_at ?? (old ? old.billed_at : null);
    // Paid state as read now (null = unknown). A paid date is kept only while the bill reads as paid.
    const paidAt = b.paid === true ? (b.paid_at ?? (old ? old.paid_at : null)) : null;
    const codes = [...new Set(storedLines.map((l) => l.kfb_shop_code).filter(Boolean))];
    const shop = codes.length === 1 ? codes[0] : null;
    if (!old) {
      stmts.push(db.prepare(`INSERT OR IGNORE INTO kfb_bills (bill_id, kfb_shop_code, billed_at, currency, total_eur, paid_at, imported_at) VALUES (?,?,?,?,?,?,?)`)
        .bind(b.bill_id, shop, billedAt, "EUR", b.total_eur, paidAt, at));
      out.inserted++;
    } else if (!same(old.kfb_shop_code, shop) || !same(old.billed_at, billedAt) || !same(old.total_eur, b.total_eur) || !same(old.paid_at, paidAt) || linesChanged) {
      stmts.push(db.prepare(`UPDATE kfb_bills SET kfb_shop_code = ?, billed_at = ?, total_eur = ?, paid_at = ? WHERE bill_id = ?`)
        .bind(shop, billedAt, b.total_eur, paidAt, b.bill_id));
      out.updated++;
    } else out.unchanged++;
    // Flags: incomplete (cut by a truncated read) and which field the line costs came from.
    const fl = oldFlags.get(b.bill_id);
    const incomplete = b.incomplete ? 1 : 0;
    if (!fl || fl.incomplete !== incomplete || fl.cost_basis !== b.cost_basis) {
      stmts.push(db.prepare(`INSERT INTO kfb_bill_flags (bill_id, incomplete, cost_basis, updated_at) VALUES (?,?,?,?)
        ON CONFLICT(bill_id) DO UPDATE SET incomplete = excluded.incomplete, cost_basis = excluded.cost_basis, updated_at = excluded.updated_at`)
        .bind(b.bill_id, incomplete, b.cost_basis, at));
    }
    // The bill to pay. Header total if KFB gave a positive one, else the sum of every stored line.
    // Not listed: no amount, no date, or a bill cut by the read with no header total (a partial
    // line sum would understate what Reilly owes).
    if (b.incomplete && b.total_eur == null) { out.to_pay.incomplete++; continue; }
    const amount = b.total_eur ?? r2(storedLines.reduce((s, l) => s + lineEurOf(l), 0));
    if (!(amount > 0) || !billedAt) { out.to_pay.no_amount++; continue; }
    const status = b.paid === true ? "paid" : b.paid === false ? "unpaid" : "unknown";
    if (status === "unknown") out.to_pay.paid_state_unknown++;
    const store = shop ? (storeForShopCode(shop) || {}).id || null : null;
    const p = oldPay.get(b.bill_id);
    if (!p) {
      stmts.push(db.prepare(`INSERT OR IGNORE INTO supplier_bills (bill_id, store, amount, currency, billed_at, paid_at, status, source, imported_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(b.bill_id, store, amount, "EUR", billedAt, paidAt, status, "kfb_session", at));
      out.to_pay.inserted++;
    } else if (!same(p.store, store) || Math.abs(Number(p.amount) - amount) >= 0.005 || p.billed_at !== billedAt || !same(p.paid_at, paidAt) || p.status !== status) {
      stmts.push(db.prepare(`UPDATE supplier_bills SET store = ?, amount = ?, billed_at = ?, paid_at = ?, status = ? WHERE bill_id = ?`)
        .bind(store, amount, billedAt, paidAt, status, b.bill_id));
      out.to_pay.updated++;
    } else out.to_pay.unchanged++;
  }
  if (stmts.length) await runBatched(db, stmts);
  return out;
}

function insertLine(db, billId, l) {
  return db.prepare(
    `INSERT OR IGNORE INTO kfb_bill_lines (bill_id, line_no, kfb_shop_code, order_ref, kfb_order_id, parent_kfb_order_id, sku, quantity, cost_eur, fees_eur, shipping_eur)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(billId, l.line_no, l.kfb_shop_code, l.order_ref, l.kfb_order_id, l.parent_kfb_order_id, l.sku == null ? null : String(l.sku), l.quantity, l.cost_eur, l.fees_eur, l.shipping_eur);
}


/* ------------------------------------------------------------------ HTTP */

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

/** POST /api/import/kfb (the caller has already checked the key). Body: the payload, or {payload}. */
export async function handleKfbImport(request, env, { nowMs = Date.now() } = {}) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > KFB_IMPORT_MAX_BYTES) return jsonRes({ ok: false, error: `too large (over ${KFB_IMPORT_MAX_BYTES / 1048576} MB)` }, 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).length > KFB_IMPORT_MAX_BYTES) return jsonRes({ ok: false, error: `too large (over ${KFB_IMPORT_MAX_BYTES / 1048576} MB)` }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return jsonRes({ ok: false, error: "body is not JSON" }, 400); }
  const payload = isObj(body) && isObj(body.payload) ? body.payload : body;
  const r = await importKfb(env, payload, { nowMs });
  if (!r.ok) return jsonRes({ ok: false, error: r.errors.join("; "), errors: r.errors }, r.status || 400);
  return jsonRes(r);
}

/* ------------------------------------------------------------------ reminder */

/** "1" = the 9:00 reminder goes to Reilly's phone; anything else = shadow (logged only). Reilly flips it. */
export function kfbReminderMode(env) {
  return modeFor(env, "kfb_reminder"); // KFB_REMINDER_LIVE, read in one place (src/config/live.js)
}

/**
 * One phone reminder per Eastern day, from 09:00, when no KFB import has landed today.
 * Claimed in calendar_reminders first, so two cron ticks can never send it twice.
 */
export async function runKfbReminder(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const db = env.DB;
  const day = localDay(nowMs, "America/New_York");
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowMs));
  const minutes = Number(parts.find((p) => p.type === "hour").value) * 60 + Number(parts.find((p) => p.type === "minute").value);
  if (minutes < KFB_REMINDER_AFTER_MIN) return { sent: false, reason: "before 09:00 Eastern" };
  const st = await kfbImportStatus(db, nowMs);
  if (st.doneToday) return { sent: false, reason: "imported today" };
  const claim = await db.prepare(`INSERT OR IGNORE INTO calendar_reminders (key, due_day, sent_at) VALUES (?, ?, ?)`).bind(`kfb_import:${day}`, day, nowIso(nowMs)).run();
  if (!(claim.meta && claim.meta.changes)) return { sent: false, reason: "already reminded today" };
  const message = "KFB import not done today. Log in to KungFuBuy, then click the KFB → Store Brain bookmark." +
    (st.lastAt ? "" : " (No import has ever landed.)");
  const mode = kfbReminderMode(env);
  let r = { sent: false, reason: "shadow: not sent (KFB_REMINDER_LIVE is not \"1\")" };
  if (mode === "live") r = await sendPhone(env, { title: "Store Brain: KFB import", message, url: KFB_BILLS_PAGE, urlTitle: "Open KFB" }, { fetchImpl });
  await logEvent(db, {
    actor: ACTOR, kind: r.sent ? "kfb.reminder_sent" : mode === "live" ? "kfb.reminder_failed" : "kfb.reminder_shadow", target: "sys.phone", at: nowIso(nowMs),
    summary: r.sent ? "Reminded Reilly by phone: KFB import not done today" : mode === "live" ? `KFB import reminder not delivered: ${r.reason}` : "KFB import not done by 09:00 (shadow: reminder not sent to the phone)",
  });
  return { ...r, mode };
}
