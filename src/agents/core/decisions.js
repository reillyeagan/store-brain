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
import { PARCEL_TRACKING_DECISION, AUDIENCE_DECISION, SHEETS_WRITE_DECISION, SHEETS_FILL_DECISION } from "../../config/stores.js";

const ACTOR = "core.decisions";

/** Reilly answered the open questions in chat on 2026-10-13 at about 20:23 Eastern. */
const OPEN_QS = "chat 2026-10-13 (open-questions answers)";
const OPEN_QS_AT = "2026-10-14T00:23:00Z";

/**
 * Verbatim quotes, with the date Reilly said them and where they are written down. The specs
 * give the day, not the time: 12:00Z is a placeholder time on that day.
 */
export const SEED_DECISIONS = Object.freeze([
  // Go-live (rule 11), 2026-10-14 20:46 New York. Wired: the live switches in wrangler.toml and
  // src/config/live.js. Within his standing decisions: Shopify read-only, customer emails stay
  // drafts (cs.sending), supplier messages stay copy-paste (sup.kfb_channel), ads watch-only (media.role).
  { at: "2026-10-15T00:46:00Z", topic: "core.go_live", scope: "all", source: "chat 2026-10-14",
    words: "i want to move EVERYTHING in the brain to live so its all working - can we do that" },
  { at: "2026-10-15T00:39:00Z", topic: "core.agents_removed", scope: "all", source: "chat 2026-10-14 (Exception Fixer + Sourcing Scout removed)",
    words: "delete the other 2 exception and sourcing scout agents" },
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
  { at: "2026-10-11T12:00:00Z", topic: "sup.dont_fix_store", scope: "all", source: "docs/specs/supplier.md",
    words: "dont fix the store" },
  { at: "2026-10-11T12:00:00Z", topic: "sup.returns", scope: "all", source: "docs/specs/supplier.md",
    words: "i never return things to KFB." },
  { at: PARCEL_TRACKING_DECISION.at, topic: PARCEL_TRACKING_DECISION.topic, scope: "all", source: "src/config/stores.js PARCEL_TRACKING_DECISION",
    words: PARCEL_TRACKING_DECISION.words },

  // Open-questions answers, chat 2026-10-13 ~20:23 Eastern. Words verbatim (typos kept). Where
  // the words are only "yes"/"no", the question is in `source` so the quote stands on its own.
  { at: AUDIENCE_DECISION.at, topic: AUDIENCE_DECISION.topic, scope: "all", source: `${OPEN_QS} — wired: stores.js audience, Size Checker`,
    words: AUDIENCE_DECISION.words },
  { at: OPEN_QS_AT, topic: "sup.kfb_match_key", scope: "all", source: `${OPEN_QS} — Q: match KFB products to Shopify by product handle or KFB un_good_id?`,
    words: "product handle is prob best" },
  { at: OPEN_QS_AT, topic: "sup.similar_substitutions", scope: "all", source: "chat 2026-10-13 — Q: does 'similar always fine' cover substitutions on customer orders?",
    words: "yes" },
  { at: OPEN_QS_AT, topic: "cat.min_margin.aub", scope: "aub", source: "chat 2026-10-13 — Q: confirm a $30 minimum gross margin per unit for Auberlane?",
    words: "yes" },
  { at: OPEN_QS_AT, topic: "cat.high_margin_exemption", scope: "all", source: "chat 2026-10-13 — Q: should high-margin products be exempt from the pricing rules?",
    words: "no" },
  { at: OPEN_QS_AT, topic: "cs.size_up_disclosure", scope: "all", source: "chat 2026-10-13 — Q: tell the customer when a bigger Chinese size ships?",
    words: "no unless they ask" },
  { at: OPEN_QS_AT, topic: "sup.kfb_quote_status_40", scope: "all", source: `${OPEN_QS} — Reilly's best guess ("i think"), not confirmed`,
    words: "FFG quote status 40 i think means i just havent approved it" },
  // A fact for Risk, not a rule: #1098 is a chargeback (dispute), so the refund question on it is closed.
  { at: OPEN_QS_AT, topic: "risk.order_1098", scope: "hc", source: `${OPEN_QS} — H&C #1098: now a chargeback; refund question closed`,
    words: "1098 turned into a chargeback and the shipping status still isnt updating" },
  { at: OPEN_QS_AT, topic: "cs.review_requests", scope: "all", source: OPEN_QS,
    words: "off turn them off on all stores please" },
  // P&L workbooks, chat 2026-10-14. Wired: the P&L Sheets agent (src/agents/pnl/sheets.js),
  // kill switch env SHEETS_WRITE = "0".
  { at: SHEETS_WRITE_DECISION.at, topic: SHEETS_WRITE_DECISION.topic, scope: "all", source: "chat 2026-10-14 — wired: pnl.sheets writes blank input cells, SHEETS_WRITE=0 stops it",
    words: SHEETS_WRITE_DECISION.words },
  { at: SHEETS_FILL_DECISION.at, topic: SHEETS_FILL_DECISION.topic, scope: "all", source: "chat 2026-10-14 — wired: pnl.sheets fills days the brain is missing from the workbooks",
    words: SHEETS_FILL_DECISION.words },
  // Wired: pnl.sheets runs once a day from 07:00 New York and fills yesterday (sheets.js runSheetsMorning).
  { at: "2026-10-14T23:03:00Z", topic: "pnl.sheets_schedule", scope: "all", source: "chat 2026-10-14",
    words: "P&L sheets only have to update once per day, in the monring, it should fill in yesterdays P&L. does not need to be hourly for the google sheets" },
  // Wired: cs/starterDrafts.js — flagged emails also get a starting reply in Gmail (decision stays his).
  { at: "2026-10-15T12:25:00Z", topic: "cs.starter_drafts", scope: "all", source: "chat 2026-10-15 — looking at Waiting on you (Escalation Desk cards)",
    words: "i thought the brain was supposed to draft replies for me, not just tell me" },
  // Wired: pnl/sheets.js brainValue "revenue" = each order's original total (products + shipping + tax).
  { at: "2026-10-15T14:00:00Z", topic: "pnl.sheet_revenue", scope: "all", source: "chat 2026-10-15 — Q: what counts as Revenue in the P&L sheets? Reilly picked \"Everything the customer paid\" (products + shipping + tax)",
    words: "that P&L sheet needs to be exactly accurate, with shipping accounted for, as well as tax. can we fix it? — Everything the customer paid" },
  // Wired: pnl/sheets.js brainValue "cog_eur" estimate + COG_CORRECT_DAYS corrections.
  { at: "2026-10-15T14:00:00Z", topic: "pnl.sheet_cog_estimate", scope: "all", source: "chat 2026-10-15",
    words: "COGs are not always updated the day after, so like for yesterday it is very possible we will not have full COGs today, because of this, COGs for yesteerday should always be an estimate, that is filled in with accurate numbers at a later time" },
  // Wired: cs/replyWriter.js signOff + both prompts.
  { at: "2026-10-15T14:03:00Z", topic: "cs.sign_off", scope: "all", source: "chat 2026-10-15 — on a Gmail draft signed \"Holt & Crane Customer Care\"",
    words: "it should say just \"Holt & Crane\" at the end, not cusotmer care" },
  // Wired: stores.js aub.guyEnd = 2026-10-13 (the cut-off his Auberlane sheet books).
  { at: "2026-10-16T16:22:00Z", topic: "guy.end.aub", scope: "aub", source: "chat 2026-10-16 — end date taken from his Auberlane sheet (SETUP!B11: booked through 10-13)",
    words: "also keep in mind i no longer have a mediabuyer on auberlane" },
  // Wired: kfbImport.js keeps each quote's factory link; supplier/chartFetch.js reads the chart.
  { at: "2026-10-20T14:39:00Z", topic: "sup.size_chart_source", scope: "all", source: "chat 2026-10-20",
    words: "every quoted product in KFB has a \"supplier link\" button on it, that you can view via the browser. in most cases, if you open that supplier link, you should be able to see the size chart." },
  { at: "2026-10-20T14:45:00Z", topic: "sup.chart_fetch", scope: "all", source: "chat 2026-10-20 — answer to: which way should the brain get the size charts? (1688 shows a slider check to automated browsing)",
    words: "Brain fetches 1688 itself" },
]);

