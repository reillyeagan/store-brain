/**
 * Librarian (core.librarian) — plain code today, L2, shadow-safe (reads the Core, writes only
 * the ledger: events and the vault outbox).
 *
 * What it does:
 *  1. Consistency checks on the Core (`core_facts`, live rows only):
 *     - facts with no value;
 *     - stale facts (past their `stale_after`, or older than STALE_DAYS with none set);
 *     - facts that contradict the config or the specs (price floors/ceiling, KFB shop codes,
 *       Guy's fee rate);
 *     - the same key live twice with different values (which one do agents believe?).
 *  2. The vault sync outbox: every decision, every new fact that didn't come FROM the vault,
 *     and every finished morning brief is queued in `vault_outbox` (status pending). Claude on
 *     Reilly's PC copies them into Eagano's vault and marks them copied; the worker never
 *     writes to the vault itself (Reilly 2026-10-11: Eagano "is the TRUE ultimate data hub
 *     for EVERYTHING").
 *  3. A weekly report event (`librarian.weekly_report`).
 * Inputs: core_facts, decisions, briefs, src/config/stores.js, the pricing table in
 * docs/specs/supplier.md (copied into SPEC_PRICE_RULES below).
 * Outputs: `librarian.check` / `librarian.weekly_report` events, vault_outbox rows.
 * Nothing is changed in the Core: a contradiction is reported, never "fixed" (only Reilly's
 * words make a decision).
 */
import { STORES, LIVE_STORE_IDS, GUY_FEE } from "../../config/stores.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { parseRate } from "../../lib/pnl.js";

const ACTOR = "core.librarian";

/** A fact with no stale_after is "old" after this many days. */
export const STALE_DAYS = 180;
/** Items queued per kind per run (bounded work per tick). */
export const OUTBOX_PER_RUN = 100;

/**
 * Price rules from docs/specs/supplier.md "Pricing rules" (Reilly 2026-10-11: "max price 144.95
 * all 3 stores", "min price 44.95 on H&C going forwards"; AUB $44.95 and MAR $49.95 floors
 * from the same table). If the spec changes, change this table with it.
 */
export const SPEC_PRICE_RULES = Object.freeze({
  hc: { floor: 44.95, ceiling: 144.95 },
  aub: { floor: 44.95, ceiling: 144.95 },
  mar: { floor: 49.95, ceiling: 144.95 },
});

const EMPTY = new Set(["", "null", "{}", "[]", '""', "undefined"]);

/** First number in a fact value: 44.95, "44.95", "$44.95", {"usd":44.95}, {"value":"44.95"}. */
export function factNumber(value) {
  let v = value;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { /* text */ } }
  if (v && typeof v === "object") v = v.usd ?? v.value ?? v.amount ?? v.price ?? null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = /-?\d+(?:\.\d+)?/.exec(String(v ?? "").replace(/,/g, ""));
  return m ? Number(m[0]) : null;
}

function factText(value) {
  let v = value;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return v.trim(); } }
  if (v && typeof v === "object") v = v.value ?? v.code ?? null;
  return v == null ? "" : String(v).trim();
}

