/**
 * Order detail — what was bought (line items, size, colour) and how it ships.
 *
 * Why: the Supplier department has to tell KFB which orders the customer paid express
 * shipping for, and the Size Checker (later) needs the size ordered on every line.
 * Both webhook payloads (REST shape) and the 15-minute GraphQL pull feed the same
 * `order_lines` rows, so the two paths can't disagree about an order.
 */

/**
 * Did the customer pay for express shipping?
 *
 * One rule, one place. For now: the shipping rate's title or code contains "express".
 * NOT YET CONFIRMED against each store's real rate names. The first shadow week checks
 * this rule against the ~22 orders Reilly asked KFB to express by hand; if a store calls
 * it something else ("Priority", "Fast"), change it here and nowhere else.
 */
export function isExpressShipping(title, code) {
  return /express/i.test(String(title || "")) || /express/i.test(String(code || ""));
}

// Letter sizes (XS…6XL, XXL, XXXL), size words, and plain numbers (waist 32, shoe 10.5).
const SIZE_RE = /^(?:XXS|XS|S|M|L|XL|X{2,4}L|[2-6]XL|[2-6]X|small|medium|large|x-large|xx-large|xxx-large|\d{1,3}(?:\.5)?)$/i;

export function looksLikeSize(v) {
  return SIZE_RE.test(String(v || "").trim());
}

/**
 * Pick the size and colour of one line.
 * Prefers named options (GraphQL `selectedOptions`: "Size", "Color"/"Colour") because
 * names can't be misread. Falls back to the variant title ("Navy / L"), where the
 * size is whichever part looks like a size and the colour is the first other part
 * (a best guess: REST webhooks don't say which option is which).
 */
export function sizeAndColor({ variantTitle = null, options = null } = {}) {
  let size = null;
  let color = null;
  if (Array.isArray(options) && options.length) {
    const byName = (re) => options.find((o) => o && re.test(String(o.name || "")));
    const s = byName(/size/i);
    const c = byName(/^colou?r$/i);
    if (s && s.value) size = String(s.value).trim();
    if (c && c.value) color = String(c.value).trim();
  }
  if ((!size || !color) && variantTitle && variantTitle !== "Default Title") {
    const parts = String(variantTitle).split("/").map((p) => p.trim()).filter(Boolean);
    const sizePart = parts.find(looksLikeSize) || null;
    if (!size) size = sizePart;
    if (!color) color = parts.find((p) => p !== sizePart && !looksLikeSize(p)) || null;
  }
  return { size, color };
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const gid = (type, id) => (id == null || id === "" ? null : String(id).startsWith("gid://") ? String(id) : `gid://shopify/${type}/${id}`);

/** Shipping of a REST webhook order: the first shipping line is the rate the customer chose. */
export function shippingFromWebhook(o) {
  const s = Array.isArray(o.shipping_lines) && o.shipping_lines[0] ? o.shipping_lines[0] : null;
  const title = s ? s.title || null : null;
  const code = s ? s.code || null : null;
  return { shipping_title: title, shipping_code: code, express: isExpressShipping(title, code) ? 1 : 0 };
}

/** Shipping of a GraphQL order node (`shippingLine { title code }`). */
export function shippingFromNode(n) {
  const s = n.shippingLine || null;
  const title = s ? s.title || null : null;
  const code = s ? s.code || null : null;
  return { shipping_title: title, shipping_code: code, express: isExpressShipping(title, code) ? 1 : 0 };
}

/** Lines of a REST webhook order. Returns null if the payload carries no line list at all. */
export function linesFromWebhook(o) {
  if (!Array.isArray(o.line_items)) return null;
  return o.line_items.map((li) => {
    const { size, color } = sizeAndColor({ variantTitle: li.variant_title, options: null });
    return {
      line_id: li.admin_graphql_api_id || gid("LineItem", li.id),
      product_id: gid("Product", li.product_id),
      product_handle: null, // REST line items don't carry it
      variant_id: gid("ProductVariant", li.variant_id),
      sku: li.sku || null,
      title: li.title || li.name || null,
      variant_title: li.variant_title || null,
      size, color,
      quantity: Number.isFinite(Number(li.quantity)) ? Number(li.quantity) : null,
      price: num(li.price),
    };
  });
}

/** Lines of a GraphQL order node (`lineItems { nodes {...} }`). */
export function linesFromNode(n) {
  const nodes = n && n.lineItems && Array.isArray(n.lineItems.nodes) ? n.lineItems.nodes : null;
  if (!nodes) return null;
  return nodes.map((li) => {
    const options = li.variant && Array.isArray(li.variant.selectedOptions) ? li.variant.selectedOptions : null;
    const { size, color } = sizeAndColor({ variantTitle: li.variantTitle, options });
    const price = li.originalUnitPriceSet && li.originalUnitPriceSet.shopMoney ? num(li.originalUnitPriceSet.shopMoney.amount) : null;
    return {
      line_id: li.id,
      product_id: li.product ? li.product.id || null : null,
      product_handle: li.product ? li.product.handle || null : null,
      variant_id: li.variant ? li.variant.id || null : null,
      sku: li.sku || null,
      title: li.title || li.name || null,
      variant_title: li.variantTitle || null,
      size, color,
      quantity: Number.isFinite(Number(li.quantity)) ? Number(li.quantity) : null,
      price,
    };
  });
}

/**
 * Make the ledger's lines for one order match `lines` exactly, and record which order
 * version (`forUpdatedAt`) they reflect. Callers only do this when the order row itself
 * was written, so an older payload can never roll the lines back.
 */
export async function replaceOrderLines(db, storeId, orderId, lines, forUpdatedAt, at) {
  for (const l of lines) {
    if (!l.line_id) continue;
    await db.prepare(
      `INSERT INTO order_lines (store, order_id, line_id, product_id, product_handle, variant_id, sku, title,
         variant_title, size, color, quantity, price, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(store, line_id) DO UPDATE SET
         order_id = excluded.order_id, product_id = excluded.product_id,
         product_handle = COALESCE(excluded.product_handle, order_lines.product_handle),
         variant_id = excluded.variant_id, sku = excluded.sku, title = excluded.title,
         variant_title = excluded.variant_title, size = excluded.size, color = excluded.color,
         quantity = excluded.quantity, price = excluded.price, updated_at = excluded.updated_at`
    ).bind(storeId, orderId, l.line_id, l.product_id, l.product_handle, l.variant_id, l.sku, l.title,
      l.variant_title, l.size, l.color, l.quantity, l.price, at).run();
  }
  // Lines that are no longer on the order (removed in an order edit) go.
  const keep = lines.map((l) => l.line_id).filter(Boolean);
  const { results } = await db.prepare(`SELECT line_id FROM order_lines WHERE store = ? AND order_id = ?`).bind(storeId, orderId).all();
  for (const r of results || []) {
    if (!keep.includes(r.line_id)) {
      await db.prepare(`DELETE FROM order_lines WHERE store = ? AND line_id = ?`).bind(storeId, r.line_id).run();
    }
  }
  await db.prepare(`UPDATE orders SET lines_for_updated_at = ? WHERE store = ? AND order_id = ?`)
    .bind(forUpdatedAt || at, storeId, orderId).run();
}
