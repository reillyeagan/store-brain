import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";
import { applyRefundHistory } from "../src/lib/refundHistoryImport.js";
import { REFUND_HISTORY } from "../src/data/refundHistory.js";

const at = Date.parse("2026-10-16T18:00:00Z");
async function ledger({ coveredFrom = "2026-08-19", have = [] } = {}) {
  const DB = makeD1();
  await DB.prepare(`SELECT 1`).first(); // migrations applied by the helper
  await DB.prepare(`INSERT INTO feed_coverage (store, feed, start_day, covered_from, cursor_at, updated_at) VALUES ('aub','refunds',?,?,NULL,'x')`).bind(coveredFrom, coveredFrom).run();
  for (const [id, day, amount] of have) await DB.prepare(`INSERT INTO refunds (store, refund_id, order_id, processed_at, local_day, amount, status, raw, updated_at) VALUES ('aub', ?, 'o', ?, ?, ?, 'SUCCESS', '{}', 'x')`).bind(id, `${day}T12:00:00Z`, day, amount).run();
  return { DB };
}
const H = (refunds, extra = {}) => ({ source: "test", read_at: "2026-10-16T17:35:00Z", stores: [{ store: "aub", shop_domain: "3as2ya-dw.myshopify.com", from: "2026-07-01", refunds, ...extra }] });
const R = (id, iso, amount) => [`gid://shopify/Refund/${id}`, "gid://shopify/Order/1", `#${id}`, iso, amount, "SUCCESS"];

test("refund history: older refunds load, coverage moves back, once only", async () => {
  const env = await ledger({ have: [["gid://shopify/Refund/9", "2026-10-10", 64.95]] });
  const h = H([R(1, "2026-07-28T16:11:56Z", 43.95), R(2, "2026-08-19T03:51:14Z", 87.9), R(9, "2026-10-10T22:25:54Z", 64.95)]);
  const [r] = await applyRefundHistory(env, { nowMs: at, history: h });
  assert.equal(r.added, 2, "both before coverage (Aug 19 03:51 UTC is Aug 18 Eastern)");
  assert.equal(r.matched, 1);
  assert.equal((await env.DB.prepare(`SELECT covered_from FROM feed_coverage WHERE store='aub'`).first()).covered_from, "2026-07-01");
  assert.equal((await env.DB.prepare(`SELECT local_day FROM refunds WHERE refund_id = 'gid://shopify/Refund/2'`).first()).local_day, "2026-08-18");
  const [again] = await applyRefundHistory(env, { nowMs: at, history: h });
  assert.equal(again.skipped, "already applied");
});

test("refund history: refused (nothing loaded, coverage kept) when the list misses a refund the brain has, or the amounts differ", async () => {
  for (const have of [[["gid://shopify/Refund/77", "2026-09-30", 20]], [["gid://shopify/Refund/9", "2026-10-10", 60]]]) {
    const env = await ledger({ have });
    const [r] = await applyRefundHistory(env, { nowMs: at, history: H([R(1, "2026-07-28T16:11:56Z", 43.95), R(9, "2026-10-10T22:25:54Z", 64.95)]) });
    assert.equal(r.refused, "mismatch");
    assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM refunds`).first()).n, 1);
    assert.equal((await env.DB.prepare(`SELECT covered_from FROM feed_coverage WHERE store='aub'`).first()).covered_from, "2026-08-19");
    const [again] = await applyRefundHistory(env, { nowMs: at + 900000, history: H([R(1, "2026-07-28T16:11:56Z", 43.95), R(9, "2026-10-10T22:25:54Z", 64.95)]) });
    assert.equal(again.refused, "mismatch", "tried again, not skipped forever");
  }
});

test("refund history: a PENDING refund the list doesn't show doesn't block it", async () => {
  const env = await ledger({ have: [["gid://shopify/Refund/9", "2026-10-10", 64.95]] });
  await env.DB.prepare(`INSERT INTO refunds (store, refund_id, order_id, processed_at, local_day, amount, status, raw, updated_at) VALUES ('aub','gid://shopify/Refund/55','o','2026-10-12T12:00:00Z','2026-10-12',30,'PENDING','{}','x')`).run();
  const [r] = await applyRefundHistory(env, { nowMs: at, history: H([R(1, "2026-07-28T16:11:56Z", 43.95), R(9, "2026-10-10T22:25:54Z", 64.95)]) });
  assert.equal(r.added, 1);
});

test("refund history: a list read from another shop is refused", async () => {
  const env = await ledger();
  const [r] = await applyRefundHistory(env, { nowMs: at, history: H([R(1, "2026-07-28T16:11:56Z", 43.95)], { shop_domain: "other.myshopify.com" }) });
  assert.equal(r.refused, "shop domain mismatch");
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM refunds`).first()).n, 0);
});

test("refund history data: every row well formed, every store's own domain", () => {
  const doms = { hc: "jmzjx1-it.myshopify.com", aub: "3as2ya-dw.myshopify.com", mar: "806080-g8.myshopify.com" };
  for (const s of REFUND_HISTORY.stores) {
    assert.equal(s.shop_domain, doms[s.store]);
    for (const r of s.refunds) {
      assert.match(r[0], /^gid:\/\/shopify\/Refund\/\d+$/); assert.match(r[1], /^gid:\/\/shopify\/Order\/\d+$/);
      assert.ok(!Number.isNaN(Date.parse(r[3]))); assert.equal(typeof r[4], "number");
    }
    assert.equal(new Set(s.refunds.map((r) => r[0])).size, s.refunds.length, "no duplicates");
  }
});
