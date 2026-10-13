import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";
import { askClaude, askJson } from "../src/lib/ai.js";

const KEY = "sk-ant-api03-TESTKEY-never-log-me-123";
const fake = (text) => async (url, init) => {
  const body = JSON.parse(init.body);
  return new Response(JSON.stringify({ model: body.model, content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: "end_turn" }), { status: 200 });
};

test("ai: no key → skipped, nothing called", async () => {
  const DB = makeD1();
  let n = 0;
  const r = await askClaude({ DB }, { system: "s", user: "u", actor: "cs.triage", label: "x" }, { fetchImpl: async () => { n++; } });
  assert.ok(r.skipped);
  assert.equal(n, 0);
});

test("ai: every call's cost is logged; the key never appears in events", async () => {
  const DB = makeD1();
  const r = await askJson({ DB, ANTHROPIC_API_KEY: KEY }, { system: "s", user: "u", actor: "cs.triage", label: "Triage" }, { fetchImpl: fake('{"kind":"size"}') });
  assert.deepEqual(r.json, { kind: "size" });
  const ev = (await DB.prepare(`SELECT * FROM events`).all()).results;
  assert.equal(ev.filter((e) => e.kind === "ai.call").length, 1);
  assert.ok(ev[0].cost_usd > 0);
  assert.ok(!JSON.stringify(ev).includes(KEY));
});

test("ai: a non-JSON answer throws (never invented)", async () => {
  const DB = makeD1();
  await assert.rejects(askJson({ DB, ANTHROPIC_API_KEY: KEY }, { system: "s", user: "u", actor: "cs.triage", label: "Triage" }, { fetchImpl: fake("sorry") }));
});

test("ai: the daily budget stops spending and says so once", async () => {
  const DB = makeD1();
  const env = { DB, ANTHROPIC_API_KEY: KEY, AI_DAILY_BUDGET_USD: "0.0001" };
  await askClaude(env, { system: "s", user: "u", actor: "cs.triage", label: "a" }, { fetchImpl: fake("hi") });
  const r = await askClaude(env, { system: "s", user: "u", actor: "cs.triage", label: "b" }, { fetchImpl: fake("hi") });
  assert.equal(r.skipped, "daily AI budget reached");
  await askClaude(env, { system: "s", user: "u", actor: "cs.triage", label: "c" }, { fetchImpl: fake("hi") });
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'ai.budget_reached'`).first()).n, 1);
});