/** Did this fact come from Eagano's vault? Those are already there; no need to send them back. */
export const fromVault = (source) => /^(vault|eagano)[:/]/i.test(String(source || "")) || /\.md(#|$|\s)/i.test(String(source || ""));

/** Pure: every consistency finding for a list of live facts. */
export function checkFacts(facts, nowMs = Date.now()) {
  const out = [];
  const add = (f, kind, summary, detail = {}) => out.push({ kind, fact_id: f.id, store: f.store, key: f.key, summary, ...detail });
  const staleCut = nowIso(nowMs - STALE_DAYS * 86400000);
  const byKey = new Map();
  for (const f of facts) {
    const raw = f.value == null ? "" : String(f.value).trim();
    if (EMPTY.has(raw)) add(f, "missing_value", `Fact "${f.key}"${f.store ? ` (${f.store})` : ""} has no value`);
    if (f.stale_after && f.stale_after < nowIso(nowMs)) add(f, "stale", `Fact "${f.key}"${f.store ? ` (${f.store})` : ""} was due for a re-check on ${f.stale_after.slice(0, 10)}`);
    else if (!f.stale_after && f.observed_at && f.observed_at < staleCut) add(f, "stale", `Fact "${f.key}"${f.store ? ` (${f.store})` : ""} was last observed ${f.observed_at.slice(0, 10)} (over ${STALE_DAYS} days ago)`);
    if (f.superseded_by != null) add(f, "superseded_but_live", `Fact "${f.key}" is superseded by #${f.superseded_by} but still live`);
    const k = `${f.store || "*"}|${f.key}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(f);

    // --- contradictions with the config / specs ---
    const key = String(f.key).toLowerCase();
    const stores = f.store ? [f.store] : LIVE_STORE_IDS;
    const n = factNumber(f.value);
    const isPrice = /price/.test(key) && !/cogs|band|target|compare/.test(key);
    if (isPrice && /(floor|min)/.test(key) && n != null) {
      for (const s of stores) {
        const rule = SPEC_PRICE_RULES[s];
        if (rule && Math.abs(n - rule.floor) >= 0.005) add(f, "contradicts_spec", `Core says ${STORES[s].name} price floor is ${n} (${f.key}); the spec says ${rule.floor}`, { expected: rule.floor, found: n, against: "docs/specs/supplier.md" });
      }
    }
    if (isPrice && /(ceiling|max)/.test(key) && n != null) {
      for (const s of stores) {
        const rule = SPEC_PRICE_RULES[s];
        if (rule && Math.abs(n - rule.ceiling) >= 0.005) add(f, "contradicts_spec", `Core says ${STORES[s].name} price ceiling is ${n} (${f.key}); the spec says ${rule.ceiling}`, { expected: rule.ceiling, found: n, against: "docs/specs/supplier.md" });
      }
    }
    if (/kfb/.test(key) && /(shop|store)/.test(key) && /code/.test(key) && f.store && STORES[f.store]) {
      const want = STORES[f.store].kfbShopCode;
      const got = factText(f.value);
      if (want && got && got !== want) add(f, "contradicts_config", `Core says ${STORES[f.store].name}'s KFB shop code is "${got}"; stores.js says "${want}"`, { expected: want, found: got, against: "src/config/stores.js" });
    }
    if (/guy/.test(key) && /(fee|rate)/.test(key) && !/start/.test(key)) {
      const rate = parseRate(f.value);
      if (rate != null && Math.abs(rate - GUY_FEE.rate) > 1e-6) add(f, "contradicts_config", `Core says Guy's fee is ${Math.round(rate * 1000) / 10}%; stores.js says ${GUY_FEE.rate * 100}%`, { expected: GUY_FEE.rate, found: rate, against: "src/config/stores.js" });
    }
  }
  for (const [k, list] of byKey) {
    const values = new Set(list.map((f) => String(f.value).trim()));
    if (list.length > 1 && values.size > 1) {
      const f = list[list.length - 1];
      add(f, "conflicting_live", `"${f.key}"${f.store ? ` (${f.store})` : ""} is live ${list.length} times with ${values.size} different values`, { fact_ids: list.map((x) => x.id), group: k });
    }
  }
  return out;
}

export async function liveFacts(db) {
  const { results } = await db.prepare(`SELECT * FROM core_facts WHERE live = 1 ORDER BY id`).all();
  return results || [];
}

/* ---------------- vault outbox ---------------- */

async function enqueue(db, { kind, ref, title, body, at }) {
  const res = await db.prepare(
    `INSERT INTO vault_outbox (created_at, kind, ref_id, title, body, status) VALUES (?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(kind, ref_id) DO NOTHING`
  ).bind(at, kind, String(ref), String(title).slice(0, 300), JSON.stringify(body)).run();
  return !!(res.meta && res.meta.changes);
}

