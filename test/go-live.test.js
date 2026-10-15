/**
 * Go-live (Reilly, 2026-10-14: "i want to move EVERYTHING in the brain to live so its all
 * working - can we do that"): the live/shadow labels follow the real switches, and the urgent
 * phone alerts are rate-limited, once per item, free of emails, and only logged when switched off.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeD1 } from "./helpers/d1.js";

import { modeFor, liveMeans, isLive, liveSwitches, agentStatus, LIVE_SWITCHES } from "../src/config/live.js";
import { agentsWithMode, AGENTS } from "../src/config/agents.js";
import { runPhoneAlerts, alertFor, ALERT_CAP_PER_DAY, scrubAlertText } from "../src/lib/phoneAlerts.js";
import { logEvent } from "../src/lib/eventlog.js";
import { createApproval } from "../src/lib/approvals.js";
import { SEED_DECISIONS, seedDecisions, currentDecision } from "../src/agents/core/decisions.js";
import { coreState } from "../src/agents/core/index.js";
import { riskState } from "../src/agents/risk/index.js";
import { csState } from "../src/agents/cs/index.js";
import { draftsLive } from "../src/agents/cs/replyWriter.js";
import { briefMode } from "../src/lib/brief.js";
import { supplierMode } from "../src/lib/kfbMessage.js";
import { kfbReminderMode } from "../src/lib/kfbImport.js";

const T0 = Date.parse("2026-10-15T16:00:00Z"); // noon in New York
const iso = (ms) => new Date(ms).toISOString();
const ALL_ON = Object.fromEntries(LIVE_SWITCHES.map((s) => [s.env, "1"]));

/** A Pushover stand-in that records every message it is asked to send. */
function pushover({ fail = 0 } = {}) {
  const sent = [];
  let failsLeft = fail;
  const fetchImpl = async (url, init) => {
    const body = Object.fromEntries(new URLSearchParams(init.body));
    if (failsLeft > 0) { failsLeft--; return { ok: false, status: 500, json: async () => ({ status: 0 }) }; }
    sent.push(body);
    return { ok: true, status: 200, json: async () => ({ status: 1 }) };
  };
  return { sent, fetchImpl, calls: () => sent.length };
}

function alertEnv(DB, extra = {}) {
  return {
    DB, PUSHOVER_APP_TOKEN: "app-token-x", PUSHOVER_USER_KEY: "user-key-x", APPROVAL_SIGNING_KEY: "s".repeat(40),
    PUBLIC_BASE_URL: "https://brain.test", PHONE_ALERTS_LIVE: "1", ...extra,
  };
}

const fraud = (DB, n, { approvalId = null, at = T0 - 5 * 60000, extra = "" } = {}) => logEvent(DB, {
  actor: "risk.fraud", kind: "risk.order_high", store: "hc", at: iso(at),
  summary: `HIGH-risk: #${1000 + n} ($120.00): Shopify rates this order HIGH risk${extra}`,
  data: { orderId: `gid://shopify/Order/${n}`, level: "HIGH", approvalId },
});
const rows = async (DB) => (await DB.prepare(`SELECT * FROM phone_alerts ORDER BY id`).all()).results;
const evs = async (DB, kind) => (await DB.prepare(`SELECT * FROM events WHERE kind = ? ORDER BY id`).bind(kind).all()).results;

/* ---------------- the decision ---------------- */

test("go-live: Reilly's words are seeded verbatim as core.go_live", async () => {
  const s = SEED_DECISIONS.find((d) => d.topic === "core.go_live");
  assert.ok(s);
  assert.equal(s.words, "i want to move EVERYTHING in the brain to live so its all working - can we do that");
  assert.equal(s.scope, "all");
  assert.equal(s.source, "chat 2026-10-14");
  assert.equal(s.at, "2026-10-15T00:46:00Z");
  const DB = makeD1();
  await seedDecisions(DB, { nowMs: T0 });
  assert.equal((await currentDecision(DB, "core.go_live")).words, s.words);
});

test("go-live: wrangler.toml sets every live switch to \"1\" inside [vars]", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const vars = toml.slice(toml.indexOf("[vars]"));
  for (const s of LIVE_SWITCHES) assert.match(vars, new RegExp(`^${s.env} = "1"$`, "m"), s.env);
  assert.match(toml, /^keep_vars = true$/m);
});

