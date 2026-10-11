import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { makeD1, makeR2 } from "./helpers/d1.js";

import {
  collectShipments, registerNew, pollTracking, runChecks, runTracking, handleTrackingPush, shippingState,
  shipmentsFromOrderNode, easternDaysSince, normaliseNumber, FULFILLMENTS_QUERY, ORDERS_PER_PAGE, FEED_ID,
} from "../src/lib/tracking.js";
import { mapStatus, summarise, verifyPush, API_BASE } from "../src/lib/track17.js";
import { runKfbComposer, composePickupBody } from "../src/lib/kfbMessage.js";
import { _resetTokenCacheForTests } from "../src/lib/storeGuard.js";
import { recentEvents } from "../src/lib/eventlog.js";
import { evaluateFeeds, ensureFeeds } from "../src/lib/freshness.js";
import { listPending } from "../src/lib/approvals.js";
import { readBackup } from "../src/lib/backupVault.js";
import worker from "../src/index.js";

/* ---------------- fixtures ---------------- */

const KEY = "TESTKEY0123456789ABCDEF";
const HC_CREDS = { SB_HC_CLIENT_ID: "id", SB_HC_CLIENT_SECRET: "hc-secret" };
const NOW = Date.parse("2026-10-11T16:00:00Z"); // 12:00 Eastern
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const ET = (hhmm, day = "2026-10-11") => Date.parse(`${day}T${hhmm}:00-04:00`);

beforeEach(() => _resetTokenCacheForTests());

const noSleep = async () => {};