/**
 * Queue what the vault hasn't got yet: decisions, non-vault facts, ready briefs. Each source
 * row is queued once (UNIQUE kind+ref_id); bounded per run.
 */
export async function queueVaultSync(db, { nowMs = Date.now() } = {}) {
  const at = nowIso(nowMs);
  const counts = { decision: 0, fact: 0, brief: 0 };
  const dec = await db.prepare(
    `SELECT * FROM decisions WHERE CAST(id AS TEXT) NOT IN (SELECT ref_id FROM vault_outbox WHERE kind = 'decision') ORDER BY id LIMIT ?`
  ).bind(OUTBOX_PER_RUN).all();
  for (const d of dec.results || []) {
    if (await enqueue(db, { kind: "decision", ref: d.id, title: `Decision (${d.topic}): "${d.words.slice(0, 120)}"`, body: d, at })) counts.decision++;
  }
  const facts = await db.prepare(
    `SELECT * FROM core_facts WHERE CAST(id AS TEXT) NOT IN (SELECT ref_id FROM vault_outbox WHERE kind = 'fact') ORDER BY id LIMIT ?`
  ).bind(OUTBOX_PER_RUN * 3).all();
  let factBudget = OUTBOX_PER_RUN;
  for (const f of facts.results || []) {
    if (factBudget <= 0) break;
    if (fromVault(f.source)) continue; // came from the vault: it's already there
    factBudget--;
    if (await enqueue(db, { kind: "fact", ref: f.id, title: `Fact ${f.store ? `[${f.store}] ` : ""}${f.key}`, body: f, at })) counts.fact++;
  }
  const briefs = await db.prepare(
    `SELECT id, day, created_at, mode, composer, body_md, checked FROM briefs
      WHERE status = 'ready' AND CAST(id AS TEXT) NOT IN (SELECT ref_id FROM vault_outbox WHERE kind = 'brief') ORDER BY id LIMIT ?`
  ).bind(OUTBOX_PER_RUN).all().catch(() => ({ results: [] }));
  for (const b of briefs.results || []) {
    if (await enqueue(db, { kind: "brief", ref: b.id, title: `Morning brief ${b.day}`, body: b, at })) counts.brief++;
  }
  return counts;
}

