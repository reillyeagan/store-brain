/**
 * Decision Keeper (core.decisions) — plain code, L2, shadow-safe (writes only to the ledger).
 *
 * What it does: keeps Reilly's decisions in the `decisions` table, word for word (rule 10:
 * "Only Reilly's words make a decision. Record them verbatim"). A new decision on a topic
 * supersedes the previous one on that topic; the old row stays as history.
 * Inputs: Reilly's words (passed in by whoever heard them) and the static seed below.
 * Outputs: `decisions` rows, a `decision.recorded` event per new row.
 *
 * The seed is a fixed list of quotes copied by hand from docs/specs/*.md and stores.js.
 * Nothing is parsed automatically: a parser could put words in Reilly's mouth.
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { PARCEL_TRACKING_DECISION } from "../../config/stores.js";

const ACTOR = "core.decisions";

/**
 * Verbatim quotes, with the date Reilly said them and where they are written down. The specs
 * give the day, not the time: 12:00Z is a placeholder time on that day.
 */
export const SEED_DECISIONS = Object.freeze([
  { at: "2026-10-11T12:00:00Z", topic: "pnl.guy_fee", scope: "all", source: "docs/specs/pnl-finance.md (Guy's fee, 2026-10-11)",
    words: "10% is constant its been going on since the 7th" },
  { at: "2026-10-11T12:00:00Z", topic: "core.morning_brief", scope: "all", source: "docs/specs/core.md",
    words: "looks good" },
  { at: "2026-10-11T12:00:00Z", topic: "core.brief_voice", scope: "all", source: "docs/specs/core.md",
    words: "similar to the eagano brain, short and concise while getting the info across and giving a lot of data and reasoning." },
  { at: "2026-10-11T12:00:00Z", topic: "core.knowledge_split", scope: "all", source: "docs/specs/core.md",
    words: "yes copy everything we have about the stores into the new store brain, and yes that split sounds good. but new information should go into both the store brain and eagano, because eagano is how i make changes and build things, and it is the TRUE ultimate data hub for EVERYTHING" },
  { at: "2026-10-11T12:00:00Z", topic: "ful.thresholds", scope: "all", source: "docs/specs/fulfillment.md",
    words: "yeah i think that looks good" },
  { at: "2026-10-11T12:00:00Z", topic: "dashboard.look", scope: "all", source: "docs/specs/dashboard.md",
    words: "lets do something more similar to the current eagano dash with pastel colors, minimal, etc and i like being able to see each individual agent and person like in the screenshot" },
  { at: "2026-10-11T12:00:00Z", topic: "dashboard.pnl_page", scope: "all", source: "docs/specs/dashboard.md",
    words: "im a big fan of the eagano P&L right now, with the funnel, the 8 P&L blocks with last day, 7 day, 28 day, all time, etc and the ability to choose and look at any day." },
  { at: "2026-10-11T12:00:00Z", topic: "cs.express_shipping", scope: "all", source: "docs/specs/customer-service.md",
    words: "express is fine its all been good and getting delivered on time" },
  { at: "2026-10-11T12:00:00Z", topic: "cs.sending", scope: "all", source: "docs/specs/customer-service.md",
    words: "lets start of with the emails being put in my drafts that i review and click send, then once im ready ill tell you to just start sending them." },
  { at: "2026-10-11T12:00:00Z", topic: "cs.old_bot", scope: "all", source: "docs/specs/customer-service.md",
    words: "yea switch that off, also clean up all the old bot replies and drafts and flags, etc." },
  { at: "2026-10-11T12:00:00Z", topic: "cs.reviews", scope: "all", source: "docs/specs/customer-service.md",
    words: "dont follow up on reviews" },
  { at: "2026-10-11T12:00:00Z", topic: "cs.store_inboxes", scope: "hc", source: "docs/specs/customer-service.md",
    words: "it has its own gmail, we need to connect it. also, eventually all the stores will have their own gmails" },
  { at: "2026-10-11T12:00:00Z", topic: "media.role", scope: "all", source: "docs/specs/media.md",
    words: "guy is still the mediabuyer, dont worry about the spend cieling, and for now, the media section is just watching more than anything. we are not going to make any changes ourselves, guy is doing all of that. but eventually I want to drop him as the mediabuyer and just use the store brain, but we need more data for it to work better" },
  { at: "2026-10-11T12:00:00Z", topic: "catalog.scope", scope: "all", source: "docs/specs/catalog.md",
    words: "sure looks good" },
  { at: "2026-10-11T12:00:00Z", topic: "risk.scope", scope: "all", source: "docs/specs/risk.md",
    words: "I buy the items, not KFB. there is no risk in KFB pulling orders dont worry about that, but fraud screen for shopify orders is still good, just know that it is VERY rare i will need to do anything, i have not cancelled any so far." },
  { at: "2026-10-11T12:00:00Z", topic: "pricing.ceiling", scope: "all", source: "docs/specs/supplier.md",
    words: "max price 144.95 all 3 stores" },
  { at: "2026-10-11T12:00:00Z", topic: "pricing.floor.hc", scope: "hc", source: "docs/specs/supplier.md",
    words: "min price 44.95 on H&C going forwards" },
  { at: "2026-10-11T12:00:00Z", topic: "pricing.approval", scope: "all", source: "docs/specs/supplier.md",
    words: "yes i need to approve every price rewrite, as well as draft products, etc" },
  { at: "2026-10-11T12:00:00Z", topic: "sup.kfb_channel", scope: "all", source: "docs/specs/supplier.md",
    words: "honestly we could just use copy-paste messages instead, the brain gives me a notifaction with the supplier message ready to copy paste then i go and send it myeslf" },
  { at: "2026-10-11T12:00:00Z", topic: "sup.product_publishing", scope: "all", source: "docs/specs/supplier.md",
    words: "ill do the product publishing myself, and will do the get product thing in KFB. the store brain should never need to worry about it." },
  { at: "2026-10-11T12:00:00Z", topic: "sup.size_fit_rule", scope: "all", source: "docs/specs/supplier.md",
    words: "idk if the sizing between US and chinese sizes seems accurate then its fine, but if the customer orders a M and the chinese M looks more like a S, we might want to send out a chinese L" },
  { at: "2026-10-11T12:00:00Z", topic: "sup.size_measurements", scope: "all", source: "docs/specs/supplier.md",
    words: "check everything and make logical decisions" },
  { at: "2026-10-11T12:00:00Z", topic: "sup.store_listings", scope: "all", source: "docs/specs/supplier.md",
    words: "dont fix the store" },
  { at: "2026-10-11T12:00:00Z", topic: "sup.returns", scope: "all", source: "docs/specs/supplier.md",
    words: "i never return things to KFB." },
  { at: PARCEL_TRACKING_DECISION.at, topic: PARCEL_TRACKING_DECISION.topic, scope: "all", source: "src/config/stores.js PARCEL_TRACKING_DECISION",
    words: PARCEL_TRACKING_DECISION.words },
]);

