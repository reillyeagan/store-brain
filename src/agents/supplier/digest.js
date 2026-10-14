/**
 * Supplier Digest (sup.digest) — plain code (no AI), L2, SHADOW.
 *
 * What it does: once per Eastern day, from 07:00 (before the 8:00 brief), writes one plain
 * summary of supplier activity into `supplier_digests` for the Briefer to read
 * (latestSupplierDigest()). Numbers by code; nothing here is estimated.
 *
 * Covers: quotes waiting (and status-25 / status-40 items), batches waiting on Reilly, size
 * asks, KFB message status, unpaid KFB bills (Reilly: "i try to pay KFB bills every morning
 * if i can"), credits owed, pre-flight flags, sourcing flags.
 * Unwired inputs say "waiting on KFB session", never 0 (rule 4).
 *
 * AI is not used: the spec's "why" paragraph can be added later through src/lib/ai.js with a
 * small token cap; the code summary stands on its own.
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { easternClock } from "../../lib/kfbMessage.js";
import { STORES } from "../../config/stores.js";
import { creditAging } from "./claims.js";
import { LATEST_QUOTE_SQL } from "./preflight.js";
import { money } from "./common.js";
import { lastSectionRead, lastSectionImport } from "../../lib/kfbReads.js";

/** The later of two ISO times (either may be null). */
const later = (a, b) => (!a ? b || null : !b ? a : a > b ? a : b);

const ACTOR = "sup.digest";
/** Composed on the first tick at/after 07:00 Eastern, so it's ready for the 8:00 brief. */
export const DIGEST_AFTER_MIN = 7 * 60;
/**
 * Rule 4 (freshness before numbers): a KFB read older than this is not used. Without it, one
 * bill import weeks ago would make the brief say "Bills: none unpaid" forever (flattering).
 * 36 h = a missed morning session still counts, two missed ones don't.
 */
export const KFB_READ_MAX_AGE_H = 36;

/** Hours since an ISO time, or null. */
const ageHours = (iso, nowMs) => (iso ? (nowMs - Date.parse(iso)) / 3600000 : null);
const agoText = (h) => (h < 48 ? `${Math.round(h)} hours ago` : `${Math.floor(h / 24)} days ago`);

/** Bills summary, or null when no bill has ever been imported (not wired ≠ zero). */
export async function billsSummary(db, nowMs = Date.now()) {
  const any = await db.prepare(`SELECT COUNT(*) AS n, MAX(imported_at) AS last FROM supplier_bills`).first();
  // Bills read by the morning import but not listed to pay (no amount, or cut by the read):
  // shown, never silently dropped (review of 7ce2827, finding 2).
  const imp = await lastSectionImport(db, "bills");
  const toPay = (imp && imp.counts && imp.counts.bills && imp.counts.bills.to_pay) || {};
  if ((!any || !any.n) && !imp) return null;
  const { results } = await db.prepare(`SELECT currency, COUNT(*) AS n, SUM(amount) AS total, MIN(billed_at) AS oldest FROM supplier_bills WHERE status = 'unpaid' GROUP BY currency`).all();
  const unpaid = (results || []).reduce((m, r) => m + r.n, 0);
  const oldest = (results || []).map((r) => r.oldest).sort()[0] || null;
  // Bills whose paid state KFB's rows didn't show: counted, never taken as paid (rule 5).
  const unknown = await db.prepare(`SELECT COUNT(*) AS n FROM supplier_bills WHERE status = 'unknown'`).first();
  // The morning import only rewrites a bill that changed, so the last READ is the import's time.
  const last = later(any.last, await lastSectionRead(db, "bills"));
  return {
    unpaid, totals: Object.fromEntries((results || []).map((r) => [r.currency, Math.round(r.total * 100) / 100])),
    unknownPaidState: unknown ? unknown.n : 0,
    noAmount: Number(toPay.no_amount) || 0, incomplete: Number(toPay.incomplete) || 0,
    oldest, oldestDays: oldest ? Math.floor((nowMs - Date.parse(oldest)) / 86400000) : null, lastImport: last,
    ageHours: ageHours(last, nowMs), stale: ageHours(last, nowMs) > KFB_READ_MAX_AGE_H,
  };
}

/** Import KFB bills (KFB session or by hand). Reilly pays them; this only records. */
export async function importBills(db, rows, { source = "manual", nowMs = Date.now() } = {}) {
  let n = 0;
  for (const b of rows || []) {
    if (!b || !b.bill_id || !(Number(b.amount) > 0) || !b.billed_at) continue;
    const r = await db.prepare(
      `INSERT INTO supplier_bills (bill_id, store, amount, currency, billed_at, paid_at, status, source, imported_at) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(bill_id) DO UPDATE SET paid_at = excluded.paid_at, status = excluded.status, imported_at = excluded.imported_at`
    ).bind(String(b.bill_id), b.store ?? null, Number(b.amount), String(b.currency || "EUR").toUpperCase(), b.billed_at,
      b.paid_at ?? null, b.paid_at ? "paid" : "unpaid", source, nowIso(nowMs)).run();
    n += (r.meta && r.meta.changes) || 0;
  }
  return { upserted: n };
}

