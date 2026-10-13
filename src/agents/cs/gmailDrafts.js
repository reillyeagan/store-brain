/**
 * Is an earlier reply draft for this conversation still sitting in Gmail?
 *
 * Why: a conversation must never get two drafts, and Reilly is told to delete a stale one. But
 * the ledger's gmail_draft_id only says a draft WAS made: Reilly may have sent it (sending a
 * draft removes it) or deleted it. So before calling a draft "still there", Gmail is asked
 * (drafts.get, one read call). A 404 means it's gone: recorded (gmail_draft_state = 'gone') so it
 * is never asked again. Any other answer, or no allowance left, counts as "still there" — the
 * safe side: no second draft is made.
 */
import { getGoogleAccessToken } from "../../lib/google.js";
import { nowIso } from "../../lib/time.js";
import { getDraft } from "./gmail.js";

export async function draftStillInGmail(env, row, { fetchImpl = fetch, nowMs = Date.now(), budget = null } = {}) {
  if (budget && !budget.take(2)) return true; // token (often cached) + one read
  try {
    const token = await getGoogleAccessToken(env, { fetchImpl, nowMs, slot: row.slot });
    await getDraft(token, row.gmail_draft_id, { fetchImpl });
    return true;
  } catch (err) {
    if (err && err.status === 404) {
      await env.DB.prepare(`UPDATE cs_tickets SET gmail_draft_state = 'gone', updated_at = ? WHERE id = ?`).bind(nowIso(nowMs), row.id).run();
      return false;
    }
    return true;
  }
}

/**
 * Another ticket in the same conversation whose Gmail draft still exists, or null.
 * @param {{superseded?: boolean}} only superseded tickets (stale drafts) when true
 */
export async function otherLiveDraft(env, t, opts = {}, { superseded = false } = {}) {
  if (!t.thread_id) return null;
  const { results } = await env.DB.prepare(
    `SELECT id, slot, gmail_draft_id, status FROM cs_tickets
      WHERE slot = ? AND thread_id = ? AND id <> ? AND gmail_draft_id IS NOT NULL AND gmail_draft_state IS NULL
        ${superseded ? "AND status = 'superseded'" : ""}
      ORDER BY id DESC LIMIT 3`
  ).bind(t.slot, t.thread_id, t.id).all();
  for (const r of results || []) {
    if (await draftStillInGmail(env, r, opts)) return r;
  }
  return null;
}
