/**
 * cs.obligations — money and goods promises (code). SHADOW: reads the ledger, writes only to
 * D1 (obligations, approvals, events). Never refunds, reships or emails anyone.
 *
 * Why: until now only dated "I'll reply by ..." promises were tracked. The costly misses were
 * money and goods: H&C #1019 had a refund promised on 2026-09-09 that was never issued (30+
 * days, Memory Log 2026-10-05), replacements were owed with no order behind them (#1059, #1054,
 * #1013), returns sat waiting on a refund (#1038, Marlowe #1001).
 *
 * What it does:
 *   1. findGoodsPromises: in each of Reilly's SENT replies (the thread re-read by checkThreads),
 *      finds sentences that promise a refund, a replacement or an exchange. Offers, questions,
 *      conditions he hasn't accepted and refusals are not promises ("would you like a refund?",
 *      "we can't refund"). Drafts never count: only sent mail is the system of record.
 *   2. recordGoodsPromise: opens one obligation per (ticket, kind), tied to the ticket's
 *      VERIFIED order only (cs.order_context attaches an order only when the sender's email is
 *      on it, and never on an order-number mismatch). With no verified order the obligation is
 *      still opened, with no order: it can't close itself and goes to Reilly when overdue.
 *      A stranger's order is never matched.
 *   3. closeKeptPromises: closes an obligation ONLY when the system of record shows it:
 *        refund      — a refund event for that order in the ledger (SUCCESS or PENDING,
 *                      amount > 0), processed no earlier than a day before the promise;
 *        replacement — a later order for the same customer in the same store that is a $0
 *        / exchange    order or names the original order / "replacement" / "exchange", or a KFB
 *                      order for the same order number placed after the promise (KFB orders
 *                      arrive with the KFB Morning Session, not built yet).
 *      Another sent email ("refund done!") never closes it (a receipt is not proof, rule 3).
 *   4. askOverduePromises: open past its due date (PROMISE_DAYS after the promise) → one
 *      Waiting-on-you question for Reilly per obligation.
 */
import { logEvent } from "../../lib/eventlog.js";
import { createApproval } from "../../lib/approvals.js";
import { nowIso } from "../../lib/time.js";
import { STORES } from "../../config/stores.js";
import { PROMISE_DAYS } from "./config.js";
import { orderEmails } from "./orderContext.js";
import { clip, safeJson } from "./util.js";

const ACTOR = "cs.obligations";
export const GOODS_KINDS = Object.freeze(["refund", "replacement", "exchange"]);
const ASKS_PER_RUN = 5;
const CLOSE_CHECKS_PER_RUN = 50;

