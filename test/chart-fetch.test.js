import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";
import { runChartFetch, descUrlFrom, imagesFrom, looksBlocked, nextTryMs, MAX_TRIES } from "../src/agents/supplier/chartFetch.js";

const NOW = Date.parse("2026-10-20T15:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const OFFER = "https://detail.1688.com/offer/982289210807.html";
const DESC = "https://itemcdn.tmall.com/desc/icoss!0982289210807!1844385802?var=desc";
const LISTING = `<html><script>window.context={"detailUrl":"https:\\u002F\\u002Fitemcdn.tmall.com\\u002Fdesc\\u002Ficoss!0982289210807!1844385802?var=desc"}</script></html>`;
const DESC_TEXT = `var desc='<p><img src="https://cbu01.alicdn.com/img/ibank/A.jpg"><img src="//cbu01.alicdn.com/img/ibank/B.jpg"><img src="https://cbu01.alicdn.com/img/ibank/A.jpg"><img src="https://evil.example/x.jpg"></p>';`;
const CHART = { image_index: 1, unit: "cm", flat: false, rows: [{ size: "M", chest: 104, length: 67, shoulder: 54, sleeve: 55 }, { size: "L", chest: 108, length: 69, shoulder: 56, sleeve: 56 }, { size: "XL", chest: 112, length: 71, shoulder: 58, sleeve: 57 }] };

async function seed(DB) {
  await DB.prepare(`INSERT INTO orders (store, order_id, name, created_at, local_day, total, financial_status, updated_at) VALUES ('mar','gid://shopify/Order/1','#1',?,?,60,'paid',?)`).bind(iso(NOW - 86400000), "2026-10-19", iso(NOW)).run();
  await DB.prepare(`INSERT INTO order_lines (store, order_id, line_id, product_id, product_handle, title, variant_title, size, quantity, price, updated_at) VALUES ('mar','gid://shopify/Order/1','gid://shopify/LineItem/1','gid://shopify/Product/9','shawl-cardigan',?,'Green / 2XL','2XL',1,60,?)`).bind("Men's Cable Knit Shawl Collar Cardigan", iso(NOW)).run();
  await DB.prepare(`INSERT INTO supplier_links (store, product_handle, product_id, offer_id, offer_url, first_seen_at, last_seen_at) VALUES ('mar','shawl-cardigan','gid://shopify/Product/9','982289210807',?,?,?)`).bind(OFFER, iso(NOW), iso(NOW)).run();
}
function world({ listing = LISTING, listingUrl = OFFER, answer = CHART } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url); calls.push(u);
    if (u === OFFER) { const res = new Response(listing, { status: 200 }); Object.defineProperty(res, "url", { value: listingUrl }); return res; }
    if (u === DESC) return new Response(DESC_TEXT, { status: 200 });
    if (u.startsWith("https://cbu01.alicdn.com/")) return new Response(new Uint8Array([255, 216, 255, 1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
    if (u.startsWith("https://api.anthropic.com/")) {
      const body = JSON.parse(init.body); calls.push(body);
      return new Response(JSON.stringify({ model: body.model, content: [{ type: "text", text: JSON.stringify(answer) }], usage: { input_tokens: 3000, output_tokens: 200 }, stop_reason: "end_turn" }), { status: 200 });
    }
    throw new Error("unexpected fetch " + u);
  };
  return { fetchImpl, calls };
}
const env = (DB) => ({ DB, ANTHROPIC_API_KEY: "sk-ant-test-key-123456", CHART_FETCH_LIVE: "1" });

test("chart fetch: listing → description → images → one Claude call → chart saved NOT checked; only fixed hosts fetched", async () => {
  const DB = makeD1(); await seed(DB);
  const w = world();
  const r = await runChartFetch(env(DB), { nowMs: NOW, fetchImpl: w.fetchImpl });
  assert.equal(r.fetched[0].status, "read", JSON.stringify(r));
  const urls = w.calls.filter((c) => typeof c === "string");
  assert.ok(!urls.some((u) => u.includes("evil.example")), "never a host outside the allowlist");
  assert.equal(urls.filter((u) => u.includes("alicdn")).length, 2, "each image once");
  const ai = w.calls.find((c) => typeof c === "object");
  assert.equal(ai.messages[0].content.filter((x) => x.type === "image").length, 2);
  const rows = (await DB.prepare(`SELECT size_label, verified, source FROM size_charts WHERE store='mar' ORDER BY size_label`).all()).results;
  assert.equal(rows.length, 3);
  assert.ok(rows.every((x) => x.verified === 0), "never confirmed by the brain");
  assert.match(rows[0].source, /1688 listing .*not yet checked by Reilly/);
  const f = await DB.prepare(`SELECT * FROM chart_fetches`).first();
  assert.equal(f.status, "read"); assert.equal(f.next_try_at, null);
  // Done: not fetched again.
  const again = await runChartFetch(env(DB), { nowMs: NOW + 3600000, fetchImpl: w.fetchImpl });
  assert.equal(again.fetched.length, 0);
});

test("chart fetch: a slider check is 'blocked', tried again later, never past it; gives up after the last try", async () => {
  const DB = makeD1(); await seed(DB);
  const w = world({ listing: "<html>请拖动下方滑块完成验证</html>", listingUrl: "https://detail.1688.com/offer/982289210807.html/_____tmd_____/punish" });
  const r = await runChartFetch(env(DB), { nowMs: NOW, fetchImpl: w.fetchImpl });
  assert.equal(r.fetched[0].status, "blocked");
  assert.ok(!w.calls.some((c) => typeof c === "object"), "no AI spent");
  const f = await DB.prepare(`SELECT * FROM chart_fetches`).first();
  assert.ok(Date.parse(f.next_try_at) > NOW);
  assert.equal((await runChartFetch(env(DB), { nowMs: NOW + 3600000, fetchImpl: w.fetchImpl })).fetched.length, 0, "waits for the next try");
  assert.equal(nextTryMs("blocked", MAX_TRIES, NOW), null);
  assert.equal(nextTryMs("read", 1, NOW), null);
});

test("chart fetch: the height/weight guide is not a chart; off unless CHART_FETCH_LIVE=1", async () => {
  const DB = makeD1(); await seed(DB);
  const w = world({ answer: { image_index: null, rows: [], unreadable: "only a height/weight size guide" } });
  const r = await runChartFetch(env(DB), { nowMs: NOW, fetchImpl: w.fetchImpl });
  assert.equal(r.fetched[0].status, "not_found");
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM size_charts`).first()).n, 0);
  assert.equal((await runChartFetch({ DB }, { nowMs: NOW })).skipped, "CHART_FETCH_LIVE is not 1");
});

test("chart fetch helpers", () => {
  assert.equal(descUrlFrom(LISTING), DESC);
  assert.equal(descUrlFrom(`"detailUrl":"https://evil.example/desc"`), null);
  assert.deepEqual(imagesFrom(DESC_TEXT), ["https://cbu01.alicdn.com/img/ibank/A.jpg", "https://cbu01.alicdn.com/img/ibank/B.jpg"]);
  assert.equal(looksBlocked("https://x/_____tmd_____/punish", ""), true);
  assert.equal(looksBlocked(OFFER, LISTING), false);
});

test("chart fetch: hosts outside the allowlist and redirects off-host are never read", async () => {
  const { allowedHost, imagesFrom: imgs } = await import("../src/agents/supplier/chartFetch.js");
  assert.equal(allowedHost("https://evil-alicdn.com/x.jpg", "image"), false);
  assert.equal(allowedHost("https://cbu01.alicdn.com/x.jpg", "image"), true);
  assert.deepEqual(imgs(`<img src="https://evil-alicdn.com/a.jpg"><img src="https://img.alicdn.com/b.png">`), ["https://img.alicdn.com/b.png"]);
  const DB = makeD1(); await seed(DB);
  const w = world({ listingUrl: "https://login.1688.com/member/signin.htm" });
  const r = await runChartFetch(env(DB), { nowMs: NOW, fetchImpl: w.fetchImpl });
  assert.equal(r.fetched[0].status, "blocked");
  assert.ok(!w.calls.some((c) => typeof c === "string" && c.includes("itemcdn")), "nothing past an off-host redirect");
});

test("chart fetch: no downloads when image reading can't happen (no key)", async () => {
  const DB = makeD1(); await seed(DB);
  const w = world();
  const r = await runChartFetch({ DB, CHART_FETCH_LIVE: "1" }, { nowMs: NOW, fetchImpl: w.fetchImpl });
  assert.equal(r.fetched[0].status, "skipped");
  assert.equal(w.calls.length, 0);
});