/** Everything the digest reports, as numbers (null = not wired). */
export async function digestData(db, nowMs = Date.now()) {
  const quotesAny = await db.prepare(`SELECT COUNT(*) AS n, MAX(imported_at) AS last FROM kfb_quotes`).first();
  let quotes = null;
  if (quotesAny && quotesAny.n) {
    const open = await db.prepare(`SELECT status, COUNT(*) AS n FROM kfb_quotes WHERE processed_at IS NULL AND status IN ('quoted','denied') GROUP BY status`).all();
    const latest = await db.prepare(`SELECT status, COUNT(*) AS n FROM (${LATEST_QUOTE_SQL}) GROUP BY status`).all();
    const m = (rs) => Object.fromEntries((rs.results || []).map((r) => [r.status, r.n]));
    const lt = m(latest);
    const last = later(quotesAny.last, await lastSectionRead(db, "quotes"));
    quotes = { open: m(open), awaitingReilly: lt.awaiting_reilly || 0, awaitingReilly40: lt.awaiting_reilly_guess || 0, unknown: lt.unknown || 0, pending: lt.pending || 0, lastImport: last,
      ageHours: ageHours(last, nowMs), stale: ageHours(last, nowMs) > KFB_READ_MAX_AGE_H };
  }
  const { results: batches } = await db.prepare(
    `SELECT b.id, b.store, b.reprice_count, b.draft_count, b.waiver_count, b.approval_id, b.created_at FROM supplier_batches b
       JOIN approvals a ON a.id = b.approval_id WHERE a.status = 'pending' ORDER BY b.id`
  ).all();
  const asks = await db.prepare(`SELECT COUNT(*) AS n FROM kfb_size_asks WHERE status = 'pending'`).first();
  const since3 = nowIso(nowMs - 3 * 86400000);
  const { results: verdicts } = await db.prepare(`SELECT verdict, COUNT(*) AS n FROM size_recommendations WHERE checked_at >= ? GROUP BY verdict`).bind(since3).all();
  const msg = await db.prepare(`SELECT id, local_day, status, mode FROM kfb_messages ORDER BY id DESC LIMIT 1`).first();
  const { results: credits } = await db.prepare(`SELECT * FROM kfb_credits WHERE status IN ('open','claimed')`).all();
  const flags = await db.prepare(`SELECT COUNT(*) AS n FROM supply_flags WHERE created_at >= ?`).bind(nowIso(nowMs - 86400000)).first();
  const scout = await db.prepare(`SELECT COUNT(*) AS n FROM sourcing_flags`).first();
  const similar = await db.prepare(`SELECT COUNT(*) AS n FROM kfb_similar_offers WHERE verdict = 'ask_reilly' AND judged_at >= ?`).bind(nowIso(nowMs - 86400000)).first();
  // Order substitutions are fine (Reilly: "yes", 2026-10-13) but still reported, so they're never invisible.
  const subs = await db.prepare(`SELECT COUNT(*) AS n FROM kfb_similar_offers WHERE context = 'order' AND verdict = 'accepted' AND judged_at >= ?
      AND COALESCE(verdict_reason, '') NOT LIKE 'Re-judged%'`).bind(nowIso(nowMs - 86400000)).first();
  return {
    kfbSession: quotes ? "has data" : "waiting on KFB session",
    quotes,
    batchesWaiting: (batches || []).map((b) => ({ ...b, storeName: STORES[b.store] ? STORES[b.store].name : b.store })),
    sizeAsksPending: asks ? asks.n : 0,
    sizeVerdicts3d: Object.fromEntries((verdicts || []).map((v) => [v.verdict, v.n])),
    kfbMessage: msg || null,
    bills: await billsSummary(db, nowMs),
    credits: (credits || []).length ? { count: credits.length, ...creditAging(credits, nowMs) } : { count: 0 },
    preflightFlags24h: flags ? flags.n : 0,
    sourcingFlags: scout ? scout.n : 0,
    similarAsks24h: similar ? similar.n : 0,
    similarSubs24h: subs ? subs.n : 0,
  };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const totalsText = (t) => Object.entries(t || {}).map(([c, v]) => money(v, `${c} `)).join(" + ");

/** Pure: the digest text from digestData(). */
export function digestBody(d) {
  const out = [];
  if (!d.quotes) out.push("• KFB: waiting on KFB session (quotes, bills and similar offers can't be read yet: no API, CAPTCHA login).");
  else if (d.quotes.stale) {
    out.push(`• Quotes: KFB last read ${agoText(d.quotes.ageHours)}: too old to report what's waiting.`);
  } else {
    const o = d.quotes.open;
    out.push(`• Quotes: ${(o.quoted || 0) + (o.denied || 0)} not yet planned (${o.quoted || 0} quoted, ${o.denied || 0} denied)` +
      (d.quotes.awaitingReilly ? ` · ${d.quotes.awaitingReilly} waiting for your KFB confirmation (status 25)` : "") +
      (d.quotes.awaitingReilly40 ? ` · ${d.quotes.awaitingReilly40} waiting on your approval — status 40 (Reilly: FFG, 'i think')` : "") +
      (d.quotes.unknown ? ` · ${d.quotes.unknown} with an unknown status: check` : "") + ".");
  }
  for (const b of d.batchesWaiting) {
    out.push(`• Waiting on you: ${b.storeName} ${[b.reprice_count && `reprice ${b.reprice_count}`, b.draft_count && `draft ${b.draft_count}`].filter(Boolean).join(" · ")}` +
      (b.waiver_count ? ` (${b.waiver_count} stopped by the $144.95 ceiling)` : "") + ` (approval #${b.approval_id}).`);
  }
  const v = d.sizeVerdicts3d;
  const sizeBits = [];
  if (d.sizeAsksPending) sizeBits.push(`${plural(d.sizeAsksPending, "size ask")} ready for the KFB message`);
  if (v.no_fit) sizeBits.push(`${v.no_fit} order line${v.no_fit === 1 ? "" : "s"} where no factory size fits (customer message needed)`);
  if (v.no_chart) sizeBits.push(`${v.no_chart} with no size chart yet`);
  if (sizeBits.length) out.push(`• Sizes: ${sizeBits.join("; ")}.`);
  if (d.kfbMessage) out.push(`• Last KFB message (${d.kfbMessage.local_day}): ${d.kfbMessage.status}${d.kfbMessage.mode === "shadow" ? " (shadow)" : ""}.`);
  if (!d.bills) out.push("• Bills: waiting on KFB session.");
  else if (d.bills.stale) out.push(`• Bills: KFB last read ${agoText(d.bills.ageHours)}: too old to say what's unpaid.`);
  else {
    const unk = (d.bills.unknownPaidState ? ` · ${plural(d.bills.unknownPaidState, "bill")} whose paid state KFB didn't show: check` : "") +
      (d.bills.noAmount ? ` · ${plural(d.bills.noAmount, "bill")} read with no amount (not listed: check in KFB)` : "") +
      (d.bills.incomplete ? ` · ${plural(d.bills.incomplete, "bill")} cut off by the read (not listed until read whole)` : "");
    if (!d.bills.unpaid) out.push(`• Bills: ${d.bills.unknownPaidState || d.bills.noAmount || d.bills.incomplete ? "none marked unpaid" : "none unpaid"}${unk}.`);
    else out.push(`• Bills: ${plural(d.bills.unpaid, "unpaid bill")}, ${totalsText(d.bills.totals)}, oldest ${d.bills.oldestDays} day${d.bills.oldestDays === 1 ? "" : "s"}${unk}.`);
  }
  if (d.credits.count) {
    out.push(`• KFB owes: ${plural(d.credits.count, "credit")}` + (Object.keys(d.credits.totals).length ? `, ${totalsText(d.credits.totals)}` : "") +
      (d.credits.unknownAmount ? ` (+${d.credits.unknownAmount} amount not known)` : "") + `, oldest ${d.credits.oldestDays} days.`);
  }
  if (d.preflightFlags24h) out.push(`• Pre-flight: ${plural(d.preflightFlags24h, "order line")} flagged in 24h.`);
  if (d.similarSubs24h) out.push(`• Similar substitutes on customers' orders: ${d.similarSubs24h} in 24h (fine per your rule; recorded).`);
  if (d.similarAsks24h) out.push(`• Similar offers the rule doesn't cover: ${d.similarAsks24h} (check).`);
  if (d.sourcingFlags) out.push(`• Sourcing: ${plural(d.sourcingFlags, "category")} failing at KFB (flag only).`);
  return out.join("\n");
}

export async function runDigest(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const { day, minutes } = easternClock(nowMs);
  if (minutes < DIGEST_AFTER_MIN) return { skipped: "before 07:00 Eastern" };
  const have = await db.prepare(`SELECT local_day FROM supplier_digests WHERE local_day = ?`).bind(day).first();
  if (have) return { skipped: "already written today" };
  const data = await digestData(db, nowMs);
  const body = digestBody(data);
  const r = await db.prepare(`INSERT OR IGNORE INTO supplier_digests (local_day, created_at, body, data) VALUES (?,?,?,?)`)
    .bind(day, nowIso(nowMs), body, JSON.stringify(data)).run();
  if (r.meta && r.meta.changes) {
    await logEvent(db, { actor: ACTOR, kind: "digest.written", target: "core.briefer", at: nowIso(nowMs),
      summary: `Supplier digest for ${day} ready for the brief (${body.split("\n").length} line${body.split("\n").length === 1 ? "" : "s"})`, data: { day } });
  }
  return { day, body };
}

/** For the Briefer: the latest digest (today's if written). */
export async function latestSupplierDigest(db) {
  const r = await db.prepare(`SELECT * FROM supplier_digests ORDER BY local_day DESC LIMIT 1`).first();
  return r ? { ...r, data: r.data ? JSON.parse(r.data) : null } : null;
}
