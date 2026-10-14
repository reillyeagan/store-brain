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
import { seedDecision, canonicalTopic } from "../src/agents/core/decisions.js";
import { ensureSupplierDecisions, SUPPLIER_DECISIONS } from "../src/agents/supplier/decisions.js";
import { trackingOff } from "../src/lib/tracking.js";
import { chainOf } from "../src/agents/core/incidents.js";
import { ROUTE_BATCH } from "../src/agents/core/router.js";

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

test("librarian: only like with like — a fact stating floor AND ceiling is read label by label, a KFB supply tier is not a retail ceiling, a real ceiling of 150 is still caught", () => {
  const at = "2026-10-01T00:00:00Z";
  const facts = [
    // Live fact 263's shape: both numbers in one value, for all three stores.
    { id: 263, store: null, key: "pricing.price_floor_ceiling", value: "Floor $44.95 on H&C and Auberlane, $49.95 on Marlowe; ceiling $144.95 all 3 stores (Reilly 2026-10-11)", observed_at: at },
    { id: 264, store: null, key: "pricing.price_floor_ceiling", value: "min price 44.95 on H&C going forwards. max price 144.95 all 3 stores", observed_at: at },
    { id: 265, store: "mar", key: "pricing.price_floor_ceiling", value: "{\"floor\":49.95,\"ceiling\":144.95}", observed_at: at },
    // Live fact 384: a KFB supply price tier, not the store's retail ceiling.
    { id: 384, store: null, key: "kfb.price_tier_supply_ceiling", value: "175", observed_at: at },
    // Genuine contradictions must still be found.
    { id: 400, store: "hc", key: "pricing.price_ceiling", value: "150", observed_at: at },
    { id: 401, store: null, key: "pricing.price_floor_ceiling", value: "floor $44.95 H&C, AUB, $49.95 MAR; ceiling $150 all stores", observed_at: at },
    { id: 402, store: "mar", key: "pricing.price_floor", value: "$44.95", observed_at: at },
    // Can't tell which number is which: unparsed, not a contradiction.
    { id: 500, store: null, key: "pricing.price_floor_ceiling", value: "44.95 / 144.95", observed_at: at },
    { id: 501, store: null, key: "pricing.price_floor_ceiling", value: "Floor and ceiling: 44.95 / 144.95", observed_at: at },
    { id: 502, store: null, key: "pricing.price_floor", value: "$44.95 H&C, $49.95 Marlowe", observed_at: at },
  ];
  const f = checkFacts(facts, T0);
  // (Several of these share a key on purpose, so "conflicting_live" is expected and set aside.)
  const of = (id, kind) => f.filter((x) => x.fact_id === id && x.kind !== "conflicting_live" && (!kind || x.kind === kind));
  for (const id of [263, 264, 265, 384]) assert.deepEqual(of(id), [], `fact ${id}: ${JSON.stringify(of(id))}`);
  assert.equal(f.filter((x) => /ceiling is 44\.95/.test(x.summary)).length, 0);

  const c400 = of(400, "contradicts_spec");
  assert.equal(c400.length, 1);
  assert.match(c400[0].summary, /Holt & Crane price ceiling is 150 .*the spec says 144\.95/);
  assert.equal(c400[0].found, 150);
  assert.equal(c400[0].expected, 144.95);
  // Stated for all stores: one contradiction per store, floors (all correct) not flagged.
  const c401 = of(401, "contradicts_spec");
  assert.deepEqual(c401.map((x) => [x.rule_store, x.kind_of_rule, x.found]).sort(), [["aub", "ceiling", 150], ["hc", "ceiling", 150], ["mar", "ceiling", 150]]);
  assert.deepEqual(of(402, "contradicts_spec").map((x) => [x.rule_store, x.found, x.expected]), [["mar", 44.95, 49.95]]);
  for (const id of [500, 501]) {
    assert.deepEqual(of(id).map((x) => x.kind), ["unparsed"], `fact ${id}`);
  }
  // Prices tied to named stores without a floor/ceiling word: read by the key, per store.
  assert.deepEqual(of(502), []);
});

