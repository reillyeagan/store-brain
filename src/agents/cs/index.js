/**
 * Customer Service department — cron entry point and dashboard data. LIVE as DRAFTS ONLY (go-live 2026-10-14, decision core.go_live).
 *
 * runCs (each CS slot in the department rotation, about every 20 minutes; self-throttled with claimJob):
 *   read  (every run): cs.triage reads the connected inboxes
 *   work  (every run): cs.triage classifies → cs.order_context matches orders (+ Supplier feeds)
 *                   → cs.retention proposes → cs.escalation flags → cs.reply_writer drafts
 *   obligations (60 min): cs.obligations re-reads threads, records/clears promises, flags overdue
 * One subrequest allowance per run is shared by every step (CAPS.subrequests). Each step has
 * its own try, so one failure never stops the others and runCs never throws.
 *
 * Nothing is ever sent (decision cs.sending: "drafts that i review and click send" until Reilly
 * says "start sending"). The only outside write possible is a Gmail DRAFT, and only with
 * CS_DRAFTS_LIVE = "1" (on in wrangler.toml since go-live; "0" keeps drafts on the CS page).
 */
import { modeFor, liveMeans } from "../../config/live.js";
import { claimJob, noteJobResult } from "../../lib/jobRuns.js";
import { CAPS, CADENCE, CATEGORIES, inboxPlan, storeName } from "./config.js";
import { Budget, logOnce, safeJson, clip } from "./util.js";
import { readInboxes, classifyTickets, connectedSlots } from "./triage.js";
import { attachOrderContext } from "./orderContext.js";
import { proposeRetention } from "./retention.js";
import { escalateTickets } from "./escalation.js";
import { writeReplies, draftsLive } from "./replyWriter.js";
import { writeStarterDrafts } from "./starterDrafts.js";
import { checkThreads, flagOverdue } from "./obligations.js";
import { closeKeptPromises, askOverduePromises, evidenceFor } from "./promises.js";

export async function runCs(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const out = {};
  const budget = new Budget(CAPS.subrequests);
  const step = async (name, actor, fn) => {
    try {
      out[name] = await fn();
    } catch (err) {
      out[name] = { error: String(err && err.message) };
      await logOnce(env.DB, { actor, kind: "error.cs_step", summary: `CS step "${name}" failed: ${clip(String(err && err.message), 200)}. It runs again next run.` }, { key: name, nowMs }).catch(() => {});
    }
  };
  const opts = { nowMs, fetchImpl, budget };
  try {
    if (await claimJob(env.DB, "cs.read", CADENCE.read, nowMs)) {
      await step("read", "cs.triage", () => readInboxes(env, opts));
      await noteJobResult(env.DB, "cs.read", summarize(out.read)).catch(() => {});
    }
    if (await claimJob(env.DB, "cs.work", CADENCE.work, nowMs)) {
      await step("classify", "cs.triage", () => classifyTickets(env, opts));
      await step("context", "cs.order_context", () => attachOrderContext(env, opts));
      await step("retention", "cs.retention", () => proposeRetention(env, opts));
      await step("escalation", "cs.escalation", () => escalateTickets(env, opts));
      await step("drafts", "cs.reply_writer", () => writeReplies(env, opts));
      // Flagged emails get a starting reply in Gmail too (Reilly 2026-10-15: "i thought the brain
      // was supposed to draft replies for me, not just tell me"). The decision stays his.
      await step("starters", "cs.reply_writer", () => writeStarterDrafts(env, opts));
      await noteJobResult(env.DB, "cs.work", summarize({ classify: out.classify, context: out.context, escalation: out.escalation, drafts: out.drafts, starters: out.starters })).catch(() => {});
    }
    if (await claimJob(env.DB, "cs.obligations", CADENCE.obligations, nowMs)) {
      await step("threads", "cs.obligations", () => checkThreads(env, opts));
      await step("overdue", "cs.obligations", () => flagOverdue(env, opts));
      await step("promisesKept", "cs.obligations", () => closeKeptPromises(env.DB, opts));
      await step("promisesOverdue", "cs.obligations", () => askOverduePromises(env.DB, opts));
      await noteJobResult(env.DB, "cs.obligations", summarize({ threads: out.threads, overdue: out.overdue, kept: out.promisesKept, asked: out.promisesOverdue })).catch(() => {});
    }
  } catch (err) {
    // claimJob itself failed (e.g. the database is unreachable): report, never throw.
    out.error = String(err && err.message);
  }
  out.subrequestsLeft = budget.left;
  return out;
}

