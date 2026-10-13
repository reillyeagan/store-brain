import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";

import { recordDecision, listDecisions, seedDecisions, SEED_DECISIONS, decisionsState, currentDecision } from "../src/agents/core/decisions.js";
import { checkFacts, queueVaultSync, vaultOutbox, markVaultCopied, runLibrarian, weeklyReport, fromVault } from "../src/agents/core/librarian.js";
import { runAuditor, auditPnlRows, RELOG_HOURS } from "../src/agents/core/auditor.js";
import { runIncidents, incidentsState } from "../src/agents/core/incidents.js";
import { routeEvent, runRouter, canReceive } from "../src/agents/core/router.js";
import { runCore, coreState } from "../src/agents/core/index.js";
import { logEvent } from "../src/lib/eventlog.js";
import { createApproval } from "../src/lib/approvals.js";
import { PARCEL_TRACKING_DECISION } from "../src/config/stores.js";

const T0 = Date.parse("2026-10-13T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const evs = async (DB, kind) => (await DB.prepare(`SELECT * FROM events WHERE kind = ? ORDER BY id`).bind(kind).all()).results;
const count = async (DB, sql, ...b) => (await DB.prepare(sql).bind(...b).first()).n;

async function fact(DB, { store = null, key, value, source = "api:test", observed_at = "2026-10-01T00:00:00Z", stale_after = null, live = 1 }) {
  await DB.prepare(`INSERT INTO core_facts (store, area, key, value, kind, source, observed_at, stale_after, live) VALUES (?, 'rule', ?, ?, 'rule', ?, ?, ?, ?)`)
    .bind(store, key, value, source, observed_at, stale_after, live).run();
}

/* ---------------- Decision Keeper ---------------- */

test("decisions: recorded verbatim, the next one on a topic supersedes it, the same words aren't recorded twice", async () => {
  const DB = makeD1();
  const a = await recordDecision(DB, { topic: "pricing.ceiling", words: "max price 144.95 all 3 stores" }, { nowMs: T0 });
  assert.equal(a.created, true);
  const again = await recordDecision(DB, { topic: "pricing.ceiling", words: "max price 144.95 all 3 stores" }, { nowMs: T0 });
  assert.equal(again.created, false);
  const b = await recordDecision(DB, { topic: "pricing.ceiling", words: "max price 154.95 all 3 stores  " }, { nowMs: T0 + 1000 });
  assert.equal(b.supersedes, a.id);
  const cur = await currentDecision(DB, "pricing.ceiling");
  assert.equal(cur.words, "max price 154.95 all 3 stores  "); // verbatim, not trimmed or "fixed"
  const list = await listDecisions(DB, { topic: "pricing.ceiling" });
  assert.equal(list.length, 2);
  assert.equal(list.find((d) => d.id === a.id).current, false);
  assert.equal(list.find((d) => d.id === b.id).current, true);
  await assert.rejects(() => recordDecision(DB, { topic: "x", words: "  " }));
  assert.equal((await evs(DB, "decision.recorded")).length, 2);
});

test("decisions: the seed is inserted once, includes the parcel-tracking decision, and never overrules Reilly's later words", async () => {
  const DB = makeD1();
  await recordDecision(DB, { topic: "cs.reviews", words: "actually do follow up on 1 star reviews" }, { nowMs: T0 });
  const first = await seedDecisions(DB, { nowMs: T0 });
  assert.equal(first.added, SEED_DECISIONS.length - 1);
  const second = await seedDecisions(DB, { nowMs: T0 });
  assert.equal(second.added, 0);
  assert.equal((await currentDecision(DB, "cs.reviews")).words, "actually do follow up on 1 star reviews");
  assert.equal((await currentDecision(DB, "parcel_tracking")).words, PARCEL_TRACKING_DECISION.words);
  const st = await decisionsState(DB);
  assert.equal(st.total, SEED_DECISIONS.length);
});

/* ---------------- Librarian ---------------- */

test("librarian: finds missing values, stale facts, contradictions with the config/spec and conflicting live facts", () => {
  const facts = [
    { id: 1, store: "hc", key: "pricing.floor_price", value: "39.95", observed_at: "2026-10-01T00:00:00Z" },
    { id: 2, store: "mar", key: "price.max", value: "{\"usd\":144.95}", observed_at: "2026-10-01T00:00:00Z" },
    { id: 3, store: "aub", key: "kfb.shop_code", value: "\"zzz-99\"", observed_at: "2026-10-01T00:00:00Z" },
    { id: 4, store: null, key: "note.empty", value: "", observed_at: "2026-10-01T00:00:00Z" },
    { id: 5, store: null, key: "old.thing", value: "x", observed_at: "2025-01-01T00:00:00Z" },
    { id: 6, store: "hc", key: "cs.tone", value: "short", observed_at: "2026-10-01T00:00:00Z" },
    { id: 7, store: "hc", key: "cs.tone", value: "long", observed_at: "2026-10-02T00:00:00Z" },
    { id: 8, store: null, key: "guy.fee_rate", value: "12%", observed_at: "2026-10-01T00:00:00Z" },
    { id: 9, store: "hc", key: "pricing.band", value: "29-33%", observed_at: "2026-10-01T00:00:00Z", stale_after: "2026-10-05T00:00:00Z" },
  ];
  const f = checkFacts(facts, T0);
  const kinds = (id) => f.filter((x) => x.fact_id === id).map((x) => x.kind);
  assert.deepEqual(kinds(1), ["contradicts_spec"]);
  assert.deepEqual(kinds(2), []); // 144.95 matches the spec
  assert.deepEqual(kinds(3), ["contradicts_config"]);
  assert.deepEqual(kinds(4), ["missing_value"]);
  assert.deepEqual(kinds(5), ["stale"]);
  assert.ok(kinds(7).includes("conflicting_live"));
  assert.deepEqual(kinds(8), ["contradicts_config"]);
  assert.deepEqual(kinds(9), ["stale"]);
});

test("librarian: the vault outbox queues decisions, new facts and briefs once each; vault-sourced facts are not sent back", async () => {
  const DB = makeD1();
  await recordDecision(DB, { topic: "t", words: "do it" }, { nowMs: T0 });
  await fact(DB, { key: "learned.here", value: "1", source: "api:shopify" });
  await fact(DB, { key: "from.vault", value: "2", source: "vault:Stores/Pricing.md" });
  await DB.prepare(`INSERT INTO briefs (day, created_at, status, mode, body_md) VALUES ('2026-10-13', ?, 'ready', 'shadow', 'hi')`).bind(iso(T0)).run();
  assert.equal(fromVault("vault:Stores/Pricing.md"), true);
  const q1 = await queueVaultSync(DB, { nowMs: T0 });
  assert.deepEqual(q1, { decision: 1, fact: 1, brief: 1 });
  const q2 = await queueVaultSync(DB, { nowMs: T0 });
  assert.deepEqual(q2, { decision: 0, fact: 0, brief: 0 });
  const pending = await vaultOutbox(DB);
  assert.equal(pending.length, 3);
  assert.ok(pending.every((p) => p.status === "pending"));
  assert.equal(await markVaultCopied(DB, [pending[0].id, pending[0].id], { nowMs: T0 }), 1);
  assert.equal((await vaultOutbox(DB)).length, 2);
});

test("librarian: a check event only when findings change; weekly report event", async () => {
  const DB = makeD1();
  await fact(DB, { store: "hc", key: "pricing.min_price", value: "40" });
  await runLibrarian(DB, { nowMs: T0 });
  await runLibrarian(DB, { nowMs: T0 + 3600000 });
  assert.equal((await evs(DB, "librarian.check")).length, 1);
  const w = await weeklyReport(DB, { nowMs: T0 });
  assert.equal(w.live_facts, 1);
  assert.equal((await evs(DB, "librarian.weekly_report")).length, 1);
});

/* ---------------- Auditor ---------------- */

test("auditor: profit shown while an input is missing is flagged; logged once per 6 h; closed once fixed", async () => {
  assert.equal(auditPnlRows([{ store: "hc", day: "d", profit: 10, revenue: 1, refunds: 0, cogs: 0, ads: 0, guy_fee: 0, fees: 0, notes: "{}", complete: 0 }]).length, 0);
  const DB = makeD1();
  await DB.prepare(`INSERT INTO pnl_days (store, day, revenue, refunds, cogs, ads, guy_fee, fees, profit, status, updated_at, notes, complete)
    VALUES ('hc', '2026-10-12', 100, 0, 30, 20, 2, NULL, 48, 'partial', ?, '{"missing":[]}', 0)`).bind(iso(T0)).run();
  const env = { DB };
  await runAuditor(env, { nowMs: T0 });
  await runAuditor(env, { nowMs: T0 + 3600000 });
  assert.equal((await evs(DB, "audit.pnl_profit_without_inputs")).length, 1);
  await runAuditor(env, { nowMs: T0 + (RELOG_HOURS + 1) * 3600000 });
  assert.equal((await evs(DB, "audit.pnl_profit_without_inputs")).length, 2);
  await DB.prepare(`UPDATE pnl_days SET profit = NULL`).run();
  await runAuditor(env, { nowMs: T0 + (RELOG_HOURS + 2) * 3600000 });
  assert.equal(await count(DB, `SELECT COUNT(*) AS n FROM audit_findings WHERE open = 1`), 0);
});

test("auditor: duplicate pending approvals and a flooding agent are flagged; its own events never count", async () => {
  const DB = makeD1();
  for (let i = 0; i < 2; i++) await createApproval(DB, { dept: "cat", requestedBy: "cat.pricing", title: "Reprice 3 products", options: [{ id: "go", label: "Go" }] });
  for (let i = 0; i < 125; i++) await logEvent(DB, { actor: "sup.relay", kind: "x.y", summary: "spam", at: iso(T0 - 1000) });
  for (let i = 0; i < 125; i++) await logEvent(DB, { actor: "core.auditor", kind: "x.y", summary: "own", at: iso(T0 - 1000) });
  await runAuditor({ DB, AI_DAILY_BUDGET_USD: "3" }, { nowMs: T0 });
  assert.equal((await evs(DB, "audit.approval_duplicate")).length, 1);
  const flood = await evs(DB, "audit.flood");
  assert.equal(flood.length, 1);
  assert.equal(flood[0].target, "sup.relay");
});

test("auditor: AI spend over the cap and an unverified brief are flagged", async () => {
  const DB = makeD1();
  await logEvent(DB, { actor: "cs.triage", kind: "ai.call", summary: "x", costUsd: 3.5, at: iso(T0 - 60000) });
  await DB.prepare(`INSERT INTO briefs (day, created_at, status, mode, checked, unverified) VALUES ('2026-10-13', ?, 'ready', 'shadow', 0, '["$12.00"]')`).bind(iso(T0)).run();
  await runAuditor({ DB, AI_DAILY_BUDGET_USD: "3" }, { nowMs: T0 });
  assert.equal((await evs(DB, "audit.ai_over_budget")).length, 1);
  assert.match((await evs(DB, "audit.brief_unverified"))[0].summary, /\$12\.00/);
});

/* ---------------- Incident Desk ---------------- */

test("incidents: one failure is not an alarm; an ongoing one past 2 h raises exactly one approval; quiet resolves it", async () => {
  const DB = makeD1();
  const env = { DB };
  await logEvent(DB, { actor: "pnl.pullers", kind: "error.money_job", summary: "Ads failed", at: iso(T0) });
  let r = await runIncidents(env, { nowMs: T0 + 60000 });
  assert.equal(r.asked, 0);
  assert.equal(r.opened, 1);
  // Retries keep failing hourly for 3 hours.
  for (let h = 1; h <= 3; h++) await logEvent(DB, { actor: "pnl.pullers", kind: "error.money_job", summary: `Ads failed ${h}`, at: iso(T0 + h * 3600000) });
  r = await runIncidents(env, { nowMs: T0 + 3 * 3600000 + 60000 });
  assert.equal(r.asked, 1);
  r = await runIncidents(env, { nowMs: T0 + 3 * 3600000 + 120000 });
  assert.equal(r.asked, 0);
  assert.equal(await count(DB, `SELECT COUNT(*) AS n FROM approvals WHERE requested_by = 'core.incidents'`), 1);
  // 2 h of quiet → resolved.
  r = await runIncidents(env, { nowMs: T0 + 5 * 3600000 + 120000 });
  assert.equal(r.resolved, 1);
  const st = await incidentsState(DB, { nowMs: T0 + 5 * 3600000 + 120000 });
  assert.equal(st.open.length, 0);
  assert.equal((await evs(DB, "incident.resolved")).length, 1);
});

test("incidents: a short burst that recovers within 2 h never reaches Reilly", async () => {
  const DB = makeD1();
  await logEvent(DB, { actor: "pnl.refunds", kind: "error.refunds_pull", summary: "x", at: iso(T0) });
  await logEvent(DB, { actor: "pnl.refunds", kind: "error.refunds_pull", summary: "x", at: iso(T0 + 15 * 60000) });
  await runIncidents({ DB }, { nowMs: T0 + 20 * 60000 });
  await runIncidents({ DB }, { nowMs: T0 + 4 * 3600000 });
  assert.equal(await count(DB, `SELECT COUNT(*) AS n FROM approvals`), 0);
});

/* ---------------- Router ---------------- */

test("router: pure routing table; never routes to planned/off agents or back to the sender", () => {
  const status = new Map([["sup.size_charts", "built"], ["risk.chargebacks", "planned"], ["pnl.ledger", "built"], ["cat.pricing", "built"]]);
  assert.deepEqual(routeEvent({ kind: "size_complaint.logged", actor: "cs.triage" }, { status }).map((r) => [r.to, r.ready]), [["sup.size_charts", true]]);
  assert.deepEqual(routeEvent({ kind: "dispute.created", actor: "risk.x" }, { status }).map((r) => [r.to, r.ready]), [["risk.chargebacks", false]]);
  assert.deepEqual(routeEvent({ kind: "payout.mismatch", actor: "pnl.money_map" }, { status }).map((r) => r.to), ["pnl.ledger"]);
  assert.deepEqual(routeEvent({ kind: "approval.approved", actor: "core.approvals", target: "cat.pricing" }, { status }).map((r) => r.to), ["cat.pricing"]);
  assert.deepEqual(routeEvent({ kind: "route.handoff", actor: "core.router" }, { status }), []);
  assert.deepEqual(routeEvent({ kind: "something.else", actor: "x" }, { status }), []);
  assert.equal(canReceive("ful.tracking"), false); // switched off by Reilly
});

test("router: the first tick starts at the newest event; later events with a ready target become route.handoff events once", async () => {
  const DB = makeD1();
  await logEvent(DB, { actor: "pnl.money_map", kind: "payout.mismatch", summary: "old", at: iso(T0) });
  await runRouter({ DB }, { nowMs: T0 });
  assert.equal((await evs(DB, "route.handoff")).length, 0); // history isn't replayed
  await logEvent(DB, { actor: "pnl.money_map", kind: "payout.mismatch", summary: "new", store: "hc", at: iso(T0 + 1000) });
  // Disputes go to the Chargeback Agent (built 2026-10-13, so it's a ready target now).
  await logEvent(DB, { actor: "risk.x", kind: "dispute.created", summary: "dispute", at: iso(T0 + 1000) });
  const r = await runRouter({ DB }, { nowMs: T0 + 2000 });
  assert.equal(r.routed, 2);
  assert.equal(r.waiting, 0);
  await runRouter({ DB }, { nowMs: T0 + 3000 });
  const h = await evs(DB, "route.handoff");
  assert.equal(h.length, 2, "each routed once, never again");
  const ledger = h.find((x) => x.target === "pnl.ledger");
  assert.ok(ledger);
  assert.equal(ledger.store, "hc");
  assert.ok(h.find((x) => x.target === "risk.chargebacks"));
});

/* ---------------- department entry points ---------------- */

test("runCore: runs each agent on its cadence, never throws even when the database fails, and makes no network calls", async () => {
  const DB = makeD1();
  const fetchImpl = async () => { throw new Error("no network in core"); };
  const r1 = await runCore({ DB }, { nowMs: T0, fetchImpl });
  assert.ok(r1.decisions && r1.decisions.added > 0);
  const r2 = await runCore({ DB }, { nowMs: T0 + 60000, fetchImpl });
  assert.equal(r2.auditor, "not due");
  const broken = { prepare() { throw new Error("D1 down"); } };
  const r3 = await runCore({ DB: broken }, { nowMs: T0, fetchImpl });
  assert.ok(r3.router.error);
  const st = await coreState({ DB }, { nowMs: T0 });
  assert.equal(st.mode, "shadow");
  assert.ok(st.decisions.current.length > 0);
  assert.ok(Array.isArray(st.router.routes));
});