/** For the endpoint Claude on Reilly's PC reads (wired by the integrator, behind the API key). */
export async function vaultOutbox(db, { status = "pending", limit = 50 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const { results } = await db.prepare(`SELECT * FROM vault_outbox WHERE status = ? ORDER BY id LIMIT ?`).bind(status, lim).all();
  return (results || []).map((r) => ({ ...r, body: r.body ? JSON.parse(r.body) : null }));
}

/** Mark items copied once they are in the vault. Only pending items move; returns how many. */
export async function markVaultCopied(db, ids, { nowMs = Date.now() } = {}) {
  let n = 0;
  for (const id of (ids || []).slice(0, 200)) {
    const r = await db.prepare(`UPDATE vault_outbox SET status = 'copied', copied_at = ? WHERE id = ? AND status = 'pending'`).bind(nowIso(nowMs), Number(id)).run();
    n += (r.meta && r.meta.changes) || 0;
  }
  if (n) await logEvent(db, { actor: ACTOR, kind: "vault.copied", summary: `${n} item${n === 1 ? "" : "s"} confirmed copied into the Eagano vault`, data: { ids: ids.slice(0, 50) }, at: nowIso(nowMs) });
  return n;
}

/* ---------------- the runs ---------------- */

/** Checks + outbox. Logs one `librarian.check` event only when the set of findings changes. */
export async function runLibrarian(db, { nowMs = Date.now() } = {}) {
  const facts = await liveFacts(db);
  const findings = checkFacts(facts, nowMs);
  const queued = await queueVaultSync(db, { nowMs });
  const sig = findings.map((f) => `${f.kind}:${f.fact_id}`).sort().join(",");
  const last = await db.prepare(`SELECT data FROM events WHERE actor = ? AND kind = 'librarian.check' ORDER BY id DESC LIMIT 1`).bind(ACTOR).first();
  const lastSig = last && last.data ? (JSON.parse(last.data).sig || "") : null;
  const counts = countBy(findings);
  if (lastSig !== sig) {
    await logEvent(db, {
      actor: ACTOR, kind: "librarian.check",
      summary: findings.length
        ? `Core check: ${findings.length} finding${findings.length === 1 ? "" : "s"} (${Object.entries(counts).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ")}) in ${facts.length} live facts`
        : `Core check: ${facts.length} live facts, nothing missing, stale or contradicting the config`,
      data: { sig, counts, findings: findings.slice(0, 20) }, at: nowIso(nowMs),
    });
  }
  const q = queued.decision + queued.fact + queued.brief;
  if (q) {
    await logEvent(db, {
      actor: ACTOR, kind: "vault.queued",
      summary: `Queued for the Eagano vault: ${queued.decision} decision${queued.decision === 1 ? "" : "s"}, ${queued.fact} fact${queued.fact === 1 ? "" : "s"}, ${queued.brief} brief${queued.brief === 1 ? "" : "s"}`,
      data: queued, at: nowIso(nowMs),
    });
  }
  return { facts: facts.length, findings: findings.length, counts, queued };
}

const countBy = (list) => list.reduce((m, f) => ((m[f.kind] = (m[f.kind] || 0) + 1), m), {});

export async function weeklyReport(db, { nowMs = Date.now() } = {}) {
  const facts = await liveFacts(db);
  const findings = checkFacts(facts, nowMs);
  const weekAgo = nowIso(nowMs - 7 * 86400000);
  const n = async (sql, ...b) => ((await db.prepare(sql).bind(...b).first()) || {}).n || 0;
  const newFacts = await n(`SELECT COUNT(*) AS n FROM core_facts WHERE observed_at >= ?`, weekAgo);
  const newDecisions = await n(`SELECT COUNT(*) AS n FROM decisions WHERE at >= ?`, weekAgo);
  const pending = await n(`SELECT COUNT(*) AS n FROM vault_outbox WHERE status = 'pending'`);
  const oldest = await db.prepare(`SELECT MIN(created_at) AS at FROM vault_outbox WHERE status = 'pending'`).first();
  const data = { live_facts: facts.length, new_facts: newFacts, new_decisions: newDecisions, findings: countBy(findings), vault_pending: pending, vault_oldest_pending: (oldest && oldest.at) || null };
  await logEvent(db, {
    actor: ACTOR, kind: "librarian.weekly_report", target: "core.briefer",
    summary: `Weekly Core report: ${facts.length} live facts (${newFacts} new), ${newDecisions} new decision${newDecisions === 1 ? "" : "s"}, ${findings.length} finding${findings.length === 1 ? "" : "s"}, ${pending} item${pending === 1 ? "" : "s"} waiting to reach the vault`,
    data, at: nowIso(nowMs),
  });
  return data;
}

export async function librarianState(db, { nowMs = Date.now() } = {}) {
  const facts = await liveFacts(db);
  const findings = checkFacts(facts, nowMs);
  const pending = await db.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM vault_outbox WHERE status = 'pending'`).first();
  const copied = await db.prepare(`SELECT COUNT(*) AS n FROM vault_outbox WHERE status = 'copied'`).first();
  return {
    live_facts: facts.length,
    findings: findings.slice(0, 50), finding_counts: countBy(findings),
    vault: { pending: (pending && pending.n) || 0, oldest_pending: (pending && pending.oldest) || null, copied: (copied && copied.n) || 0,
      note: "Copied into Eagano's vault by Claude on Reilly's PC; the worker only queues." },
  };
}