function summarize(v) {
  try { return clip(JSON.stringify(v), 290); } catch { return "ok"; }
}

const OPEN = ["new", "open", "drafted", "needs_reilly"];

/** Dashboard data for the Customer Service page. Lists capped. */
export async function csState(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const all = async (sql, ...b) => ((await db.prepare(sql).bind(...b).all()).results || []);
  const slots = await connectedSlots(db);
  const inboxRows = new Map((await all(`SELECT * FROM cs_inboxes`)).map((r) => [r.slot, r]));
  const inboxes = inboxPlan(new Set(slots.keys())).filter((i) => i.stores.length).map((i) => {
    const r = inboxRows.get(i.slot) || {};
    return {
      slot: i.slot, stores: i.stores.map(storeName), account: slots.get(i.slot) || null,
      wired: slots.has(i.slot), last_read_at: r.last_read_at || null, last_ok_at: r.last_ok_at || null,
      last_error: r.last_error || null, read_upto: r.cursor_ms ? new Date(Number(r.cursor_ms)).toISOString() : null,
      not_wired: slots.has(i.slot) ? null : "Google not connected for this inbox (Setup → Connect)",
      // Gmail sends a draft from the inbox's own address. Reilly's main inbox serves several
      // stores, so its drafts go out FROM reillyworking26@gmail.com unless a Gmail "Send mail as"
      // alias for the store address is set up (the brain can't see or set aliases).
      draft_from: i.own ? (slots.get(i.slot) || null) : (slots.get(i.slot) || "the main Google account"),
      draft_from_warning: i.own ? null : `Replies drafted here go out from ${slots.get(i.slot) || "the main Google account"}, not from the store address, unless a Gmail "Send mail as" alias for ${i.stores.join(" / ")} is set up. The store name is in the signature.`,
    };
  });

  const marks = OPEN.map(() => "?").join(",");
  const byCat = await all(`SELECT store, category, status, COUNT(*) AS n FROM cs_tickets WHERE status IN (${marks}) GROUP BY store, category, status`, ...OPEN);
  const open = {};
  for (const r of byCat) {
    const cat = r.category || "unsorted";
    const s = r.store || "unknown";
    open[cat] = open[cat] || { total: 0, byStore: {} };
    open[cat].total += r.n;
    open[cat].byStore[s] = (open[cat].byStore[s] || 0) + r.n;
  }
  const statusCounts = Object.fromEntries((await all(`SELECT status, COUNT(*) AS n FROM cs_tickets GROUP BY status`)).map((r) => [r.status, r.n]));

  const drafts = (await all(
    `SELECT id, store, order_store, order_name, category, subject, from_name, from_email, draft_status, draft_body, draft_note, draft_at, gmail_draft_id, gmail_draft_state, gmail_push, gmail_push_note
       FROM cs_tickets WHERE draft_at IS NOT NULL AND status NOT IN ('superseded','ignored') ORDER BY draft_at DESC, id DESC LIMIT 20`
  )).map((t) => ({ ...t, store: storeName(t.order_store || t.store) }));

  const escalations = (await all(
    `SELECT c.id, c.store, c.order_store, c.order_name, c.category, c.urgency, c.summary, c.subject, c.from_name, c.from_email, c.escalated_at,
            c.approval_id, c.retention, a.status AS approval_status
       FROM cs_tickets c LEFT JOIN approvals a ON a.id = c.approval_id
      WHERE c.escalated_at IS NOT NULL AND c.status <> 'no_action' ORDER BY c.escalated_at DESC, c.id DESC LIMIT 20`
  )).map((t) => ({ ...t, store: storeName(t.order_store || t.store), retention: safeJson(t.retention, null) }));

  const soon = new Date(nowMs + 48 * 3600000).toISOString();
  const obligations = (await all(
    `SELECT o.id, o.store, o.party, o.order_ref, o.due_at, o.note, f.flagged_at FROM obligations o LEFT JOIN cs_overdue_flags f ON f.obligation_id = o.id
      WHERE o.status = 'open' AND o.kind = 'reply' AND o.note LIKE 'cs ticket %' AND o.due_at <= ? ORDER BY o.due_at LIMIT 20`, soon
  )).map((o) => ({ ...o, overdue: o.due_at < new Date(nowMs).toISOString() }));

  // Money and goods promises (refund / replacement / exchange) still open, oldest first.
  const promiseRows = await all(
    `SELECT id, store, kind, party, order_ref, order_id, due_at, note, approval_id, created_at FROM obligations
      WHERE status = 'open' AND kind IN ('refund','replacement','exchange') ORDER BY due_at IS NULL, due_at LIMIT 30`
  );
  const promisesOpen = [];
  for (const o of promiseRows) {
    // "refund pending": Shopify has a PENDING refund for it (not closed until it succeeds).
    const ev = o.kind === "refund" && o.order_id ? await evidenceFor(db, o) : null;
    promisesOpen.push({ ...o, store: storeName(o.store), overdue: o.due_at != null && o.due_at < new Date(nowMs).toISOString(),
      awaiting_return: o.due_at == null, refund_pending: !!(ev && ev.pending), pending_detail: ev && ev.pending ? ev.how : null,
      verified_order: !!o.order_id, closes_when: o.kind === "refund" ? "a SUCCESS Shopify refund for this order" : "a replacement order (or a second KFB order) after the promise" });
  }

  // A reply draft left in Gmail after the customer wrote again: Reilly should delete it.
  const staleGmailDrafts = await all(
    `SELECT s.id AS old_ticket, s.gmail_draft_id, n.id AS new_ticket, s.store, s.subject FROM cs_tickets s
       JOIN cs_tickets n ON n.slot = s.slot AND n.thread_id = s.thread_id AND n.id > s.id AND n.status <> 'superseded'
      WHERE s.status = 'superseded' AND s.gmail_draft_id IS NOT NULL AND s.gmail_draft_state IS NULL ORDER BY s.id DESC LIMIT 20`
  );
  const kfbAsks = await all(`SELECT id, created_at, store, ticket_id, order_name, kind, detail, shipped, status FROM cs_kfb_asks WHERE status = 'open' ORDER BY id DESC LIMIT 20`);
  const sizeComplaints = await all(`SELECT id, store, order_id, product_id, size_ordered, size_that_fits, said, at FROM size_complaints WHERE source LIKE 'gmail:%' ORDER BY id DESC LIMIT 10`);
  const ignoredByAi = await all(`SELECT id, store, subject, from_email, classified_at FROM cs_tickets WHERE status = 'ignored' ORDER BY id DESC LIMIT 10`);
  // Thank-yous and acknowledgements closed quietly (noAction.js): listed so Reilly can check
  // nothing real was closed. `why` is the guard's reason.
  const noAction = (await all(
    `SELECT id, store, order_store, order_name, order_ref, subject, summary, classify_note AS why, updated_at AS closed_at, approval_id
       FROM cs_tickets WHERE status = 'no_action' ORDER BY id DESC LIMIT 20`
  )).map((t) => ({ ...t, store: storeName(t.order_store || t.store), order_store: undefined, why: String(t.why || "").replace(/^no_action[^:]*:\s*/, "") }));
  const waiting = await db.prepare(`SELECT COUNT(*) AS n, MAX(classify_note) AS note FROM cs_tickets WHERE status = 'new'`).first();
  const jobs = await all(`SELECT job, last_run_at, last_result FROM job_runs WHERE job LIKE 'cs.%' ORDER BY job`);

  const notWired = [];
  for (const i of inboxes) if (!i.wired) notWired.push(`${i.stores.join(", ")}: ${i.not_wired}`);
  if (!env.ANTHROPIC_API_KEY) notWired.push("AI: no ANTHROPIC_API_KEY, so emails are read but not sorted or drafted");

  return {
    mode: modeFor(env, "cs"), live_means: liveMeans(env, "cs"),
    drafts_to_gmail: draftsLive(env), // false = drafts live only on this page (CS_DRAFTS_LIVE not "1")
    categories: CATEGORIES,
    inboxes,
    last_read_at: inboxes.map((i) => i.last_ok_at).filter(Boolean).sort().pop() || null,
    status_counts: statusCounts,
    open_by_category: open,
    unsorted: { count: (waiting && waiting.n) || 0, note: (waiting && waiting.note) || null },
    drafts,
    escalations,
    obligations_due: obligations,
    promises_open: promisesOpen,
    kfb_asks: kfbAsks,
    size_complaints: sizeComplaints,
    ignored_by_ai: ignoredByAi,
    no_action_needed: noAction,
    jobs,
    not_wired: notWired,
    stale_gmail_drafts: staleGmailDrafts.map((r) => ({ ...r, store: storeName(r.store), note: "Stale draft in Gmail — delete it (the customer wrote again)" })),
    warnings: inboxes.map((i) => i.draft_from_warning).filter(Boolean),
  };
}
