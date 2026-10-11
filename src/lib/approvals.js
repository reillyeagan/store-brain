/**
 * Approvals Desk — everything that needs Reilly, in one queue.
 *
 * Nothing in here executes without his decision. Each approval carries 1–4 options
 * with exact numbers. A decision is recorded once; it cannot be changed after the
 * fact, and an approval can only move pending → approved/rejected → executed/failed.
 *
 * Phone buttons: each notification carries signed Approve/Reject links. The
 * signature (HMAC of approval id + choice) means a link can't be forged or reused
 * for a different approval or option.
 */
import { nowIso } from "./time.js";
import { logEvent } from "./eventlog.js";

const enc = new TextEncoder();

export async function createApproval(db, { dept, requestedBy, title, options, store = null, ticketId = null }) {
  if (!dept || !requestedBy || !title) throw new Error("createApproval: dept, requestedBy and title are required");
  if (!Array.isArray(options) || options.length < 1 || options.length > 4) {
    throw new Error("createApproval: 1 to 4 options required");
  }
  for (const o of options) {
    if (!o || !o.id || !o.label) throw new Error("createApproval: every option needs id and label");
    if (o.id === "reject") throw new Error('createApproval: "reject" is reserved');
  }
  const at = nowIso();
  const res = await db
    .prepare(
      `INSERT INTO approvals (created_at, store, dept, requested_by, ticket_id, title, options, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
    .bind(at, store, dept, requestedBy, ticketId, title, JSON.stringify(options))
    .run();
  const id = res.meta && res.meta.last_row_id;
  await logEvent(db, {
    actor: "core.approvals", kind: "approval.requested", store, target: requestedBy, ticketId,
    summary: `Waiting on Reilly: ${title}`, data: { approvalId: id, options: options.map((o) => o.label) }, at,
  });
  return id;
}

export async function getApproval(db, id) {
  const row = await db.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(id).first();
  return row ? { ...row, options: JSON.parse(row.options) } : null;
}

export async function listPending(db) {
  const { results } = await db.prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY id`).all();
  return (results || []).map((r) => ({ ...r, options: JSON.parse(r.options) }));
}

/**
 * Record Reilly's decision. `choice` is an option id or "reject".
 * Only a pending approval can be decided; a second tap does nothing.
 */
export async function decide(db, id, { choice, note = null }) {
  const ap = await getApproval(db, id);
  if (!ap) return { ok: false, error: "not_found" };
  if (ap.status !== "pending") return { ok: false, error: `already_${ap.status}`, approval: ap };
  const valid = choice === "reject" || ap.options.some((o) => o.id === choice);
  if (!valid) return { ok: false, error: "invalid_choice" };
  const status = choice === "reject" ? "rejected" : "approved";
  const at = nowIso();
  // The WHERE status='pending' guard makes a double-tap race harmless.
  const res = await db
    .prepare(`UPDATE approvals SET status = ?, choice = ?, note = ?, decided_at = ? WHERE id = ? AND status = 'pending'`)
    .bind(status, choice, note, at, id)
    .run();
  if (!res.meta || res.meta.changes !== 1) return { ok: false, error: "race_lost" };
  const label = choice === "reject" ? "Rejected" : ap.options.find((o) => o.id === choice).label;
  await logEvent(db, {
    actor: "core.approvals", kind: `approval.${status}`, store: ap.store, target: ap.requested_by,
    ticketId: ap.ticket_id, summary: `${label}: ${ap.title}`, data: { approvalId: id, choice, note }, at,
  });
  return { ok: true, status, approval: await getApproval(db, id) };
}

/** After the requesting worker carries out an approved action and verifies it. */
export async function markExecuted(db, id, { ok, result }) {
  const ap = await getApproval(db, id);
  if (!ap || ap.status !== "approved") return { ok: false, error: "not_approved" };
  const status = ok ? "executed" : "failed";
  const res = await db
    .prepare(`UPDATE approvals SET status = ?, executed_at = ?, result = ? WHERE id = ? AND status = 'approved'`)
    .bind(status, nowIso(), JSON.stringify(result ?? null), id)
    .run();
  if (!res.meta || res.meta.changes !== 1) return { ok: false, error: "race_lost" };
  await logEvent(db, {
    actor: "core.approvals", kind: `approval.${status}`, store: ap.store, target: ap.requested_by,
    summary: `${ok ? "Done and verified" : "FAILED"}: ${ap.title}`, data: { approvalId: id, result },
  });
  return { ok: true, status };
}

/* ---------- signed phone links ---------- */

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Phone links expire after 7 days. */
export const LINK_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * The signature binds the approval id AND its creation time (so a recreated ledger
 * can't reuse an old link), the option, and an expiry.
 */
export const signDecision = (secret, approval, choice, expMs) =>
  hmacHex(secret, `approval:${approval.id}:${approval.created_at}:${choice}:${expMs}`);

export async function verifyDecisionSig(secret, approval, choice, sig, expMs, nowMs = Date.now()) {
  if (!secret || !sig || !approval) return false;
  const exp = Number(expMs);
  if (!Number.isFinite(exp) || exp < nowMs) return false;
  const expected = await signDecision(secret, approval, choice, exp);
  if (expected.length !== String(sig).length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ String(sig).charCodeAt(i);
  return diff === 0;
}

/**
 * Push an approval to Reilly's phone via ntfy, with Approve/Reject buttons.
 * Returns {sent:false} (not an error) when the phone isn't set up yet.
 */
export async function notifyPhone(env, approval, { baseUrl, fetchImpl = fetch } = {}) {
  if (!env.NTFY_TOPIC || !env.APPROVAL_SIGNING_KEY || !baseUrl) return { sent: false, reason: "phone not set up" };
  const first = approval.options[0];
  const exp = Date.now() + LINK_TTL_MS;
  const approveSig = await signDecision(env.APPROVAL_SIGNING_KEY, approval, first.id, exp);
  const rejectSig = await signDecision(env.APPROVAL_SIGNING_KEY, approval, "reject", exp);
  const decideUrl = (choice, sig) =>
    `${baseUrl}/api/approvals/${approval.id}/decide?choice=${encodeURIComponent(choice)}&exp=${exp}&sig=${sig}`;
  const actions = [
    `http, ${first.label.replace(/[,;]/g, " ").slice(0, 40)}, ${decideUrl(first.id, approveSig)}, method=POST, clear=true`,
    `http, Reject, ${decideUrl("reject", rejectSig)}, method=POST, clear=true`,
    `view, Open, ${baseUrl}/#approval-${approval.id}`,
  ].join("; ");
  const res = await fetchImpl(`${env.NTFY_SERVER || "https://ntfy.sh"}/${env.NTFY_TOPIC}`, {
    method: "POST",
    headers: { Title: `Store Brain: ${approval.title}`.slice(0, 120), Tags: "white_check_mark", Actions: actions },
    body: approval.options.map((o) => `• ${o.label}${o.detail ? ` — ${o.detail}` : ""}`).join("\n"),
  });
  return { sent: res.ok, status: res.status };
}