/* ---------------- modes follow the switches ---------------- */

test("modes: each area follows its own switch; nothing set = shadow everywhere", async () => {
  assert.equal(isLive({}), false);
  for (const a of ["reports", "core", "media", "catalog", "risk", "pnl", "fulfillment", "cs", "brief", "supplier", "kfb_reminder", "alerts"]) {
    assert.equal(modeFor({}, a), "shadow", a);
  }
  assert.equal(modeFor(ALL_ON, "nonsense"), "shadow", "an unknown area is never live");

  const only = (name) => ({ [name]: "1" });
  assert.equal(modeFor(only("CS_DRAFTS_LIVE"), "cs"), "live");
  assert.equal(modeFor(only("CS_DRAFTS_LIVE"), "brief"), "shadow");
  assert.equal(modeFor(only("BRIEF_PHONE_LIVE"), "brief"), "live");
  assert.equal(modeFor(only("SUPPLIER_MESSAGES_LIVE"), "supplier"), "live");
  assert.equal(modeFor(only("KFB_REMINDER_LIVE"), "kfb_reminder"), "live");
  assert.equal(modeFor(only("PHONE_ALERTS_LIVE"), "alerts"), "live");
  assert.equal(modeFor(only("GO_LIVE"), "risk"), "live");
  assert.equal(modeFor(only("GO_LIVE"), "cs"), "shadow", "GO_LIVE alone never makes Gmail drafts live");
  assert.equal(modeFor({ GO_LIVE: "0" }, "core"), "shadow");
  assert.equal(isLive(only("GO_LIVE")), true);

  // The older per-area helpers read the same switches.
  assert.equal(briefMode(only("BRIEF_PHONE_LIVE")), "live");
  assert.equal(supplierMode(only("SUPPLIER_MESSAGES_LIVE")), "live");
  assert.equal(kfbReminderMode(only("KFB_REMINDER_LIVE")), "live");
  assert.equal(draftsLive(only("CS_DRAFTS_LIVE")), true);
  assert.equal(draftsLive({ CS_DRAFTS_LIVE: "0" }), false);

  assert.match(liveMeans(ALL_ON, "cs"), /DRAFTS/);
  assert.match(liveMeans(ALL_ON, "cs"), /Nothing is ever sent/);

  const v = liveSwitches({ GO_LIVE: "1", CS_DRAFTS_LIVE: "0" });
  assert.equal(v.switches.find((s) => s.env === "GO_LIVE").mode, "live");
  assert.equal(v.switches.find((s) => s.env === "CS_DRAFTS_LIVE").value, "0");
  assert.equal(v.switches.find((s) => s.env === "PHONE_ALERTS_LIVE").value, null);
  assert.match(v.howToTurnOff, /set it to 0/);
});

test("modes: department pages report the truthful mode", async () => {
  const DB = makeD1();
  assert.equal((await coreState({ DB }, { nowMs: T0 })).mode, "shadow");
  const live = await coreState({ DB, GO_LIVE: "1" }, { nowMs: T0 });
  assert.equal(live.mode, "live");
  assert.ok(live.live_means);
  assert.equal((await riskState({ DB, GO_LIVE: "1" }, { nowMs: T0 })).mode, "live");
  assert.equal((await csState({ DB, GO_LIVE: "1" }, { nowMs: T0 })).mode, "shadow", "CS follows CS_DRAFTS_LIVE, not GO_LIVE");
  assert.equal((await csState({ DB, CS_DRAFTS_LIVE: "1" }, { nowMs: T0 })).mode, "live");
});