/** Latest (unsuperseded) decision on a topic, or null. */
export async function currentDecision(db, topic) {
  // Any of the topic's names (old "supplier.*" rows still count as the same topic).
  const names = topicNames(topic);
  return db.prepare(
    `SELECT * FROM decisions WHERE topic IN (${names.map(() => "?").join(", ")}) AND id NOT IN (SELECT supersedes FROM decisions WHERE supersedes IS NOT NULL)
     ORDER BY id DESC LIMIT 1`
  ).bind(...names).first();
}

/**
 * Record one decision in Reilly's exact words. Supersedes the current decision on the same
 * topic (kept as history). The same words on the same topic twice are not recorded twice.
 * @returns {{id:number, created:boolean, supersedes:number|null}}
 */
export async function recordDecision(db, { topic, words, scope = "all", at = null }, { nowMs = Date.now(), quiet = false, source = null } = {}) {
  if (!topic || typeof topic !== "string") throw new Error("recordDecision: topic is required");
  topic = canonicalTopic(topic); // one name per topic; old aliases are recorded under the canonical name
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
 * One topic name per quote. The Supplier seed (src/agents/supplier/decisions.js) used
 * "supplier.*" names for some of the same quotes; those map onto the canonical names here so
 * a quote is never recorded twice under two topics, and rows already stored under an old name
 * still count.
 */
export const TOPIC_ALIASES = Object.freeze({
  "supplier.approve_price_rewrites": "pricing.approval",
  "supplier.dont_fix_store": "sup.dont_fix_store",
  "sup.store_listings": "sup.dont_fix_store",
});
export function canonicalTopic(topic) {
  const t = String(topic || "");
  if (TOPIC_ALIASES[t]) return TOPIC_ALIASES[t];
  return t.startsWith("supplier.") ? `sup.${t.slice(9)}` : t;
}
/** Every stored name a canonical topic may have been written under. */
export function topicNames(topic) {
  const c = canonicalTopic(topic);
  const names = new Set([c]);
  if (c.startsWith("sup.")) names.add(`supplier.${c.slice(4)}`);
  for (const [alias, to] of Object.entries(TOPIC_ALIASES)) if (to === c) names.add(alias);
  return [...names];
}

/**
 * THE guard every seeded decision goes through (Decision Keeper seed, Supplier seed, the
 * parcel-tracking switch-off). A seed is inserted only when its topic (under any of its
 * names) has no decision at all: the same words already there -> nothing to do; other words
 * there -> those are Reilly's newer words, and a seed never overrules them. Dedupe is by
 * topic, never by words alone, so a generic quote ("looks good") on one topic can't block
 * another topic's seed.
 * @returns {{added:boolean, id?:number, reason?:string}}
 */
export async function seedDecision(db, s, { nowMs = Date.now() } = {}) {
  const topic = canonicalTopic(s.topic);
  const names = topicNames(topic);
  const marks = names.map(() => "?").join(", ");
  const same = await db.prepare(`SELECT id FROM decisions WHERE topic IN (${marks}) AND words = ? LIMIT 1`).bind(...names, s.words).first();
  if (same) return { added: false, id: same.id, reason: "already recorded" };
  const other = await db.prepare(`SELECT id FROM decisions WHERE topic IN (${marks}) LIMIT 1`).bind(...names).first();
  if (other) return { added: false, id: other.id, reason: "topic already has Reilly's words" };
  const r = await recordDecision(db, { ...s, topic }, { nowMs, quiet: true, source: s.source || null });
  return { added: r.created, id: r.id };
}

/** Insert the Decision Keeper's seed list through the guard. Idempotent. */
export async function seedDecisions(db, { nowMs = Date.now() } = {}) {
  let added = 0;
  for (const s of SEED_DECISIONS) {
    if ((await seedDecision(db, s, { nowMs })).added) added++;
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
  const names = topic ? topicNames(topic) : null;
  const { results } = await db.prepare(
    `SELECT d.*, (SELECT n.id FROM decisions n WHERE n.supersedes = d.id LIMIT 1) AS superseded_by
       FROM decisions d ${names ? `WHERE d.topic IN (${names.map(() => "?").join(", ")})` : ""} ORDER BY d.at DESC, d.id DESC LIMIT ?`
  ).bind(...(names ? [...names, lim] : [lim])).all();
  const rows = (results || []).map((r) => ({ ...r, current: r.superseded_by == null, settled: !!r.settled }));
  return currentOnly ? rows.filter((r) => r.current) : rows;
}

export async function decisionsState(db) {
  const all = await listDecisions(db, { limit: 50 });
  const c = await db.prepare(`SELECT COUNT(*) AS n FROM decisions`).first();
  return { total: (c && c.n) || 0, current: all.filter((d) => d.current), superseded: all.filter((d) => !d.current).slice(0, 20) };
}