// A first-person promise: "I'll", "we will", "we're going to", or done-claims like "I've issued"
// (a claim that it happened is still checked against Shopify: a sent email is not proof).
const WILL = /\b(i|we)\s*(?:'ll|’ll|\s+will|\s+shall|'re going to|’re going to|\s+are going to|\s+am going to|'m going to|’m going to|(?:\s+have|'ve|’ve)\s+(?:just\s+|now\s+|already\s+)?(?:issued|processed|sent|refunded|arranged|placed|requested|ordered|started|gone ahead))\b/i;
const PASSIVE = /\b(your|a|the)\s+(full\s+|partial\s+)?(refund|replacement|exchange)\s+(will|is going to|has been|is being|is now)\b/i;
const KINDS = [
  { kind: "refund", re: /\b(refund(ed|ing)?|reimburs\w*|money back)\b/i },
  { kind: "replacement", re: /\b(replacement|replace (it|them|the|your)|re-?ship\w*|re-?send\w*|send (you )?(out )?(a |another )?(new|fresh|second) (one|pair|item|order)|send (you )?(the|a) (size |)(xxs|xs|s|m|l|xl|xxl|xxxl|[2-5]xl)\b)/i },
  { kind: "exchange", re: /\b(exchange(d)?|swap (it|them)|switch (it|them) (for|to))\b/i },
];
// Not a promise: a question, an offer, a condition he hasn't granted yet, or a refusal.
const NOT_PROMISE = /\b(would you like|do you want|if you(?:'d| would)? (like|prefer|want)|we (can|could) (offer|do)|happy to offer|an option|unfortunately|unable to|can(?:'|’)?t|cannot|won(?:'|’)?t|will not|not able to|no refund|non-refundable)\b/i;

/** Pure: the money/goods promises in one sent reply. Returns [{kind, said}] (one per kind). */
export function findGoodsPromises(text) {
  const out = [];
  const sentences = String(text || "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (NOT_PROMISE.test(s)) continue;
    if (!WILL.test(s) && !PASSIVE.test(s)) continue;
    for (const k of KINDS) {
      if (!k.re.test(s) || out.some((o) => o.kind === k.kind)) continue;
      out.push({ kind: k.kind, said: clip(s.trim(), 300) });
    }
  }
  return out;
}

export const goodsNote = (ticketId, kind, said, sentIso) => `cs ticket ${ticketId} ${kind}: "${said}" (sent ${sentIso})`;
const sentFromNote = (note) => { const m = String(note || "").match(/\(sent ([0-9T:.\-Z]+)\)$/); return m ? m[1] : null; };

/**
 * Open (once) the obligation for one promise in one sent reply. `t` is the cs_tickets row.
 * The order is the ticket's verified order or none (never a number the reply mentions).
 */
export async function recordGoodsPromise(db, t, p, sentMs, nowMs) {
  const dup = await db.prepare(`SELECT id FROM obligations WHERE kind = ? AND note LIKE ?`)
    .bind(p.kind, `cs ticket ${t.id} ${p.kind}:%`).first();
  if (dup) return false; // one obligation per ticket and kind: a repeated promise is the same promise
  const verified = t.order_id && !t.order_mismatch ? { id: t.order_id, name: t.order_name, store: t.order_store || t.store } : null;
  const sentIso = new Date(sentMs).toISOString();
  const due = new Date(sentMs + PROMISE_DAYS[p.kind] * 86400000).toISOString();
  const at = nowIso(nowMs);
  await db.prepare(
    `INSERT INTO obligations (created_at, store, kind, party, order_ref, order_id, due_at, status, note) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`
  ).bind(at, verified ? verified.store : t.store, p.kind, t.from_email, verified ? verified.name : null, verified ? verified.id : null, due,
    goodsNote(t.id, p.kind, p.said, sentIso)).run();
  const store = verified ? verified.store : t.store;
  await logEvent(db, {
    actor: ACTOR, kind: "cs.promise_recorded", store, at,
    summary: `${p.kind[0].toUpperCase()}${p.kind.slice(1)} promised in a sent reply (ticket ${t.id}${verified ? `, ${verified.name}` : ", no verified order"}); watching for it in ${verified ? "Shopify" : "nothing: it can't be checked without a verified order"}, due ${due.slice(0, 10)}`,
    data: { ticket: t.id, kind: p.kind, order_id: verified ? verified.id : null },
  });
  return true;
}

/** Pure: does this later order look like a replacement / exchange for the original? */
export function looksLikeReplacement(order, { originalName, party }) {
  const raw = safeJson(order.raw, {}) || {};
  if (!orderEmails(order.raw).includes(String(party || "").toLowerCase())) return false; // never a stranger's order
  const text = [raw.note, raw.tags, raw.source_name, ...(Array.isArray(raw.note_attributes) ? raw.note_attributes.map((a) => `${a.name} ${a.value}`) : [])]
    .filter(Boolean).join(" ").toLowerCase();
  const total = Number(order.total);
  return (Number.isFinite(total) && total === 0) || /replacement|exchange|reship/.test(text) ||
    (originalName && text.includes(String(originalName).toLowerCase()));
}

/**
 * What the system of record shows for one open obligation: {kept, how} or {kept:false}.
 * Refund: refund events (rule 7). Replacement/exchange: a replacement order or a KFB re-order.
 */
export async function evidenceFor(db, o) {
  if (!o.order_id || !o.store) return { kept: false, why: "no verified order" };
  const promised = sentFromNote(o.note) || o.created_at;
  const sinceMs = Date.parse(promised) - 86400000;
  const since = new Date(sinceMs).toISOString();
  if (o.kind === "refund") {
    const { results } = await db.prepare(`SELECT refund_id, amount, status, processed_at FROM refunds WHERE store = ? AND order_id = ? AND processed_at >= ?`)
      .bind(o.store, o.order_id, since).all();
    const hit = (results || []).find((r) => Number(r.amount) > 0 && /SUCCESS|PENDING/.test(String(r.status || "")));
    return hit ? { kept: true, how: `Shopify refund ${hit.status} $${Number(hit.amount).toFixed(2)} processed ${String(hit.processed_at).slice(0, 10)}` } : { kept: false };
  }
  const { results: later } = await db.prepare(
    `SELECT order_id, name, total, raw, created_at FROM orders WHERE store = ? AND order_id <> ? AND created_at >= ? ORDER BY created_at LIMIT 50`
  ).bind(o.store, o.order_id, since).all();
  const rep = (later || []).find((x) => looksLikeReplacement(x, { originalName: o.order_ref, party: o.party }));
  if (rep) return { kept: true, how: `replacement order ${rep.name} placed ${String(rep.created_at).slice(0, 10)}` };
  const code = STORES[o.store] && STORES[o.store].kfbShopCode;
  if (code && o.order_ref) {
    const ref = String(o.order_ref).replace(/^#/, "");
    const k = await db.prepare(`SELECT kfb_order_id, kfb_created_at FROM kfb_orders WHERE kfb_shop_code = ? AND order_ref IN (?, ?) AND kfb_created_at >= ? LIMIT 1`)
      .bind(code, ref, `#${ref}`, since).first().catch(() => null);
    if (k) return { kept: true, how: `KFB order ${k.kfb_order_id} for ${o.order_ref} placed ${String(k.kfb_created_at).slice(0, 10)}` };
  }
  return { kept: false };
}

/** Close the money/goods promises the system of record shows as done. */
export async function closeKeptPromises(db, { nowMs = Date.now() } = {}) {
  const { results } = await db.prepare(
    `SELECT * FROM obligations WHERE status = 'open' AND kind IN ('refund','replacement','exchange') AND order_id IS NOT NULL ORDER BY id LIMIT ?`
  ).bind(CLOSE_CHECKS_PER_RUN).all();
  let closed = 0;
  for (const o of results || []) {
    const ev = await evidenceFor(db, o);
    if (!ev.kept) continue;
    const at = nowIso(nowMs);
    const res = await db.prepare(`UPDATE obligations SET status = 'done', done_at = ? WHERE id = ? AND status = 'open'`).bind(at, o.id).run();
    if (!res.meta || res.meta.changes !== 1) continue;
    closed++;
    await logEvent(db, { actor: ACTOR, kind: "cs.promise_kept", store: o.store, at,
      summary: `Promise kept: ${o.kind} for ${o.order_ref} (${ev.how})`, data: { obligation: o.id, how: ev.how } });
  }
  return closed;
}

/** Overdue money/goods promises → one Waiting-on-you question each. */
export async function askOverduePromises(db, { nowMs = Date.now() } = {}) {
  const { results } = await db.prepare(
    `SELECT * FROM obligations WHERE status = 'open' AND kind IN ('refund','replacement','exchange') AND approval_id IS NULL AND due_at < ? ORDER BY due_at LIMIT ?`
  ).bind(nowIso(nowMs), ASKS_PER_RUN).all();
  let asked = 0;
  for (const o of results || []) {
    // Claim first (approval_id = 0) so two overlapping runs can't both ask.
    const claim = await db.prepare(`UPDATE obligations SET approval_id = 0 WHERE id = ? AND approval_id IS NULL`).bind(o.id).run();
    if (!claim.meta || claim.meta.changes !== 1) continue;
    const promised = (sentFromNote(o.note) || o.created_at).slice(0, 10);
    const days = Math.floor((nowMs - Date.parse(sentFromNote(o.note) || o.created_at)) / 86400000);
    const store = STORES[o.store] ? STORES[o.store].name : "A store";
    const what = o.kind === "refund" ? "no refund for that order in Shopify" : "no replacement order (or KFB re-order) for it";
    const title = o.order_id
      ? `${store} ${o.order_ref}: ${o.kind} promised ${promised} (${days} days ago), ${what} yet. Has it been done?`
      : `${store}: ${o.kind} promised ${promised} (${days} days ago) to ${o.party}, with no verified order to check it against. Has it been done?`;
    let id;
    try {
      id = await createApproval(db, {
        dept: "cs", requestedBy: ACTOR, store: o.store, title,
        options: [{ id: "seen", label: "Seen, I'll handle it", detail: `The brain keeps watching ${o.order_id ? "Shopify" : "this"} and closes it only when the ${o.kind} shows up there.` }],
      });
    } catch (err) {
      await db.prepare(`UPDATE obligations SET approval_id = NULL WHERE id = ? AND approval_id = 0`).bind(o.id).run().catch(() => {});
      throw err;
    }
    await db.prepare(`UPDATE obligations SET approval_id = ? WHERE id = ?`).bind(id, o.id).run();
    await logEvent(db, { actor: ACTOR, kind: "cs.promise_overdue", store: o.store, at: nowIso(nowMs),
      summary: `Overdue: ${title}`, data: { obligation: o.id, approvalId: id } });
    asked++;
  }
  return asked;
}