/** Latest (unsuperseded) decision on a topic, or null. */
export async function currentDecision(db, topic) {
  return db.prepare(
    `SELECT * FROM decisions WHERE topic = ? AND id NOT IN (SELECT supersedes FROM decisions WHERE supersedes IS NOT NULL)
     ORDER BY id DESC LIMIT 1`
  ).bind(topic).first();
}

/**
 * Record one decision in Reilly's exact words. Supersedes the current decision on the same
 * topic (kept as history). The same words on the same topic twice are not recorded twice.
 * @returns {{id:number, created:boolean, supersedes:number|null}}
 */
export async function recordDecision(db, { topic, words, scope = "all", at = null }, { nowMs = Date.now(), quiet = false, source = null } = {}) {
  if (!topic || typeof topic !== "string") throw new Error("recordDecision: topic is required");
  if (!words || typeof words !== "string" || !words.trim()) throw new Error("recordDecision: Reilly's words are required, verbatim");
  const prev = await currentDecision(db, topic);
  if (prev && prev.words === words) return { id: prev.id, created: false, supersedes: prev.supersedes ?? null };
  const when = at || nowIso(nowMs);
  const res = await db.prepare(
    `INSERT INTO decisions (at, topic, words, scope, supersedes, settled) VALUES (?, ?, ?, ?, ?, 1)`
  ).bind(when, topic, words, scope, prev ? prev.id : null).run();
  const id = res.meta && res.meta.last_row_id;
  if (!quiet) {
    await logEvent(db, {
      actor: ACTOR, kind: "decision.recorded", target: "core.librarian",
      summary: `Decision recorded (${topic}): "${words.slice(0, 160)}"${prev ? ` — replaces #${prev.id}` : ""}`,
      data: { decisionId: id, topic, scope, supersedes: prev ? prev.id : null, source }, at: nowIso(nowMs),
    });
  }
  return { id, created: true, supersedes: prev ? prev.id : null };
}

/**
 * Insert the seed list. Idempotent: a seed quote already present on its topic (current or
 * historical) is skipped, and a seed never supersedes a newer decision Reilly made since.
 */
export async function seedDecisions(db, { nowMs = Date.now() } = {}) {
  let added = 0;
  for (const s of SEED_DECISIONS) {
    // Skip words already recorded under any topic (the Supplier seed records some of the same quotes).
    const have = await db.prepare(`SELECT id FROM decisions WHERE words = ? LIMIT 1`).bind(s.words).first();
    if (have) continue;
    const newer = await db.prepare(`SELECT id FROM decisions WHERE topic = ? LIMIT 1`).bind(s.topic).first();
    if (newer) continue; // the topic already has words from Reilly; the seed doesn't overrule them
    await recordDecision(db, s, { nowMs, quiet: true, source: s.source });
    added++;
  }
  if (added) {
    await logEvent(db, {
      actor: ACTOR, kind: "decision.seeded", target: "core.librarian",
      summary: `${added} of Reilly's decisions copied verbatim from the specs into the decisions table`,
      data: { added }, at: nowIso(nowMs),
    });
  }
  return { added };
}

/** Decisions, newest first; `current` = not superseded. */
export async function listDecisions(db, { topic = null, limit = 50, currentOnly = false } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const { results } = await db.prepare(
    `SELECT d.*, (SELECT n.id FROM decisions n WHERE n.supersedes = d.id LIMIT 1) AS superseded_by
       FROM decisions d ${topic ? "WHERE d.topic = ?" : ""} ORDER BY d.at DESC, d.id DESC LIMIT ?`
  ).bind(...(topic ? [topic, lim] : [lim])).all();
  const rows = (results || []).map((r) => ({ ...r, current: r.superseded_by == null, settled: !!r.settled }));
  return currentOnly ? rows.filter((r) => r.current) : rows;
}

export async function decisionsState(db) {
  const all = await listDecisions(db, { limit: 50 });
  const c = await db.prepare(`SELECT COUNT(*) AS n FROM decisions`).first();
  return { total: (c && c.n) || 0, current: all.filter((d) => d.current), superseded: all.filter((d) => !d.current).slice(0, 20) };
}
