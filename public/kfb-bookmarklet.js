/*
 * "KFB → Store Brain" bookmarklet (the KFB morning import, client side).
 *
 * The import page (#/import/kfb) turns SB_KFB_BOOKMARKLET into a javascript: link that Reilly
 * drags to his bookmarks bar once. Each morning, on KungFuBuy and logged in (he types the
 * CAPTCHA himself), he clicks it. It then:
 *   1. refuses to run anywhere but the KFB origin;
 *   2. opens the Store Brain import page in a new tab (first, so the pop-up isn't blocked);
 *   3. GETs KFB's own JSON endpoints in his tab, with his session (fetch, method GET only:
 *      nothing is ever written to KFB, and the brain never sees his cookies or password);
 *   4. waits for the import page to say "ready", then hands the rows over with postMessage
 *      to the exact Store Brain origin, and stops when the page says "received".
 * No key or secret is in here: the import page asks for the dashboard key the normal way.
 * If a read fails it says which endpoint and why; if the tab never answers it saves a JSON
 * file for the page's "Paste JSON" box instead.
 *
 * Endpoints: see src/config/kfb.js (where each comes from, and which ones are guesses).
 * The function is turned into text with toString(), so it must not use anything outside it.
 */
window.SB_KFB_BOOKMARKLET = function () {
  "use strict";
  var SB = "https://store-brain.reillyworking26.workers.dev";
  var KFB = ["https://www.kungfubuy.com", "https://kungfubuy.com"];
  var EP = {
    quotes: ["/index/quotation/get.html"],
    orders: ["/index/order/get.html"],
    bills: ["/index/billOrder/get.html", "/index/bill/get.html", "/index/member/billOrder/get.html"]
  };
  /* Quotations: one call with no status gets every row (vault 09-06). Orders and bills: the
     first pages, assumed newest first. */
  var PLAN = {
    quotes: { limit: 500, pages: 6, extra: "&un_shop_url=" },
    orders: { limit: 100, pages: 3, extra: "" },
    bills: { limit: 100, pages: 3, extra: "" }
  };
  var LINE_KEYS = /^(details|detail|bill_details|lines|list|items|children|sub_orders|suborders|order_list|orders)$/;
  /* ONLY these fields are sent (an allowlist: anything else, such as customer names and
     addresses, never leaves the KFB tab). They are the fields src/lib/kfbImport.js reads.
     manual_pricing is kept whole: its keys are country names holding prices. */
  var KEEP = {};
  ("details detail bill_details lines list items children sub_orders suborders order_list orders product manual_pricing " +
   "id order_id kfb_order_id kfb_order_no order_no order_sn quotation_no quotation_id sn status quotation_status quote_status order_status state " +
   "un_shop_url shop_url shop_code un_shop shop_domain un_good_url store_link good_url goods_url link un_good_id un_variant_id un_good_sku goods_sku sku " +
   "order_remark remark reason quote_time quotation_time quoted_time relates_information_time update_time updated_at update_at create_time create_at created_at " +
   "shopify_create_at un_create_at order_time un_order_name un_order_number shopify_order_name shopify_order_no order_name " +
   "bill_no bill_sn bill_id bill_order_no bill_number bill_order_id bill_code bill_time billed_at bill_date " +
   "pay_status is_pay is_paid paid payment_status pay_time paid_at pay_at payment_time " +
   "bill_pay_status bill_is_pay bill_is_paid bill_paid bill_payment_status bill_pay_time bill_paid_at bill_payment_time " +
   "bill_amount bill_price bill_total total_amount total_money total_price total amount money subtotal " +
   "goods_total goods_amount total_goods_price product_total goods_money purchase_amount goods_price purchase_price product_price unit_price cost " +
   "service_fee service_price service_charge handling_fee commission fee freight freight_price shipping_fee shipping_price shipping " +
   "logistics_fee logistics_price postage express_fee quantity num goods_num qty number " +
   /* The factory link and the factory's size name (Reilly 2026-10-20: size charts come from the
      "supplier link" on each quote): product[].order_items.goods_url / goods_spec. */
   "order_items goods_spec un_good_spec un_good_id un_variant_id").split(" ").forEach(function (k) { KEEP[k] = 1; });

  if (KFB.indexOf(location.origin) < 0) {
    alert("Store Brain: this only works on KungFuBuy while you are logged in. This page is " + location.origin + ". If KungFuBuy has moved to this address, tell Claude.");
    return;
  }
  /* A fresh nonce each click, so a second click navigates the reused tab (and the page can tell
     the two hand-overs apart). */
  var nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  var w = window.open(SB + "/#/import/kfb?n=" + nonce, "sb_kfb_import");
  if (!w) { alert("Store Brain: the browser blocked the new tab. Allow pop-ups for KungFuBuy, then click the bookmark again."); return; }

  var box = document.createElement("div");
  box.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:420px;background:#131316;color:#e8e8ea;border:1px solid #26262b;border-radius:10px;padding:10px 14px;font:13px/1.45 Inter,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4)";
  document.body.appendChild(box);
  function say(t) { box.textContent = "Store Brain · " + t; }

  var ready = false, sent = false, payload = null;
  function trySend() {
    if (ready && payload && !sent) { sent = true; w.postMessage({ type: "sb-kfb-data", nonce: nonce, payload: payload }, SB); }
  }
  /* Handshake both ways: the page says "ready" when it loads, and this tab says "hello" every
     second until it hears "ready" (a tab that was already open never reloads, so only the
     hello gets an answer from it). Only the exact Store Brain origin is ever addressed. */
  var hello = setInterval(function () {
    if (ready || w.closed) { clearInterval(hello); return; }
    try { w.postMessage({ type: "sb-kfb-hello", nonce: nonce }, SB); } catch (e) {}
  }, 1000);
  function onMsg(ev) {
    if (ev.origin !== SB || ev.source !== w) return;
    var d = ev.data || {};
    if (d.type === "sb-kfb-ready") { ready = true; clearInterval(hello); trySend(); }
    if (d.type === "sb-kfb-received") {
      window.removeEventListener("message", onMsg);
      say(summary + " · handed over. Press Import in the Store Brain tab.");
      setTimeout(function () { box.remove(); }, 10000);
    }
  }
  window.addEventListener("message", onMsg);

  /* pricing = inside manual_pricing, where every key (a country) is kept. */
  function slim(v, depth, key, lines, pricing) {
    if (v == null || typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "string") { var cap0 = pricing ? 4000 : 300; return v.length > cap0 ? v.slice(0, cap0) : v; }
    if (depth > 6) return null;
    if (Array.isArray(v)) {
      var cap = lines && LINE_KEYS.test(key) ? 400 : 3;
      return v.slice(0, cap).map(function (x) { return slim(x, depth + 1, key, lines, pricing); });
    }
    if (typeof v === "object") {
      var o = {};
      for (var k in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k) || !(pricing || KEEP[k])) continue;
        o[k] = slim(v[k], depth + 1, k, lines, pricing || k === "manual_pricing");
      }
      return o;
    }
    return null;
  }
  function pause(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  /* GET only. One retry: an HTML answer is evidence about this request, not proof of a logout. */
  async function getJson(url) {
    for (var attempt = 0; attempt < 2; attempt++) {
      var r = await fetch(url, { method: "GET", credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest", "Accept": "application/json" } });
      var t = await r.text(), j = null;
      try { j = JSON.parse(t); } catch (e) { j = null; }
      if (r.ok && j && typeof j === "object") return j;
      if (attempt === 0) { await pause(1500); continue; }
      throw new Error(url.split("?")[0] + (r.ok ? " answered a web page, not data (check the KFB tab: you may be logged out)" : " answered HTTP " + r.status));
    }
  }
  function rowsOf(j) {
    if (Array.isArray(j)) return j;
    if (j && Array.isArray(j.data)) return j.data;
    if (j && j.data && Array.isArray(j.data.list)) return j.data.list;
    if (j && j.data && Array.isArray(j.data.data)) return j.data.data;
    if (j && Array.isArray(j.rows)) return j.rows;
    return null;
  }
  async function readSection(name) {
    var plan = PLAN[name], errs = [];
    for (var e = 0; e < EP[name].length; e++) {
      var ep = EP[name][e], rows = [], total = null, ended = false;
      try {
        for (var p = 1; p <= plan.pages; p++) {
          var j = await getJson(ep + "?limit=" + plan.limit + "&page=" + p + "&output=layui.table" + plan.extra);
          if (j.code != null && Number(j.code) !== 0) throw new Error(ep + " said: " + String(j.msg || ("code " + j.code)).slice(0, 120));
          var got = rowsOf(j);
          if (!got) throw new Error(ep + " answered without a list of rows");
          for (var i = 0; i < got.length; i++) rows.push(slim(got[i], 0, "", name === "bills", false));
          if (j.count != null && isFinite(Number(j.count))) total = Math.max(0, Math.floor(Number(j.count)));
          if (got.length < plan.limit || (total != null && rows.length >= total)) { ended = true; break; }
        }
        /* Truncated = the read stopped before KFB's last row (page limit). The server then never
           deletes lines and flags the bill at the cut; the Order Watcher counts no absences. */
        var truncated = total != null ? rows.length < total : !ended;
        return { ok: true, endpoint: ep, rows: rows, total: total, truncated: truncated, error: null };
      } catch (err) { errs.push(String((err && err.message) || err)); }
    }
    return { ok: false, endpoint: null, rows: [], error: errs.join(" | ").slice(0, 600) };
  }
  function saveFile() {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: "application/json" }));
    a.download = "kfb-import-" + payload.fetched_at.slice(0, 10) + ".json";
    document.body.appendChild(a); a.click(); a.remove();
  }
  var summary = "";
  (async function () {
    try {
      say("reading quotations…"); var q = await readSection("quotes");
      say("reading orders…"); var o = await readSection("orders");
      say("reading bills…"); var b = await readSection("bills");
      payload = { kind: "kfb-import", version: 1, origin: location.origin, fetched_at: new Date().toISOString(), sections: { quotes: q, orders: o, bills: b } };
      var part = function (n, s) { return n + " " + (s.ok ? s.rows.length + (s.truncated ? " (cut off at the page limit)" : "") : "NOT READ"); };
      summary = part("quotes", q) + " · " + part("orders", o) + " · " + part("bills", b);
      var failed = [q, o, b].filter(function (s) { return !s.ok; }).map(function (s) { return s.error; });
      if (failed.length) box.title = failed.join("\n");
      if (!q.ok && !o.ok && !b.ok) { say("nothing could be read. " + failed.join(" | ").slice(0, 300)); return; }
      if (new TextEncoder().encode(JSON.stringify(payload)).length > 4900000) { say(summary + " · too much data to hand over (over 5 MB). Tell Claude."); return; }
      say(summary + " · handing over…");
      trySend();
      setTimeout(function () {
        if (!sent) { say(summary + " · the Store Brain tab did not answer, so a file was saved. Use Paste JSON on the import page."); saveFile(); }
      }, 30000);
    } catch (err) { say("stopped: " + ((err && err.message) || err)); }
  })();
};