/** Insert a shipment row directly (most checks don't need Shopify). */
async function seed(DB, s) {
  const row = {
    store: "hc", order_id: `gid://shopify/Order/${s.order}`, order_name: `#${s.order}`,
    order_created_at: iso(NOW - 5 * DAY), shipped_at: iso(NOW - 4 * DAY), updated_at: iso(NOW),
    registered_at: null, state: null, last_status: null, polled_at: null, delivered_at: null, pod: null,
    register_error: null, shopify_status: null, shopify_delivered_at: null,
    ...s,
  };
  await DB.prepare(
    `INSERT INTO shipments (store, order_id, order_name, order_created_at, tracking_number, shipped_at, registered_at,
       state, last_status, polled_at, delivered_at, pod, register_error, shopify_status, shopify_delivered_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(row.store, row.order_id, row.order_name, row.order_created_at, row.tracking_number, row.shipped_at,
    row.registered_at, row.state, row.last_status, row.polled_at, row.delivered_at, row.pod,
    row.register_error, row.shopify_status, row.shopify_delivered_at, row.updated_at).run();
}

const ship = (DB, n) => DB.prepare(`SELECT * FROM shipments WHERE tracking_number = ?`).bind(n).first();

function trackItem(number, status, { sub = `${status}_Other`, time = "2026-10-10T14:05:00-04:00", location = "CHARLOTTE, NC 28202", events = null, milestone = [] } = {}) {
  const ev = { time_iso: time, time_utc: new Date(Date.parse(time)).toISOString(), description: `${status} event`, location, sub_status: sub };
  return {
    number, carrier: 21051,
    track_info: {
      latest_status: { status, sub_status: sub },
      latest_event: ev,
      milestone,
      shipping_info: { recipient_address: { country: "US", state: "NC", city: "CHARLOTTE", postal_code: "28202" } },
      tracking: { providers: [{ provider: { name: "USPS" }, events: events || [ev] }] },
    },
  };
}

/**
 * Fake 17TRACK. Quota drops by one for each newly accepted registration, like the real thing.
 * `log` records every call so tests can count registrations.
 */
function fake17({ remain = 200, total = 200, reject = {}, info = {}, log = [] } = {}) {
  const registered = new Set();
  const q = { remain, total };
  const handler = async (url, init) => {
    const path = String(url).replace(`${API_BASE}/`, "");
    const body = JSON.parse(init.body);
    log.push({ path, body, headers: init.headers });
    if (init.headers["17token"] !== KEY) return new Response(JSON.stringify({ code: 401 }), { status: 401 });
    if (path === "getquota") {
      return Response.json({ code: 0, data: { quota_total: q.total, quota_used: q.total - q.remain, quota_remain: q.remain, today_used: 0 } });
    }
    if (path === "register") {
      const accepted = [], rejected = [];
      for (const { number } of body) {
        if (reject[number]) rejected.push({ number, error: { code: reject[number], message: "nope" } });
        else if (registered.has(number)) rejected.push({ number, error: { code: -18019901, message: "already registered" } });
        else { registered.add(number); q.remain--; accepted.push({ number, carrier: 190008, origin: 1 }); }
      }
      return Response.json({ code: 0, data: { accepted, rejected } });
    }
    if (path === "gettrackinfo") {
      const accepted = body.filter(({ number }) => info[number]).map(({ number }) => info[number]);
      return Response.json({ code: 0, data: { accepted, rejected: [] } });
    }
    return new Response("not found", { status: 404 });
  };
  handler.registered = registered;
  handler.quota = q;
  return handler;
}

/** Shopify (H&C only) + 17TRACK behind one fetch. */
function router({ orders = [], t17 = fake17(), gqlLog = [] } = {}) {
  return async (url, init) => {
    const u = String(url);
    if (u.includes("/admin/oauth/access_token")) return Response.json({ access_token: "tok", expires_in: 86400 });
    if (u.includes("/graphql.json")) {
      gqlLog.push(JSON.parse(init.body));
      return Response.json({ data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: orders } } });
    }
    if (u.startsWith(API_BASE)) return t17(url, init);
    throw new Error(`unexpected fetch ${u}`);
  };
}

const orderNode = (n, fulfillments, createdAt = iso(NOW - 5 * DAY)) => ({ id: `gid://shopify/Order/${n}`, name: `#${n}`, createdAt, fulfillments });

/* ---------------- collect ---------------- */

test("collect: fulfillments with tracking → shipments (cancelled ignored, numbers normalised, once per number)", async () => {
  const DB = makeD1();
  const env = { DB, ...HC_CREDS };
  const gqlLog = [];
  const orders = [
    orderNode(1231, [{ id: "gid://shopify/Fulfillment/1", createdAt: iso(NOW - 4 * DAY), status: "SUCCESS",
      trackingInfo: [{ number: " ul123456789yp ", company: "Yanwen", url: "https://t.example/UL" }] }]),
    orderNode(1232, [
      { id: "gid://shopify/Fulfillment/2", createdAt: iso(NOW - 3 * DAY), status: "SUCCESS", trackingInfo: [{ number: "YT2412345678901234", company: null, url: null }] },
      { id: "gid://shopify/Fulfillment/3", createdAt: iso(NOW - 3 * DAY), status: "CANCELLED", trackingInfo: [{ number: "GFUS01234567890", company: "Other" }] },
    ]),
    orderNode(1233, []), // not shipped yet
  ];
  const r = await collectShipments(env, { nowMs: NOW, fetchImpl: router({ orders, gqlLog }) });
  assert.equal(r.find((x) => x.store === "hc").added, 2);
  assert.equal(r.find((x) => x.store === "aub").skipped, "not wired");
  const ul = await ship(DB, "UL123456789YP");
  assert.equal(ul.order_name, "#1231");
  assert.equal(ul.carrier_hint, "Yanwen");
  assert.equal(ul.shipped_at, iso(NOW - 4 * DAY));
  assert.equal(await ship(DB, "GFUS01234567890"), null, "cancelled fulfillment is not a parcel");
  assert.equal(gqlLog[0].variables.q, "created_at:>=2026-09-11", "only the last 30 days");
  // Running again adds nothing.
  const again = await collectShipments(env, { nowMs: NOW, fetchImpl: router({ orders }) });
  assert.equal(again.find((x) => x.store === "hc").added, 0);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM shipments").first()).n, 2);
});

test("collect: query asks for well under Shopify's 1,000-point limit", () => {
  assert.match(FULFILLMENTS_QUERY, /fulfillments\(first: 3\)/);
  assert.match(FULFILLMENTS_QUERY, /trackingInfo\(first: 2\)/);
  assert.ok(ORDERS_PER_PAGE * (1 + 3 * (1 + 2)) < 1000);
  assert.equal(shipmentsFromOrderNode({ id: "x", fulfillments: [{ status: "SUCCESS", trackingInfo: [{ number: "" }] }] }).length, 0);
  assert.equal(normaliseNumber("ab 12 cd 34"), "AB12CD34");
  assert.equal(normaliseNumber("<script>"), null);
});

/* ---------------- register (quota) ---------------- */

test("register: each number once, never past the quota, never orders older than 30 days", async () => {
  const DB = makeD1();
  const log = [];
  const t17 = fake17({ remain: 2, total: 200, log });
  const env = { DB, TRACKING_API_KEY: KEY };
  await seed(DB, { order: 1, tracking_number: "UL000000001YP", shipped_at: iso(NOW - 3 * DAY) });
  await seed(DB, { order: 2, tracking_number: "UL000000002YP", shipped_at: iso(NOW - 2 * DAY) });
  await seed(DB, { order: 3, tracking_number: "UL000000003YP", shipped_at: iso(NOW - 1 * DAY) });
  await seed(DB, { order: 4, tracking_number: "UL000000004YP", order_created_at: iso(NOW - 31 * DAY) });

  const r1 = await registerNew(env, { nowMs: NOW, fetchImpl: t17, sleep: noSleep });
  assert.equal(r1.registered, 2, "only as many as the quota allows");
  assert.equal(r1.quota.remain, 0, "quota read back from 17TRACK");
  assert.ok((await ship(DB, "UL000000003YP")).registered_at, "newest first");
  assert.ok((await ship(DB, "UL000000002YP")).registered_at);
  assert.equal((await ship(DB, "UL000000001YP")).registered_at, null, "oldest waits");

  // Quota used up: nothing more is sent, and it says so.
  const r2 = await registerNew(env, { nowMs: NOW + 3600000, fetchImpl: t17, sleep: noSleep });
  assert.equal(r2.registered, 0);
  assert.ok((await recentEvents(DB)).some((e) => e.kind === "tracking.quota_exhausted"));
  assert.ok((await recentEvents(DB)).some((e) => e.kind === "tracking.quota_low"));

  // Topped up: only the remaining number goes, never the first two again, never the old order.
  t17.quota.remain = 30;
  const r3 = await registerNew(env, { nowMs: NOW + 7200000, fetchImpl: t17, sleep: noSleep });
  assert.equal(r3.registered, 1);
  const sent = log.filter((c) => c.path === "register").flatMap((c) => c.body.map((b) => b.number));
  assert.deepEqual(sent.sort(), ["UL000000001YP", "UL000000002YP", "UL000000003YP"]);
  assert.equal(new Set(sent).size, sent.length, "no number sent twice");
  assert.equal((await ship(DB, "UL000000004YP")).registered_at, null);
  // The key travels only in the header, and never lands in the event log.
  assert.equal(log[0].headers["17token"], KEY);
  assert.ok(!JSON.stringify(await recentEvents(DB)).includes(KEY));
});

test("register: 'already registered' counts as registered; other rejections are never retried", async () => {
  const DB = makeD1();
  const log = [];
  const t17 = fake17({ reject: { GFUS000000001: -18019903 }, log });
  t17.registered.add("YT0000000000000001"); // registered before (e.g. a crash after the API call)
  const env = { DB, TRACKING_API_KEY: KEY };
  await seed(DB, { order: 1, tracking_number: "YT0000000000000001" });
  await seed(DB, { order: 2, tracking_number: "GFUS000000001" });
  const r = await registerNew(env, { nowMs: NOW, fetchImpl: t17, sleep: noSleep });
  assert.equal(r.already, 1);
  assert.equal(r.rejected, 1);
  assert.ok((await ship(DB, "YT0000000000000001")).registered_at);
  assert.match((await ship(DB, "GFUS000000001")).register_error, /^-18019903/);
  await registerNew(env, { nowMs: NOW + 3600000, fetchImpl: t17, sleep: noSleep });
  assert.equal(log.filter((c) => c.path === "register").length, 1, "nothing left to register the second time");
});

test("register: unknown quota spends nothing", async () => {
  const DB = makeD1();
  const log = [];
  const handler = async (url, init) => {
    log.push(String(url));
    return Response.json({ code: 0, data: {} }); // no quota fields
  };
  await seed(DB, { order: 1, tracking_number: "UL000000001YP" });
  const r = await registerNew({ DB, TRACKING_API_KEY: KEY }, { nowMs: NOW, fetchImpl: handler, sleep: noSleep });
  assert.equal(r.registered, 0);
  assert.ok(!log.some((u) => u.endsWith("/register")));
});

/* ---------------- statuses ---------------- */

test("status mapping: 17TRACK's nine statuses → the internal set; unknown never guessed", () => {
  assert.equal(mapStatus("NotFound"), "awaiting_pickup");
  assert.equal(mapStatus("InfoReceived"), "awaiting_pickup");
  assert.equal(mapStatus("InTransit"), "in_transit");
  assert.equal(mapStatus("OutForDelivery"), "out_for_delivery");
  assert.equal(mapStatus("AvailableForPickup"), "pickup_ready");
  assert.equal(mapStatus("DeliveryFailure"), "failed_attempt");
  assert.equal(mapStatus("Delivered"), "delivered");
  assert.equal(mapStatus("Exception"), "exception");
  assert.equal(mapStatus("Expired"), "expired");
  assert.equal(mapStatus("SomethingNew"), "unknown");
  const s = summarise(trackItem("X", "InTransit", { sub: "InTransit_PickedUp", milestone: [{ key_stage: "PickedUp", time_utc: "2026-10-08T03:00:00Z" }] }));
  assert.equal(s.pickupAt, "2026-10-08T03:00:00.000Z");
  assert.equal(s.deliveredAt, null);
});

/* ---------------- webhook ---------------- */

const sign = (raw, key = KEY) => createHash("sha256").update(`${raw}/${key}`).digest("hex");
const push = (raw, sig) => new Request("https://b.example/webhooks/17track", { method: "POST", body: raw, headers: sig ? { sign: sig } : {} });

test("webhook: refused without a key, without a signature, or with a forged one", async () => {
  const DB = makeD1();
  await seed(DB, { order: 1, tracking_number: "UL000000001YP", registered_at: iso(NOW) });
  const raw = JSON.stringify({ event: "TRACKING_UPDATED", data: { number: "UL000000001YP", track_info: { latest_status: { status: "Delivered" } } } });
  assert.equal((await worker.fetch(push(raw, sign(raw)), { DB })).status, 503, "not wired");
  const env = { DB, TRACKING_API_KEY: KEY };
  assert.equal((await worker.fetch(push(raw, null), env)).status, 401);
  assert.equal((await worker.fetch(push(raw, sign(raw, "WRONGKEY")), env)).status, 401);
  assert.equal((await worker.fetch(push(raw + " ", sign(raw)), env)).status, 401, "body tampered");
  const row = await ship(DB, "UL000000001YP");
  assert.equal(row.push_at, null);
  assert.equal(row.state, null);
  assert.ok((await recentEvents(DB)).some((e) => e.kind === "tracking.push_rejected"));
  assert.equal(await verifyPush(raw, sign(raw), KEY), true);
});

test("webhook: a verified push never writes its own status; known numbers are queued for an API re-read, unknown ignored", async () => {
  const DB = makeD1();
  const env = { DB, TRACKING_API_KEY: KEY };
  await seed(DB, { order: 1, tracking_number: "UL000000001YP", registered_at: iso(NOW - DAY), polled_at: iso(NOW - 3600000), state: "in_transit", last_status: "InTransit" });
  const raw = JSON.stringify({ event: "TRACKING_UPDATED", data: { number: "UL000000001YP", track_info: { latest_status: { status: "Delivered" } } } });
  const res = await worker.fetch(push(raw, sign(raw)), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).queued, 1);
  const row = await ship(DB, "UL000000001YP");
  assert.equal(row.state, "in_transit", "the body's 'Delivered' is not trusted");
  assert.ok(row.push_at);

  const unknown = JSON.stringify({ event: "TRACKING_UPDATED", data: { number: "ZZ999999999ZZ" } });
  const r2 = await worker.fetch(push(unknown, sign(unknown)), env);
  assert.deepEqual(await r2.json(), { ok: true, queued: 0, ignored: 1 });
  assert.equal(await ship(DB, "ZZ999999999ZZ"), null);

  // The next poll re-reads it from the API even though it was polled an hour ago.
  const t17 = fake17({ info: { UL000000001YP: trackItem("UL000000001YP", "InTransit") } });
  const p = await pollTracking({ ...env, BACKUPS: makeR2() }, { nowMs: Date.now(), fetchImpl: t17, sleep: noSleep });
  assert.equal(p.polled, 1);
  assert.equal((await ship(DB, "UL000000001YP")).push_at, null);
});

/* ---------------- pickup line in the KFB message ---------------- */

test("composer: a stuck parcel gets one pickup line (store named), once per order", async () => {
  const DB = makeD1();
  const env = { DB };
  const now = ET("18:45");
  await seed(DB, {
    order: 1231, tracking_number: "UL123456789YP", shipped_at: "2026-10-07T15:00:00Z", order_created_at: "2026-10-05T15:00:00Z",
    registered_at: iso(now - 4 * DAY), state: "awaiting_pickup", last_status: "InfoReceived", polled_at: iso(now - 3600000),
  });
  // Shipped only 2 days ago: not yet.
  await seed(DB, {
    order: 1240, tracking_number: "UL222222222YP", shipped_at: iso(now - 2 * DAY), registered_at: iso(now - DAY),
    state: "awaiting_pickup", last_status: "NotFound", polled_at: iso(now - 3600000),
  });
  // Stuck long enough but its status is stale: not evidence.
  await seed(DB, {
    order: 1241, tracking_number: "UL333333333YP", shipped_at: iso(now - 6 * DAY), registered_at: iso(now - 5 * DAY),
    state: "awaiting_pickup", last_status: "NotFound", polled_at: iso(now - 3 * DAY),
  });
  const r = await runKfbComposer(env, { nowMs: now });
  assert.equal(r.body, "Please check Holt & Crane #1231 (UL123456789YP) — shipped Oct 7, not picked up by the carrier yet.");
  assert.ok((await recentEvents(DB)).some((e) => /carrier pickup check for 1 parcel: Holt & Crane #1231 \(UL123456789YP\)/.test(e.summary)));
  // Next evening: still stuck, but already asked → no repeat.
  await DB.prepare(`UPDATE shipments SET polled_at = ? WHERE tracking_number = 'UL123456789YP'`).bind(iso(ET("18:00", "2026-10-12"))).run();
  const next = await runKfbComposer(env, { nowMs: ET("18:45", "2026-10-12") });
  assert.equal(next.messageId, null);
});

test("composer: express and pickup lines share one message, express first", () => {
  assert.equal(
    composePickupBody([
      { store: "aub", order_name: "#1062", tracking: "YT1", shipped_at: "2026-10-07T15:00:00Z" },
      { store: "hc", order_name: "#1231", tracking: "UL1", shipped_at: "2026-10-06T15:00:00Z" },
    ]),
    "Please check Holt & Crane #1231 (UL1) — shipped Oct 6, not picked up by the carrier yet.\n" +
    "Please check Auberlane #1062 (YT1) — shipped Oct 7, not picked up by the carrier yet."
  );
});

/* ---------------- day 15 / day 20 ---------------- */

test("day math: whole Eastern calendar days, not UTC", () => {
  // 23:30 Eastern on Sep 25 is already Sep 26 in UTC.
  const order = "2026-09-26T03:30:00Z";
  assert.equal(easternDaysSince(order, Date.parse("2026-10-10T16:00:00Z")), 15);
  assert.equal(easternDaysSince(order, Date.parse("2026-10-10T03:59:00Z")), 14, "still Oct 9 in New York");
  assert.equal(easternDaysSince(order, Date.parse("2026-10-15T12:00:00Z")), 20);
});

test("checks: day 15 flag, day 20 flag + one reship/refund approval, never duplicated", async () => {
  const DB = makeD1();
  const env = { DB };
  const order = "2026-09-20T15:00:00Z"; // Sep 20 Eastern
  await seed(DB, { order: 1100, tracking_number: "UL110000000YP", order_created_at: order, registered_at: order, state: "in_transit", last_status: "InTransit", polled_at: iso(Date.parse("2026-10-05T12:00:00Z")) });
  await runChecks(env, { nowMs: Date.parse("2026-10-05T14:00:00Z") }); // day 15
  let flags = (await DB.prepare(`SELECT kind FROM shipment_flags`).all()).results.map((f) => f.kind);
  assert.deepEqual(flags, ["day15"]);
  assert.equal((await listPending(DB)).length, 0);

  const day20 = Date.parse("2026-10-10T14:00:00Z");
  await DB.prepare(`UPDATE shipments SET polled_at = ?`).bind(iso(day20 - 3600000)).run();
  await runChecks(env, { nowMs: day20 });
  await runChecks(env, { nowMs: day20 + 15 * 60000 });
  await runChecks(env, { nowMs: day20 + 2 * 3600000 });
  flags = (await DB.prepare(`SELECT kind, approval_id FROM shipment_flags ORDER BY kind`).all()).results;
  assert.deepEqual(flags.map((f) => f.kind), ["day15", "day20"]);
  const pending = await listPending(DB);
  assert.equal(pending.length, 1, "one approval per order");
  assert.deepEqual(pending[0].options, [{ id: "reship", label: "Reship" }, { id: "refund", label: "Refund" }]);
  assert.match(pending[0].title, /Holt & Crane #1100/);
  assert.equal(flags[1].approval_id, pending[0].id);
  const st = await shippingState({ DB, TRACKING_API_KEY: KEY }, day20);
  assert.equal(st.flags[0].kind, "day20");
  assert.equal(st.flags[0].label, "Escalate: reship or refund");
});

test("checks: a stale status raises nothing; delivered resolves open flags; failed delivery is flagged", async () => {
  const DB = makeD1();
  const env = { DB };
  const now = Date.parse("2026-10-10T14:00:00Z");
  await seed(DB, { order: 1, tracking_number: "UL1YP0000001", order_created_at: "2026-09-15T15:00:00Z", registered_at: "2026-09-17T15:00:00Z", state: "in_transit", last_status: "InTransit", polled_at: iso(now - 3 * DAY) });
  await seed(DB, { order: 2, tracking_number: "UL2YP0000002", state: "failed_attempt", last_status: "DeliveryFailure", polled_at: iso(now - 3600000) });
  await runChecks(env, { nowMs: now });
  const kinds = (await DB.prepare(`SELECT store, order_name, kind FROM shipment_flags`).all()).results;
  assert.deepEqual(kinds.map((k) => `${k.order_name}:${k.kind}`), ["#2:failed_delivery"]);
  assert.ok((await recentEvents(DB)).some((e) => e.kind === "tracking.failed_delivery" && /customer email needed/i.test(e.summary)));
  await DB.prepare(`UPDATE shipments SET delivered_at = ?, state = 'delivered' WHERE tracking_number = 'UL2YP0000002'`).bind(iso(now)).run();
  await runChecks(env, { nowMs: now + 60000 });
  assert.ok((await DB.prepare(`SELECT resolved_at FROM shipment_flags WHERE kind = 'failed_delivery'`).first()).resolved_at);
});

/* ---------------- proof of delivery ---------------- */

test("poll: delivered → proof of delivery saved to R2, verified, pointer on the shipment", async () => {
  const DB = makeD1();
  const BACKUPS = makeR2();
  const env = { DB, BACKUPS, TRACKING_API_KEY: KEY };
  await seed(DB, { order: 1053, tracking_number: "UL105300000YP", registered_at: iso(NOW - 4 * DAY), state: "out_for_delivery", last_status: "OutForDelivery" });
  const delivered = trackItem("UL105300000YP", "Delivered", {
    sub: "Delivered_Other", time: "2026-10-10T14:05:00-04:00", location: "CHARLOTTE, NC 28202",
    milestone: [{ key_stage: "PickedUp", time_utc: "2026-10-02T01:00:00Z" }, { key_stage: "Delivered", time_utc: "2026-10-10T18:05:00Z" }],
  });
  delivered.track_info.misc_info = { signature_name: "J SMITH" };
  const t17 = fake17({ info: { UL105300000YP: delivered } });
  const r = await pollTracking(env, { nowMs: NOW, fetchImpl: t17, sleep: noSleep });
  assert.equal(r.podSaved, 1);
  const row = await ship(DB, "UL105300000YP");
  assert.equal(row.state, "delivered");
  assert.equal(row.delivered_at, "2026-10-10T18:05:00.000Z");
  assert.equal(row.pickup_at, "2026-10-02T01:00:00.000Z");
  assert.match(row.pod, /^backups\/hc\/.*_pod-hc-1053\.json$/);
  assert.ok(await BACKUPS.head(row.pod), "the object is really there");
  const pod = await readBackup(BACKUPS, row.pod);
  assert.equal(pod.data.delivered_event.location, "CHARLOTTE, NC 28202");
  assert.equal(pod.data.signature_or_photo.signature_name, "J SMITH");
  assert.equal(pod.data.order_name, "#1053");
  // Delivered + POD saved: never polled again.
  const again = await pollTracking(env, { nowMs: NOW + 7 * 3600000, fetchImpl: t17, sleep: noSleep });
  assert.equal(again.polled, 0);
  assert.ok((await evaluateFeeds(DB, NOW)).find((f) => f.id === FEED_ID).current === "fresh");
});

test("poll: no backup bucket → no pointer, an error event, and it retries later", async () => {
  const DB = makeD1();
  const env = { DB, TRACKING_API_KEY: KEY };
  await seed(DB, { order: 7, tracking_number: "UL700000000YP", registered_at: iso(NOW - DAY) });
  const t17 = fake17({ info: { UL700000000YP: trackItem("UL700000000YP", "Delivered") } });
  const r = await pollTracking(env, { nowMs: NOW, fetchImpl: t17, sleep: noSleep });
  assert.equal(r.podErrors, 1);
  assert.equal((await ship(DB, "UL700000000YP")).pod, null);
  const later = await pollTracking({ ...env, BACKUPS: makeR2() }, { nowMs: NOW + 2 * 3600000, fetchImpl: t17, sleep: noSleep });
  assert.equal(later.podSaved, 1);
});

test("poll: a number polled less than 6 h ago is left alone", async () => {
  const DB = makeD1();
  const env = { DB, TRACKING_API_KEY: KEY };
  await seed(DB, { order: 8, tracking_number: "UL800000000YP", registered_at: iso(NOW - DAY), polled_at: iso(NOW - 5 * 3600000), state: "in_transit" });
  const log = [];
  const r = await pollTracking(env, { nowMs: NOW, fetchImpl: fake17({ log }), sleep: noSleep });
  assert.equal(r.polled, 0);
  assert.equal(log.length, 0);
});

/* ---------------- cron isolation + feed ---------------- */

test("runTracking: a failing 17TRACK stage doesn't stop the others; feed shows failing", async () => {
  const DB = makeD1();
  const env = { DB, ...HC_CREDS, TRACKING_API_KEY: KEY };
  await ensureFeeds(DB);
  await seed(DB, { order: 9, tracking_number: "UL900000000YP", state: "failed_attempt", last_status: "DeliveryFailure", polled_at: iso(NOW - 3600000), registered_at: iso(NOW - DAY) });
  const broken = async (url, init) => {
    if (String(url).startsWith(API_BASE)) return new Response("down", { status: 500 });
    return router({ orders: [] })(url, init);
  };
  const out = await runTracking(env, { nowMs: NOW, fetchImpl: broken, sleep: noSleep });
  assert.equal(out.collect.ok, true);
  assert.equal(out.register.ok, false);
  assert.equal(out.checks.ok, true, "checks still ran");
  assert.ok((await DB.prepare(`SELECT 1 FROM shipment_flags WHERE kind = 'failed_delivery'`).first()));
  assert.equal((await evaluateFeeds(DB, NOW)).find((f) => f.id === FEED_ID).current, "failing");
  // Collection is hourly: 15 minutes later it doesn't run again.
  const soon = await runTracking(env, { nowMs: NOW + 15 * 60000, fetchImpl: broken, sleep: noSleep });
  assert.equal(soon.collect, undefined);
});

test("feed: not wired without TRACKING_API_KEY, and 17TRACK is never called", async () => {
  const DB = makeD1();
  await ensureFeeds(DB);
  const log = [];
  const f = async (url, init) => { log.push(String(url)); return router({ orders: [] })(url, init); };
  const out = await runTracking({ DB, ...HC_CREDS }, { nowMs: NOW, fetchImpl: f, sleep: noSleep });
  assert.equal(out.poll, undefined);
  assert.ok(!log.some((u) => u.startsWith(API_BASE)));
  assert.equal((await evaluateFeeds(DB, NOW)).find((x) => x.id === FEED_ID).current, "not_wired");
});

test("cron: tracking blowing up doesn't stop the KFB composer or the sentinel", async () => {
  const DB = makeD1();
  // DB that throws on any tracking table, to simulate a broken stage at the outermost level.
  const brokenDB = {
    prepare(sql) {
      if (/shipments|tracking_runs|shipment_flags/.test(sql)) throw new Error("tracking tables unavailable");
      return DB.prepare(sql);
    },
  };
  const env = { DB: brokenDB, TRACKING_API_KEY: KEY };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    const waits = [];
    await worker.scheduled({ cron: "*/15 * * * *" }, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  } finally {
    globalThis.fetch = realFetch;
  }
  const ev = await recentEvents(DB);
  assert.ok(ev.some((e) => /^error\.tracking/.test(e.kind)), "the tracking failure is logged");
  const feeds = await evaluateFeeds(DB);
  assert.ok(feeds.every((f) => f.state), "the sentinel ran after it");
});

test("state: Mission Control gets shipping counts, flags, quota and last sync", async () => {
  const DB = makeD1();
  const env = { DB, MC_KEY: "m".repeat(32), TRACKING_API_KEY: KEY };
  await seed(DB, { order: 1, tracking_number: "UL1000000001", registered_at: iso(Date.now() - DAY), state: "in_transit", last_status: "InTransit", order_created_at: iso(Date.now() - 5 * DAY) });
  await seed(DB, { order: 2, tracking_number: "UL1000000002", order_created_at: iso(Date.now() - 5 * DAY), shipped_at: iso(Date.now() - DAY) });
  await registerNew({ DB, TRACKING_API_KEY: KEY }, { nowMs: Date.now(), fetchImpl: fake17({ remain: 12 }), sleep: noSleep });
  const res = await worker.fetch(new Request("https://b.example/api/state", { headers: { "x-store-brain-key": "m".repeat(32) } }), env);
  const body = await res.json();
  assert.equal(body.shipping.wired, true);
  assert.equal(body.shipping.counts.in_transit, 1);
  assert.equal(body.shipping.counts.not_checked, 1, "registered just now, not polled yet");
  assert.equal(body.shipping.quota.remain, 11);
  assert.equal(body.shipping.quotaLow, true);
  assert.ok(Array.isArray(body.shipping.flags));
  assert.ok(body.feeds.some((f) => f.id === "tracking.17track"));
});

/* ---------------- review fixes (2026-10-11) ---------------- */

const pad = (n) => String(n).padStart(9, "0");

test("fix 1: first run spends the quota newest first, skips Shopify-delivered and 21+ day parcels, stops at the cap", async () => {
  const DB = makeD1();
  const env = { DB, ...HC_CREDS, TRACKING_API_KEY: KEY };
  const log = [];
  const t17 = fake17({ remain: 200, log });
  // Shopify says what it knows: DELIVERED fulfillments are recorded and never registered.
  const orders = [
    orderNode(5001, [{ id: "gid://shopify/Fulfillment/51", createdAt: iso(NOW - 6 * DAY), status: "SUCCESS", displayStatus: "DELIVERED",
      deliveredAt: iso(NOW - DAY), trackingInfo: [{ number: "UL500100000YP" }] }]),
    orderNode(5002, [{ id: "gid://shopify/Fulfillment/52", createdAt: iso(NOW - 6 * DAY), status: "SUCCESS", displayStatus: "IN_TRANSIT",
      deliveredAt: null, trackingInfo: [{ number: "UL500200000YP" }] }]),
  ];
  const gqlLog = [];
  await collectShipments(env, { nowMs: NOW, fetchImpl: router({ orders, gqlLog }) });
  assert.match(gqlLog[0].query, /displayStatus deliveredAt/);
  assert.equal((await ship(DB, "UL500100000YP")).shopify_status, "DELIVERED");
  // 70 more parcels, one shipped every ~6 hours over the last 18 days, plus one shipped 25 days ago.
  for (let i = 0; i < 70; i++) {
    await seed(DB, { order: 6000 + i, tracking_number: `UL${pad(i)}XX`, order_created_at: iso(NOW - (i * 0.25 + 1) * DAY), shipped_at: iso(NOW - i * 0.25 * DAY) });
  }
  await seed(DB, { order: 7000, tracking_number: "ULOLD0000001", order_created_at: iso(NOW - 26 * DAY), shipped_at: iso(NOW - 25 * DAY) });

  const r = await registerNew(env, { nowMs: NOW, fetchImpl: t17, sleep: noSleep });
  assert.equal(r.registered, 60, "first-ever run capped at 60");
  assert.equal(r.reason, "cap_reached");
  const sent = log.filter((c) => c.path === "register").flatMap((c) => c.body.map((b) => b.number));
  assert.ok(sent.includes("UL000000000XX"), "the newest parcel is registered");
  assert.ok(!sent.includes(`UL${pad(69)}XX`), "the oldest waits");
  assert.ok(!sent.includes("UL500100000YP"), "Shopify-delivered parcel never registered");
  assert.ok(!sent.includes("ULOLD0000001"), "21+ day old parcel never registered");
  assert.equal(t17.quota.remain, 140);

  // Held for the cap: said once, not every hour.
  await registerNew(env, { nowMs: NOW + 3600000, fetchImpl: t17, sleep: noSleep });
  const held = (await recentEvents(DB)).filter((e) => e.kind === "tracking.register_held");
  assert.equal(held.length, 1);
  assert.match(held[0].summary, /TRACKING_REGISTER_CAP/);

  const st = await shippingState(env, NOW + 3600000);
  assert.equal(st.notTracked.shopifyDelivered, 1);
  assert.equal(st.notTracked.age, 1);
  assert.equal(st.notTracked.quota, 11, "10 of the 70 + #5002, held by the cap");
  assert.equal(st.counts.not_tracked_quota, 11);
  assert.equal(st.labels.not_tracked_age, "Not tracked (21+ days old)");
  assert.equal(st.registerHold.reason, "cap_reached");

  // Reilly raises the cap: the rest go.
  const r3 = await registerNew({ ...env, TRACKING_REGISTER_CAP: "100" }, { nowMs: NOW + 7200000, fetchImpl: t17, sleep: noSleep });
  assert.equal(r3.registered, 11);
});

test("fix 1: the backlog never spends the last 20 registrations; new parcels can", async () => {
  const DB = makeD1();
  const env = { DB, TRACKING_API_KEY: KEY };
  const t17 = fake17({ remain: 25 });
  for (let i = 0; i < 10; i++) {
    await seed(DB, { order: 8000 + i, tracking_number: `YT${pad(i)}BK`, order_created_at: iso(NOW - (6 + i) * DAY), shipped_at: iso(NOW - (5 + i) * DAY) });
  }
  const r = await registerNew(env, { nowMs: NOW, fetchImpl: t17, sleep: noSleep });
  assert.equal(r.registered, 5, "25 left - 20 reserve");
  assert.equal(r.reason, "reserve_kept");
  assert.ok((await ship(DB, `YT${pad(0)}BK`)).registered_at, "newest of the backlog first");
  assert.equal((await ship(DB, `YT${pad(9)}BK`)).registered_at, null);
  await seed(DB, { order: 8100, tracking_number: "YTNEW0000001", order_created_at: iso(NOW - DAY), shipped_at: iso(NOW - 3600000) });
  const r2 = await registerNew(env, { nowMs: NOW + 3600000, fetchImpl: t17, sleep: noSleep });
  assert.equal(r2.registered, 1, "a new parcel uses the reserve");
  assert.ok((await ship(DB, "YTNEW0000001")).registered_at);
  assert.equal(t17.quota.remain, 19);
});

test("fix 2: multi-parcel orders reach day 15 / day 20 — delivered parcels don't block, untracked parcels still count", async () => {
  const DB = makeD1();
  const env = { DB };
  const order = "2026-09-20T15:00:00Z";
  const now = Date.parse("2026-10-10T14:00:00Z"); // day 20
  const fresh = iso(now - 3600000);
  // A: one parcel delivered long ago (never re-polled), one in transit with a fresh status.
  await seed(DB, { order: 2001, tracking_number: "UL200100001YP", order_created_at: order, registered_at: order, state: "delivered", delivered_at: "2026-09-30T12:00:00Z", polled_at: "2026-09-30T13:00:00Z" });
  await seed(DB, { order: 2001, tracking_number: "UL200100002YP", order_created_at: order, registered_at: order, state: "in_transit", last_status: "InTransit", polled_at: fresh });
  // B: one delivered, one never registered (quota) — still flagged, from the order date.
  await seed(DB, { order: 2002, tracking_number: "UL200200001YP", order_created_at: order, registered_at: order, state: "delivered", delivered_at: "2026-09-30T12:00:00Z", polled_at: "2026-09-30T13:00:00Z" });
  await seed(DB, { order: 2002, tracking_number: "UL200200002YP", order_created_at: order, shipped_at: "2026-09-25T12:00:00Z" });
  // C: rejected by 17TRACK — flagged too.
  await seed(DB, { order: 2003, tracking_number: "UL200300001YP", order_created_at: order, register_error: "-18019903: nope" });
  // D: registered but its status is stale — not evidence, nothing raised.
  await seed(DB, { order: 2004, tracking_number: "UL200400001YP", order_created_at: order, registered_at: order, state: "in_transit", polled_at: iso(now - 3 * DAY) });
  // E: Shopify says delivered (never tracked) — not late.
  await seed(DB, { order: 2005, tracking_number: "UL200500001YP", order_created_at: order, shopify_status: "DELIVERED" });

  await runChecks(env, { nowMs: now });
  const flags = (await DB.prepare(`SELECT order_name, kind, detail FROM shipment_flags ORDER BY order_name, kind`).all()).results;
  assert.deepEqual(flags.map((f) => `${f.order_name}:${f.kind}`),
    ["#2001:day15", "#2001:day20", "#2002:day15", "#2002:day20", "#2003:day15", "#2003:day20"]);
  const b = flags.find((f) => f.order_name === "#2002" && f.kind === "day15");
  assert.match(b.detail, /UL200200002YP: not tracked by 17TRACK \(not registered: quota or cap\); 1 other parcel delivered/);
  assert.match(flags.find((f) => f.order_name === "#2003").detail, /not tracked by 17TRACK \(17TRACK rejected the number\)/);
  assert.equal((await listPending(DB)).length, 3);
});

test("fix 3: a day-20 approval half-written by a crashed run is re-linked, never duplicated", async () => {
  const DB = makeD1();
  let failApprovalLog = true;
  // The approval row is written, then its event log fails: createApproval throws.
  const flaky = {
    prepare(sql) {
      const st = DB.prepare(sql);
      if (!/INSERT INTO events/.test(sql)) return st;
      const bind = st.bind;
      st.bind = (...a) => {
        if (failApprovalLog && a.includes("approval.requested")) { failApprovalLog = false; throw new Error("log down"); }
        return bind(...a);
      };
      return st;
    },
  };
  const order = "2026-09-20T15:00:00Z";
  const now = Date.parse("2026-10-10T14:00:00Z");
  await seed(DB, { order: 3001, tracking_number: "UL300100000YP", order_created_at: order, registered_at: order, state: "in_transit", last_status: "InTransit", polled_at: iso(now - 3600000) });
  await assert.rejects(runChecks({ DB: flaky }, { nowMs: now }), /log down/);
  assert.equal((await listPending(DB)).length, 1, "the approval row did get written");
  const flag = await DB.prepare(`SELECT approval_id FROM shipment_flags WHERE kind = 'day20'`).first();
  assert.equal(flag.approval_id, null, "flag kept (not deleted), not linked yet");

  const r = await runChecks({ DB: flaky }, { nowMs: now + 15 * 60000 });
  assert.deepEqual(r.raised, ["day20_relinked"]);
  await runChecks({ DB: flaky }, { nowMs: now + 30 * 60000 });
  const pending = await listPending(DB);
  assert.equal(pending.length, 1, "still one approval");
  assert.equal((await DB.prepare(`SELECT approval_id FROM shipment_flags WHERE kind = 'day20'`).first()).approval_id, pending[0].id);
});

test("fix 4: stuck pickup is per parcel — a second parcel stuck later is raised and asked about; clearing one doesn't clear the other", async () => {
  const DB = makeD1();
  const env = { DB };
  const day1 = ET("18:45", "2026-10-11");
  await seed(DB, { order: 4001, tracking_number: "UL400100001YP", order_created_at: "2026-10-05T15:00:00Z", shipped_at: "2026-10-07T15:00:00Z",
    registered_at: iso(day1 - 4 * DAY), state: "awaiting_pickup", last_status: "InfoReceived", polled_at: iso(day1 - 3600000) });
  await seed(DB, { order: 4001, tracking_number: "UL400100002YP", order_created_at: "2026-10-05T15:00:00Z", shipped_at: "2026-10-10T15:00:00Z",
    registered_at: iso(day1 - DAY), state: "awaiting_pickup", last_status: "NotFound", polled_at: iso(day1 - 3600000) });
  await runChecks(env, { nowMs: day1 });
  let f = await DB.prepare(`SELECT * FROM shipment_flags WHERE kind = 'stuck_pickup'`).first();
  assert.ok(f && !f.resolved_at);
  assert.match(f.detail, /UL400100001YP/);
  assert.doesNotMatch(f.detail, /UL400100002YP/);
  const k1 = await runKfbComposer(env, { nowMs: day1 });
  assert.equal(k1.body, "Please check Holt & Crane #4001 (UL400100001YP) — shipped Oct 7, not picked up by the carrier yet.");

  // Three days later: parcel 1 was scanned, parcel 2 is now stuck.
  const day4 = ET("18:45", "2026-10-14");
  await DB.prepare(`UPDATE shipments SET state = 'in_transit', last_status = 'InTransit', polled_at = ? WHERE tracking_number = 'UL400100001YP'`).bind(iso(day4 - 3600000)).run();
  await DB.prepare(`UPDATE shipments SET polled_at = ? WHERE tracking_number = 'UL400100002YP'`).bind(iso(day4 - 3600000)).run();
  const r = await runChecks(env, { nowMs: day4 });
  assert.ok(r.raised.includes("stuck_pickup"), "the second parcel is raised");
  f = await DB.prepare(`SELECT * FROM shipment_flags WHERE kind = 'stuck_pickup'`).first();
  assert.equal(f.resolved_at, null, "order stays flagged while parcel 2 is stuck");
  assert.match(f.detail, /UL400100002YP/);
  assert.doesNotMatch(f.detail, /UL400100001YP/);
  assert.ok((await DB.prepare(`SELECT resolved_at FROM parcel_pickup_flags WHERE tracking_number = 'UL400100001YP'`).first()).resolved_at);
  const k2 = await runKfbComposer(env, { nowMs: day4 });
  assert.equal(k2.body, "Please check Holt & Crane #4001 (UL400100002YP) — shipped Oct 10, not picked up by the carrier yet.");
  const kinds = (await DB.prepare(`SELECT kind FROM kfb_message_items ORDER BY kind`).all()).results.map((x) => x.kind);
  assert.deepEqual(kinds, ["pickup:UL400100001YP", "pickup:UL400100002YP"]);

  // Parcel 2 scanned too: the order's flag clears.
  const day5 = day4 + DAY;
  await DB.prepare(`UPDATE shipments SET state = 'in_transit', polled_at = ? WHERE tracking_number = 'UL400100002YP'`).bind(iso(day5 - 3600000)).run();
  await DB.prepare(`UPDATE shipments SET polled_at = ? WHERE tracking_number = 'UL400100001YP'`).bind(iso(day5 - 3600000)).run();
  await runChecks(env, { nowMs: day5 });
  assert.ok((await DB.prepare(`SELECT resolved_at FROM shipment_flags WHERE kind = 'stuck_pickup'`).first()).resolved_at);
});

test("fix 4: an old per-order pickup line still counts as asked for the numbers it listed", async () => {
  const DB = makeD1();
  const now = ET("18:45");
  await seed(DB, { order: 4100, tracking_number: "UL410000001YP", order_created_at: "2026-10-05T15:00:00Z", shipped_at: "2026-10-07T15:00:00Z",
    registered_at: iso(now - 4 * DAY), state: "awaiting_pickup", last_status: "InfoReceived", polled_at: iso(now - 3600000) });
  await DB.prepare(`INSERT INTO kfb_message_items (message_id, store, order_id, order_name, kind, detail) VALUES (1, 'hc', 'gid://shopify/Order/4100', '#4100', 'pickup', 'UL410000001YP; shipped 2026-10-07')`).run();
  const r = await runKfbComposer({ DB }, { nowMs: now });
  assert.equal(r.messageId, null);
});

test("fix 5: bad-signature pushes are counted, not logged one by one (at most one summary an hour)", async () => {
  const DB = makeD1();
  const env = { DB, TRACKING_API_KEY: KEY };
  const raw = JSON.stringify({ event: "TRACKING_UPDATED", data: { number: "UL000000001YP" } });
  for (let i = 0; i < 50; i++) {
    const res = await handleTrackingPush(push(raw, "forged"), env, NOW + i * 1000);
    assert.equal(res.status, 401);
  }
  let ev = (await recentEvents(DB)).filter((e) => e.kind === "tracking.push_rejected");
  assert.equal(ev.length, 1, "one event for 50 refusals");
  assert.equal((await shippingState(env, NOW)).pushesRefused.sinceLastReport, 49);
  await handleTrackingPush(push(raw, "forged"), env, NOW + 61 * 60000);
  ev = (await recentEvents(DB)).filter((e) => e.kind === "tracking.push_rejected");
  assert.equal(ev.length, 2);
  assert.ok(ev.some((e) => /Refused 50 tracking pushes/.test(e.summary)), "the summary carries the count");
});