test("modes: agents are live only when their switch is on; the build status is kept apart", () => {
  const byId = (list) => Object.fromEntries(list.map((a) => [a.id, a]));
  const off = byId(agentsWithMode({}));
  assert.equal(off["core.router"].status, "built");
  assert.equal(off["pnl.sheets"].status, "live", "live on Reilly's own words before go-live");

  const go = byId(agentsWithMode({ GO_LIVE: "1" }));
  assert.equal(go["core.router"].status, "live");
  assert.equal(go["core.router"].build, "built");
  assert.equal(go["risk.chargebacks"].status, "live");
  assert.equal(go["cs.reply_writer"].status, "built", "Gmail drafts have their own switch");
  assert.equal(go["core.briefer"].status, "built", "the phone brief has its own switch");
  assert.equal(go["sup.relay"].status, "built");
  assert.equal(go["cat.feed_health"].status, "live", "Merchant Center Health is built (GMC ids set 2026-10-14)");
  assert.equal(agentStatus({ id: "x.future", status: "planned" }, { GO_LIVE: "1" }), "planned", "a planned agent is never live");

  const all = byId(agentsWithMode(ALL_ON));
  for (const a of AGENTS) {
    if (a.status === "planned") assert.equal(all[a.id].status, "planned");
    else assert.equal(all[a.id].status, "live", a.id);
  }
  assert.match(all["cs.reply_writer"].liveMeans, /DRAFTS/);
  assert.equal(agentStatus({ id: "x.y", status: "off" }, ALL_ON), "off");
});

test("dashboard: the go-live box shows the real switches (read-only) and the page script parses", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.ok(!html.includes("The go-live switches arrive with the next build"));
  assert.ok(!html.includes("shadow everywhere"));
  assert.match(html, /function liveSwitchesBox\(area\)/);
  assert.match(html, /Live switches \(only you\)/);
  const block = html.slice(html.indexOf("/* ---- Live switches"), html.indexOf("function agentDetail(id){"));
  for (const s of block.match(/'(?:[^'\\\n]|\\.)*'/g) || []) assert.ok(!/\\'/.test(s), `escaped apostrophe in ${s}`);
  assert.doesNotThrow(() => new Function(html.match(/<script>([\s\S]*)<\/script>/)[1]));
});

/* ---------------- urgent phone alerts ---------------- */

test("alerts: at most 6 a day in total, and each item once, even across runs", async () => {
  const DB = makeD1();
  const env = alertEnv(DB);
  const p = pushover();
  for (let i = 1; i <= ALERT_CAP_PER_DAY + 2; i++) await fraud(DB, i);
  const r1 = await runPhoneAlerts(env, { nowMs: T0, fetchImpl: p.fetchImpl });
  assert.equal(r1.sent, ALERT_CAP_PER_DAY);
  assert.equal(r1.capped, 2);
  assert.equal(p.calls(), ALERT_CAP_PER_DAY);
  assert.equal((await evs(DB, "phone.alert_capped")).length, 2);

  // The same order flagged again (a re-screen) is the same item: never a second alert.
  await fraud(DB, 1, { at: T0 + 60000 });
  await fraud(DB, 7, { at: T0 + 60000 }); // capped earlier: stays capped, not retried
  const r2 = await runPhoneAlerts(env, { nowMs: T0 + 15 * 60000, fetchImpl: p.fetchImpl });
  assert.equal(r2.sent, 0);
  assert.equal(r2.duplicate, 2);
  assert.equal(p.calls(), ALERT_CAP_PER_DAY);
  assert.equal((await evs(DB, "phone.alert_capped")).length, 2, "a capped item is announced once");

  // A new New York day has its own 6.
  await fraud(DB, 50, { at: T0 + 24 * 3600000 });
  const r3 = await runPhoneAlerts(env, { nowMs: T0 + 24 * 3600000 + 60000, fetchImpl: p.fetchImpl });
  assert.equal(r3.sent, 1);
  const all = await rows(DB);
  assert.equal(new Set(all.map((x) => x.item_key)).size, all.length);
});

test("alerts: the spend alarm alerts once per type per store per day; a far-off chargeback does not alert", async () => {
  const DB = makeD1();
  const env = alertEnv(DB);
  const p = pushover();
  const spend = (type, at) => logEvent(DB, { actor: "media.spend_alarm", kind: "media.spend_alarm", store: "aub", at: iso(at),
    summary: `Auberlane: alarm ${type}`, data: { day: "2026-10-15", type, alarms: [type], spend_today: 0, usual_day: 85.5 } });
  await spend("stopped", T0 - 60000);
  await spend("stopped", T0 - 30000);
  await spend("no_orders", T0 - 20000);
  await logEvent(DB, { actor: "risk.chargebacks", kind: "risk.dispute_reminder", store: "hc", at: iso(T0 - 10000),
    summary: "Reminder: #1098 chargeback ($45.00) evidence due Oct 22, 7 days left.", data: { disputeId: "d1", daysLeft: 7, threshold: 7, approvalId: 3 } });
  const r = await runPhoneAlerts(env, { nowMs: T0, fetchImpl: p.fetchImpl });
  assert.equal(r.sent, 2);
  assert.equal(r.duplicate, 1);
  assert.match(p.sent[0].title, /Ad spend stopped: Auberlane/);
  assert.match(p.sent[0].message, /\$85\.50 a day/);
  assert.match(p.sent[0].message, /Watch only/);
  assert.equal(p.sent[0].url, "https://brain.test/#/agents/page/media");
});