test("librarian review: '$1,500' is 1500; camelCase and joined keys are read or reported unparsed, never skipped", async () => {
  const { readPriceFact, retailPriceKinds } = await import("../src/agents/core/priceFacts.js");
  assert.deepEqual(readPriceFact({ store: "hc", key: "pricing.price_ceiling", value: "$1,500" }).claims, [{ kind: "ceiling", store: "hc", value: 1500 }]);
  assert.deepEqual(readPriceFact({ store: "hc", key: "pricing.price_ceiling", value: "ceiling $1,500.00" }).claims, [{ kind: "ceiling", store: "hc", value: 1500 }]);
  assert.deepEqual(retailPriceKinds("pricing.priceCeiling"), ["ceiling"]);
  assert.deepEqual(retailPriceKinds("pricing.maxprice"), ["ceiling"]);
  assert.deepEqual(retailPriceKinds("pricing.minPrice"), ["floor"]);
  assert.deepEqual(retailPriceKinds("pricing.pricefloorceiling"), ["floor", "ceiling"]);
  assert.deepEqual(retailPriceKinds("pricing.priceLimit"), ["unknown"]);
  assert.equal(retailPriceKinds("kfb.price_tier_supply_ceiling"), null);
  const at = "2026-10-01T00:00:00Z";
  const f = checkFacts([
    { id: 1, store: "hc", key: "pricing.priceCeiling", value: "150", observed_at: at },
    { id: 2, store: "mar", key: "pricing.maxprice", value: "$1,500", observed_at: at },
    { id: 3, store: null, key: "pricing.priceLimit", value: "144.95", observed_at: at },
  ], T0);
  assert.deepEqual(f.filter((x) => x.kind === "contradicts_spec").map((x) => [x.fact_id, x.found]), [[1, 150], [2, 1500]]);
  assert.deepEqual(f.filter((x) => x.fact_id === 3).map((x) => x.kind), ["unparsed"]);
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

test("vault outbox: every item comes with its vault path and full markdown (Reilly's words verbatim); the Core page shows them and marks them copied through the existing endpoints", async () => {
  const DB = makeD1();
  await recordDecision(DB, { topic: "pricing.ceiling", words: "max price 144.95 all 3 stores", scope: "all" }, { nowMs: T0 });
  await fact(DB, { store: "hc", key: "pricing.price_floor", value: "{\"usd\":44.95}", source: "api:test" });
  await DB.prepare(`INSERT INTO briefs (day, created_at, status, mode, composer, body_md, checked) VALUES ('2026-10-14', ?, 'ready', 'shadow', 'ai', '## Yesterday''s money\n- fine', 1)`).bind(iso(T0)).run();
  await queueVaultSync(DB, { nowMs: T0 });
  const items = await vaultOutbox(DB, { limit: 200 });
  const by = (k) => items.find((x) => x.kind === k);
  assert.match(by("decision").vault_path, /^03 Areas\/Business\/Store Brain\/Decisions\/\d{4}-\d{2}-\d{2} pricing\.ceiling\.md$/);
  assert.match(by("decision").markdown, /\n> max price 144\.95 all 3 stores\n/);
  assert.equal(by("fact").vault_path, "03 Areas/Business/Store Brain/Facts/hc pricing.price_floor.md");
  assert.match(by("fact").markdown, /"usd": 44\.95/);
  assert.equal(by("brief").vault_path, "03 Areas/Business/Store Brain/Briefs/2026-10-14 Morning brief.md");
  assert.match(by("brief").markdown, /## Yesterday's money\n- fine/);
  // A ``` inside a fact can't close the note's code block early.
  const { vaultEntry, fenceFor } = await import("../src/agents/core/librarian.js");
  assert.equal(fenceFor("a ``` b ```` c"), "`````");
  const md = vaultEntry({ id: 1, kind: "fact", ref_id: "9", created_at: "t", body: { id: 9, key: "k", value: "x\n```\n# not a heading\n```" } }).markdown;
  assert.match(md, /\n````\nx\n```\n# not a heading\n```\n````\n/);

  // Through the worker, with the key, the way the dashboard calls it.
  const worker = (await import("../src/index.js")).default;
  const env = { DB, MC_KEY: "k".repeat(32) };
  const h = { "x-store-brain-key": "k".repeat(32) };
  assert.equal((await worker.fetch(new Request("https://b/api/vault/outbox"), env)).status, 401);
  const got = await (await worker.fetch(new Request("https://b/api/vault/outbox?limit=200", { headers: h }), env)).json();
  assert.equal(got.items.length, 3);
  assert.ok(got.items.every((x) => x.vault_path && x.markdown));
  const marked = await (await worker.fetch(new Request("https://b/api/vault/outbox/copied", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ ids: got.items.map((x) => x.id) }) }), env)).json();
  assert.equal(marked.marked, 3);
  assert.equal((await vaultOutbox(DB)).length, 0);

  // The Core page draws the box from those endpoints, and its script still parses.
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /if\(p==="core"\) h\+='<div class="box" id="vaultBox"/);
  assert.match(html, /api\("\/api\/vault\/outbox\?limit=200"\)/);
  assert.match(html, /api\("\/api\/vault\/outbox\/copied",\{method:"POST",headers:\{"content-type":"application\/json"\},body:JSON\.stringify\(\{ids:/);
  assert.match(html, /Mark all shown as copied/);
  const block = html.slice(html.indexOf("/* ---- Vault outbox"), html.indexOf("/* One delegated listener"));
  // No apostrophes inside single-quoted strings (one blanked the page before).
  for (const s of block.match(/'(?:[^'\\\n]|\\.)*'/g) || []) assert.ok(!/\\'/.test(s), `escaped apostrophe in ${s}`);
  assert.doesNotThrow(() => new Function(html.match(/<script>([\s\S]*)<\/script>/)[1]));
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

/* ---------------- review fixes ---------------- */

test("review fix 1: 400 vault-seeded facts can't hide a new fact from the vault outbox", async () => {
  const DB = makeD1();
  for (let i = 0; i < 400; i++) await fact(DB, { key: `vault.fact.${i}`, value: "x", source: `vault:Stores/Note${i}.md` });
  await fact(DB, { key: "learned.today", value: "1", source: "api:shopify" });
  let q = await queueVaultSync(DB, { nowMs: T0 });
  for (let i = 0; i < 3 && !q.fact; i++) q = await queueVaultSync(DB, { nowMs: T0 });
  assert.equal(q.fact, 1);
  const pending = await vaultOutbox(DB, { limit: 200 });
  assert.deepEqual(pending.filter((p) => p.kind === "fact").map((p) => p.body.key), ["learned.today"]);
  await fact(DB, { key: "learned.later", value: "2", source: "api:shopify" });
  assert.equal((await queueVaultSync(DB, { nowMs: T0 })).fact, 1);
});

test("review fix 9: one seed guard — one topic per quote across both seeds, generic quotes don't block other topics, Reilly's newer words always win", async () => {
  assert.equal(canonicalTopic("supplier.returns"), "sup.returns");
  assert.equal(canonicalTopic("supplier.approve_price_rewrites"), "pricing.approval");
  const DB = makeD1();
  await recordDecision(DB, { topic: "sup.bills", words: "i pay KFB bills on fridays now" }, { nowMs: T0 });
  await ensureSupplierDecisions(DB, { nowMs: T0 });
  await seedDecisions(DB, { nowMs: T0 });
  await ensureSupplierDecisions(DB, { nowMs: T0 });
  // No quote twice. Bare "yes"/"no" answers recur on different topics by design (each seed's
  // source carries its question), so they're checked per topic instead.
  const { results } = await DB.prepare(`SELECT words, COUNT(*) AS n FROM decisions WHERE words NOT IN ('yes', 'no') GROUP BY words HAVING COUNT(*) > 1`).all();
  assert.deepEqual(results, []);
  const { results: bare } = await DB.prepare(`SELECT topic, words, COUNT(*) AS n FROM decisions WHERE words IN ('yes', 'no') GROUP BY topic, words HAVING COUNT(*) > 1`).all();
  assert.deepEqual(bare, []);
  assert.equal((await currentDecision(DB, "sup.bills")).words, "i pay KFB bills on fridays now");
  assert.equal(await count(DB, `SELECT COUNT(*) AS n FROM decisions WHERE topic LIKE 'supplier.%'`), 0);
  // The same generic words on two topics are both recorded.
  assert.equal((await seedDecision(DB, { topic: "x.one", words: "looks good" }, { nowMs: T0 })).added, true);
  assert.equal((await seedDecision(DB, { topic: "x.two", words: "looks good" }, { nowMs: T0 })).added, true);
  // A row stored under the old name still counts.
  const DB2 = makeD1();
  await DB2.prepare(`INSERT INTO decisions (at, topic, words, scope, settled) VALUES (?, 'supplier.returns', 'i never return things to KFB.', 'all', 1)`).bind(iso(T0)).run();
  await seedDecisions(DB2, { nowMs: T0 });
  await ensureSupplierDecisions(DB2, { nowMs: T0 });
  assert.equal(await count(DB2, `SELECT COUNT(*) AS n FROM decisions WHERE words = 'i never return things to KFB.'`), 1);
  assert.ok(SUPPLIER_DECISIONS.every((d) => !d.topic.startsWith("supplier.")));
});

test("review fix 9: the tracking switch-off goes through the guard (never over Reilly's newer words on parcel tracking)", async () => {
  const DB = makeD1();
  await recordDecision(DB, { topic: "parcel_tracking", words: "turn parcel tracking back on for H&C" }, { nowMs: T0 });
  await trackingOff({ DB }, T0);
  await trackingOff({ DB }, T0 + 1000);
  assert.equal(await count(DB, `SELECT COUNT(*) AS n FROM decisions WHERE topic = 'parcel_tracking'`), 1);
  const DB2 = makeD1();
  await trackingOff({ DB: DB2 }, T0);
  await trackingOff({ DB: DB2 }, T0 + 1000);
  assert.equal((await currentDecision(DB2, "parcel_tracking")).words, PARCEL_TRACKING_DECISION.words);
  assert.equal(await count(DB2, `SELECT COUNT(*) AS n FROM decisions`), 1);
});

test("review fix 6: failed API requests logged under core.incidents count; only the desk's own step errors are ignored", async () => {
  const DB = makeD1();
  for (let h = 0; h <= 3; h++) {
    await logEvent(DB, { actor: "core.incidents", kind: "error.request", summary: `GET /api/state failed ${h}`, at: iso(T0 + h * 3600000) });
    await logEvent(DB, { actor: "core.incidents", kind: "error.core_incidents", summary: "desk step failed", at: iso(T0 + h * 3600000) });
  }
  const r = await runIncidents({ DB }, { nowMs: T0 + 3 * 3600000 + 60000 });
  assert.equal(r.asked, 1);
  assert.equal(await count(DB, `SELECT COUNT(*) AS n FROM incidents WHERE kind = 'error.core_incidents'`), 0);
});

test("review fix 6: a daily job failing once a day reaches Reilly on the second day; a job with a job_runs row stays open until it reports ok", async () => {
  assert.equal(chainOf([T0 + 86400000, T0]).count, 2);
  assert.equal(chainOf([T0 + 5 * 86400000, T0]).count, 1); // days apart: not one incident
  const DB = makeD1();
  await logEvent(DB, { actor: "pnl.calendar", kind: "error.calendar_daily", summary: "failed", at: iso(T0) });
  let r = await runIncidents({ DB }, { nowMs: T0 + 3 * 3600000 });
  assert.equal(r.asked, 0);
  await logEvent(DB, { actor: "pnl.calendar", kind: "error.calendar_daily", summary: "failed again", at: iso(T0 + 86400000) });
  r = await runIncidents({ DB }, { nowMs: T0 + 86400000 + 60000 });
  assert.equal(r.asked, 1);
  // 10 h later (no error since): still open, the daily rhythm says it isn't quiet yet.
  r = await runIncidents({ DB }, { nowMs: T0 + 86400000 + 10 * 3600000 });
  assert.equal(r.resolved, 0);

  // A job_runs-backed step: open past 2 h of silence until the job reports ok.
  const DB2 = makeD1();
  await DB2.prepare(`INSERT INTO job_runs (job, last_run_at, last_result) VALUES ('core.librarian.weekly', ?, 'error: boom')`).bind(iso(T0)).run();
  await logEvent(DB2, { actor: "core.librarian", kind: "error.core_librarian_weekly", summary: "boom", at: iso(T0) });
  await runIncidents({ DB: DB2 }, { nowMs: T0 + 60000 });
  r = await runIncidents({ DB: DB2 }, { nowMs: T0 + 5 * 3600000 });
  assert.equal(r.resolved, 0);
  await DB2.prepare(`UPDATE job_runs SET last_run_at = ?, last_result = 'ok: {}' WHERE job = 'core.librarian.weekly'`).bind(iso(T0 + 6 * 3600000)).run();
  r = await runIncidents({ DB: DB2 }, { nowMs: T0 + 6 * 3600000 + 60000 });
  assert.equal(r.resolved, 1);
  assert.match((await evs(DB2, "incident.resolved"))[0].summary, /ran OK again/);
});

test("review fix 16: if raising the approval fails, the claim is released so the next run can ask", async () => {
  const DB = makeD1();
  for (let h = 0; h <= 3; h++) await logEvent(DB, { actor: "pnl.pullers", kind: "error.money_job", summary: "x", at: iso(T0 + h * 3600000) });
  const failing = { prepare(sql) { if (/INSERT INTO approvals/.test(sql)) throw new Error("D1 hiccup"); return DB.prepare(sql); } };
  await assert.rejects(() => runIncidents({ DB: failing }, { nowMs: T0 + 3 * 3600000 + 60000 }));
  assert.equal((await DB.prepare(`SELECT approval_id FROM incidents`).first()).approval_id, null);
  const r = await runIncidents({ DB }, { nowMs: T0 + 3 * 3600000 + 120000 });
  assert.equal(r.asked, 1);
});

test("review fix 8: the router catches up past one page in a single run", async () => {
  const DB = makeD1();
  await runRouter({ DB }, { nowMs: T0 });
  for (let i = 0; i < ROUTE_BATCH + 50; i++) {
    await logEvent(DB, { actor: "pnl.money_map", kind: "payout.mismatch", summary: `m${i}`, at: iso(T0 + i) });
    await logEvent(DB, { actor: "x.y", kind: "noise", summary: "n", at: iso(T0 + i) });
  }
  const r = await runRouter({ DB }, { nowMs: T0 + 60000 });
  assert.equal(r.routed, ROUTE_BATCH + 50);
  assert.equal(r.caught_up, true);
  const r2 = await runRouter({ DB }, { nowMs: T0 + 120000 });
  assert.equal(r2.routed, 0);
});

/* ---------------- nice-to-haves ---------------- */

test("nice 1: the auditor's AI cap follows ai.js (a non-number or 0 means the $3 default, never silence)", async () => {
  for (const setting of ["abc", "0", "-5"]) {
    const DB = makeD1();
    await logEvent(DB, { actor: "cs.triage", kind: "ai.call", summary: "x", costUsd: 3.5, at: iso(T0 - 60000) });
    await runAuditor({ DB, AI_DAILY_BUDGET_USD: setting }, { nowMs: T0 });
    assert.equal((await evs(DB, "audit.ai_over_budget")).length, 1, setting);
  }
});

test("nice 3: recordDecision and currentDecision know the old topic names", async () => {
  const DB = makeD1();
  await DB.prepare(`INSERT INTO decisions (at, topic, words, scope, settled) VALUES (?, 'supplier.bills', 'old words', 'all', 1)`).bind(iso(T0)).run();
  assert.equal((await currentDecision(DB, "sup.bills")).words, "old words");
  assert.equal((await currentDecision(DB, "supplier.bills")).words, "old words");
  const r = await recordDecision(DB, { topic: "supplier.bills", words: "new words" }, { nowMs: T0 });
  assert.ok(r.supersedes);
  const cur = await currentDecision(DB, "sup.bills");
  assert.equal(cur.words, "new words");
  assert.equal(cur.topic, "sup.bills");
  assert.equal((await listDecisions(DB, { topic: "sup.bills" })).length, 2);
});

test("nice 4: a router catch-up burst is not a flood", async () => {
  const DB = makeD1();
  for (let i = 0; i < 300; i++) await logEvent(DB, { actor: "core.router", kind: "route.handoff", summary: "h", at: iso(T0 - 1000) });
  await runAuditor({ DB }, { nowMs: T0 });
  assert.equal((await evs(DB, "audit.flood")).length, 0);
});

test("nice 5: an open incident outside the 50 most recent groups is judged on its own errors, not resolved for being left out", async () => {
  const DB = makeD1();
  for (let h = 0; h <= 3; h++) await logEvent(DB, { actor: "pnl.pullers", kind: "error.money_job", summary: "x", at: iso(T0 + h * 3600000) });
  await runIncidents({ DB }, { nowMs: T0 + 3 * 3600000 + 60000 });
  // 60 newer error groups push it out of the list while it is still failing.
  for (let i = 0; i < 60; i++) await logEvent(DB, { actor: "sup.relay", kind: `error.noise_${i}`, summary: "n", at: iso(T0 + 3 * 3600000 + 120000 + i) });
  const r = await runIncidents({ DB }, { nowMs: T0 + 3 * 3600000 + 300000 });
  assert.equal(await count(DB, `SELECT COUNT(*) AS n FROM incidents WHERE key = 'pnl.pullers|error.money_job' AND status = 'open'`), 1);
  assert.ok(r.groups <= 50);
  // Once it has been quiet past its rhythm it does resolve.
  await runIncidents({ DB }, { nowMs: T0 + 6 * 3600000 });
  assert.equal(await count(DB, `SELECT COUNT(*) AS n FROM incidents WHERE key = 'pnl.pullers|error.money_job' AND status = 'resolved'`), 1);
});

test("decisions: Reilly's open-questions answers (2026-10-13) are seeded verbatim, with the question kept for bare yes/no", async () => {
  const DB = makeD1();
  await seedDecisions(DB, { nowMs: T0 });
  const want = {
    "core.store_audiences": ["all", "H&C is mens and womens. Auberlane is womens. Marlowe is mens."],
    "sup.kfb_match_key": ["all", "product handle is prob best"],
    "sup.similar_substitutions": ["all", "yes"],
    "cat.min_margin.aub": ["aub", "yes"],
    "cat.high_margin_exemption": ["all", "no"],
    "cs.size_up_disclosure": ["all", "no unless they ask"],
    "sup.kfb_quote_status_40": ["all", "FFG quote status 40 i think means i just havent approved it"],
    "risk.order_1098": ["hc", "1098 turned into a chargeback and the shipping status still isnt updating"],
    "cs.review_requests": ["all", "off turn them off on all stores please"],
  };
  for (const [topic, [scope, words]] of Object.entries(want)) {
    const d = await currentDecision(DB, topic);
    assert.ok(d, topic);
    assert.equal(d.words, words, topic);
    assert.equal(d.scope, scope, topic);
    assert.equal(d.at, "2026-10-14T00:23:00Z", topic);
    const seed = SEED_DECISIONS.find((s) => s.topic === topic);
    assert.match(seed.source, /^chat 2026-10-13/, topic);
    if (words === "yes" || words === "no") assert.match(seed.source, /Q: .+\?/, `${topic}: the question stands with the bare answer`);
  }
  // The Judge.me source claims nothing beyond where the words came from.
  assert.equal(SEED_DECISIONS.find((s) => s.topic === "cs.review_requests").source, "chat 2026-10-13 (open-questions answers)");
});