test("alerts: a chargeback due within 48 h links to its signed approval page; an incident ask alerts too", async () => {
  const DB = makeD1();
  const env = alertEnv(DB);
  const p = pushover();
  const ap = await createApproval(DB, { dept: "risk", requestedBy: "risk.chargebacks", store: "hc", title: "Chargeback #1098", options: [{ id: "will_submit", label: "I'll submit" }] });
  await logEvent(DB, { actor: "risk.chargebacks", kind: "risk.dispute_reminder", store: "hc", at: iso(T0 - 10000),
    summary: "Reminder: #1098 chargeback ($45.00) evidence due Oct 17, 2 days left. Evidence draft is ready to review.", data: { disputeId: "d1", daysLeft: 2, threshold: 2, approvalId: ap } });
  await createApproval(DB, { dept: "core", requestedBy: "core.incidents", title: "Ongoing problem: pnl.pullers (error.order_pull) has failed 5 times since 2026-10-15 10:00 UTC and its retries haven't fixed it. Latest: x", options: [{ id: "seen", label: "Seen" }] });
  const r = await runPhoneAlerts(env, { nowMs: T0, fetchImpl: p.fetchImpl });
  assert.equal(r.sent, 2);
  const cb = p.sent.find((m) => /Chargeback/.test(m.title));
  assert.match(cb.message, /#1098 chargeback \(\$45\.00\), evidence due in 2 days/);
  assert.match(cb.url, new RegExp(`^https://brain\\.test/approve/${ap}\\?exp=\\d+&sig=[0-9a-f]+$`));
  const inc = p.sent.find((m) => /Ongoing problem/.test(m.title));
  assert.match(inc.message, /pnl\.pullers keeps failing \(error\.order_pull, 5 times\)/);
  assert.match(inc.url, /\/approve\/\d+\?exp=/);
});

test("alerts: never include an email address (or a secret), whatever the source text says", async () => {
  const DB = makeD1();
  const env = alertEnv(DB);
  const p = pushover();
  await fraud(DB, 1, { extra: "; billing email jane.doe@example.com differs from shipping" });
  await logEvent(DB, { actor: "cs.reply_writer", kind: "cs.draft_guard_stop", store: "hc", at: iso(T0 - 60000),
    summary: "Gmail drafts NOT made in hc: it is connected as a different account than expected (reillyworking26@gmail.com). Hard stop" });
  await logEvent(DB, { actor: "svc.store_guard", kind: "store.check_failed", store: "mar", at: iso(T0 - 60000),
    summary: "Marlowe Standard: connection check failed: STORE MISMATCH: expected x but the token belongs to owner@shop.com", data: { code: "STORE_MISMATCH" } });
  await logEvent(DB, { actor: "pnl.sheets", kind: "error.store_timezone", store: "aub", at: iso(T0 - 60000),
    summary: "Auberlane: Shopify says Europe/London", data: { shopify: "Europe/London", config: "America/New_York" } });
  await createApproval(DB, { dept: "core", requestedBy: "core.incidents", title: "Ongoing problem: cs.triage (error.cs_read) has failed 3 times since 2026-10-15 10:00 UTC and its retries haven't fixed it. Latest: mail from bob@customer.com unreadable", options: [{ id: "seen", label: "Seen" }] });
  const r = await runPhoneAlerts(env, { nowMs: T0, fetchImpl: p.fetchImpl });
  assert.equal(r.sent, 5);
  for (const m of p.sent) {
    const text = `${m.title} ${m.message} ${m.url || ""}`;
    assert.ok(!/@/.test(text), `no email in: ${text}`);
    assert.ok(!/jane|bob|Doe/i.test(text), `no customer name in: ${text}`);
    assert.ok(!text.includes("app-token-x") && !text.includes("user-key-x") && !text.includes("s".repeat(40)), "no secret in the text");
  }
  for (const row of await rows(DB)) assert.ok(!/@/.test(`${row.title} ${row.message}`));
  assert.equal(scrubAlertText("write to a.b+c@d-e.co.uk now"), "write to [email removed] now");
  assert.equal(alertFor({ kind: "risk.dispute_reminder", data: { disputeId: "x", daysLeft: 3 } }), null, "more than 48 h out: not urgent");
});

test("alerts: switched off, they are only logged: nothing reaches Pushover", async () => {
  const DB = makeD1();
  const env = alertEnv(DB, { PHONE_ALERTS_LIVE: "0" });
  const p = pushover();
  await fraud(DB, 1);
  await fraud(DB, 2);
  const r = await runPhoneAlerts(env, { nowMs: T0, fetchImpl: p.fetchImpl });
  assert.equal(r.mode, "shadow");
  assert.equal(r.shadow, 2);
  assert.equal(p.calls(), 0);
  assert.deepEqual((await rows(DB)).map((x) => x.status), ["shadow", "shadow"]);
  const logged = await evs(DB, "phone.alert_shadow");
  assert.equal(logged.length, 2);
  assert.match(logged[0].summary, /shadow, not sent/);
  assert.equal((await evs(DB, "phone.alert_sent")).length, 0);

  // Unset behaves the same as "0".
  const DB2 = makeD1();
  const env2 = alertEnv(DB2);
  delete env2.PHONE_ALERTS_LIVE;
  await fraud(DB2, 1);
  await runPhoneAlerts(env2, { nowMs: T0, fetchImpl: p.fetchImpl });
  assert.equal(p.calls(), 0);
});

test("alerts: a send Pushover refuses is retried on the next run, then never repeated", async () => {
  const DB = makeD1();
  const env = alertEnv(DB);
  const p = pushover({ fail: 1 });
  await fraud(DB, 1);
  const r1 = await runPhoneAlerts(env, { nowMs: T0, fetchImpl: p.fetchImpl });
  assert.equal(r1.failed, 1);
  assert.equal((await rows(DB))[0].status, "failed");
  const r2 = await runPhoneAlerts(env, { nowMs: T0 + 15 * 60000, fetchImpl: p.fetchImpl });
  assert.equal(r2.retried, 1);
  assert.equal(r2.sent, 1);
  const r3 = await runPhoneAlerts(env, { nowMs: T0 + 30 * 60000, fetchImpl: p.fetchImpl });
  assert.equal(r3.sent + r3.retried, 0);
  assert.equal(p.calls(), 1);
});

test("state: Mission Control gets the switches (values, read-only), today's alerts and each agent's real status", async () => {
  const { default: worker } = await import("../src/index.js");
  const DB = makeD1();
  const env = { DB, MC_KEY: "m".repeat(32), ...ALL_ON, CS_DRAFTS_LIVE: "0" };
  const res = await worker.fetch(new Request("https://b.example/api/state", { headers: { "x-store-brain-key": "m".repeat(32) } }), env);
  const body = await res.json();
  assert.equal(body.live.switches.length, LIVE_SWITCHES.length);
  assert.equal(body.live.switches.find((s) => s.env === "CS_DRAFTS_LIVE").mode, "shadow");
  assert.equal(body.alerts.mode, "live");
  assert.equal(body.alerts.cap, ALERT_CAP_PER_DAY);
  const a = (id) => body.agents.find((x) => x.id === id);
  assert.equal(a("risk.fraud").status, "live");
  assert.equal(a("risk.fraud").build, "built");
  assert.equal(a("cs.reply_writer").status, "built");
});

test("alerts: the first run does not replay old history", async () => {
  const DB = makeD1();
  const env = alertEnv(DB);
  const p = pushover();
  await fraud(DB, 1, { at: T0 - 3 * 3600000 }); // before go-live: history
  await fraud(DB, 2, { at: T0 - 10 * 60000 });  // just now: still alerts
  const r = await runPhoneAlerts(env, { nowMs: T0, fetchImpl: p.fetchImpl });
  assert.equal(r.sent, 1);
  assert.match(p.sent[0].message, /#1002/);
});
