/**
 * media.search_terms — Search Terms & Exclusions. SHADOW / WATCH ONLY.
 *
 * Does: per store, once a day, reads the search terms report for the last 14 closed days,
 *   stores it, and PROPOSES negative keywords (never adds them — Guy runs the accounts):
 *    - code: terms that spent at least MEDIA_WASTE_MIN_USD (default $15) with zero conversions,
 *    - Claude (optional, one small batch per store per day): terms that look irrelevant to
 *      what the store sells. Claude only classifies; a term it names that isn't in the batch
 *      is ignored, and every number comes from code.
 * Inputs: Google Ads search_term_view (read-only), recent order_lines titles (context for Claude).
 * Outputs: media_search_terms rows, media_proposals (kind negative_keyword) shown on the page,
 *   and ONE digest event per store per run. No approvals are created (Reilly's queue stays
 *   for real decisions); proposals that stop qualifying turn 'stale'.
 * Note: Performance Max search terms are not in this report (Google limits them).
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { accountTz, windowFor, micros, int, real, r2, upsertProposal, staleUnseenProposals, storeName, money } from "./common.js";
import { dailyRead } from "./reads.js";

export const AGENT = "media.search_terms";
export const TERM_DAYS = 14;
export const WASTE_MIN_USD_DEFAULT = 15;
export const AI_BATCH = 40;

/** Pure: GAQL rows → one row per (term, campaign). */
export function parseTermRows(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const t = r && r.searchTermView && r.searchTermView.searchTerm;
    const c = (r && r.campaign) || {};
    if (!t || c.id == null) continue;
    const k = `${t.toLowerCase()}|${c.id}`;
    const m = r.metrics || {};
    const cur = out.get(k) || { term: t.toLowerCase(), campaign_id: String(c.id), campaign_name: c.name || null,
      term_status: r.searchTermView.status || null, cost: 0, clicks: 0, impressions: 0, conversions: 0, conv_value: 0 };
    cur.cost += micros(m.costMicros);
    cur.clicks += int(m.clicks);
    cur.impressions += int(m.impressions);
    cur.conversions += real(m.conversions);
    cur.conv_value += real(m.conversionsValue);
    out.set(k, cur);
  }
  return [...out.values()].map((v) => ({ ...v, cost: r2(v.cost), conv_value: r2(v.conv_value) }));
}

/** Pure: the code rule. Already-excluded terms are skipped (Guy has already dealt with them). */
export function wastedTerms(terms, minUsd) {
  return terms
    .filter((t) => t.conversions <= 0 && t.cost >= minUsd && t.term_status !== "EXCLUDED")
    .sort((a, b) => b.cost - a.cost);
}

const keyFor = (t) => `neg:${t.campaign_id}:${t.term}`;

export async function runSearchTerms(env, { storeId, session, nowMs = Date.now(), fetchImpl = fetch }) {
  const db = env.DB;
  const tz = await accountTz(env, storeId, session);
  const { today, from, to } = windowFor(nowMs, tz, TERM_DAYS);
  const rows = await session.query(storeId,
    `SELECT search_term_view.search_term, search_term_view.status, campaign.id, campaign.name,
       metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value
     FROM search_term_view WHERE segments.date BETWEEN '${from}' AND '${to}' AND metrics.cost_micros > 0`);
  const terms = parseTermRows(rows);
  const at = nowIso(nowMs);
  // The table holds the latest window only: replace it (the query succeeded, so this is the truth).
  await db.prepare(`DELETE FROM media_search_terms WHERE store = ?`).bind(storeId).run();
  for (const t of terms) {
    await db.prepare(
      `INSERT INTO media_search_terms (store, term, campaign_id, campaign_name, term_status, window_from, window_to, cost, clicks, impressions, conversions, conv_value, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(storeId, t.term, t.campaign_id, t.campaign_name, t.term_status, from, to, t.cost, t.clicks, t.impressions, t.conversions, t.conv_value, at).run();
  }

  const minUsd = Number(env.MEDIA_WASTE_MIN_USD || WASTE_MIN_USD_DEFAULT);
  const wasted = wastedTerms(terms, minUsd);
  const keys = [];
  let fresh = 0;
  for (const t of wasted.slice(0, 50)) {
    const key = keyFor(t);
    keys.push(key);
    if (await upsertProposal(db, {
      store: storeId, agent: AGENT, key, kind: "negative_keyword", at,
      title: `Exclude "${t.term}" in "${t.campaign_name || t.campaign_id}": ${money(t.cost)} spent, ${t.clicks} clicks, 0 conversions`,
      detail: { term: t.term, campaign_id: t.campaign_id, campaign_name: t.campaign_name, match: "exact", reason: "spend without conversions",
        cost: t.cost, clicks: t.clicks, impressions: t.impressions, window: { from, to }, source: "code" },
    })) fresh += 1;
  }

  // Claude: relevance of the costliest non-converting terms the code rule didn't catch.
  let ai = "not needed";
  const candidates = terms
    .filter((t) => t.conversions <= 0 && t.cost >= 1 && t.term_status !== "EXCLUDED" && !keys.includes(keyFor(t)))
    .sort((a, b) => b.cost - a.cost).slice(0, AI_BATCH);
  if (candidates.length) {
    const titles = await db.prepare(
      `SELECT title, COUNT(*) AS n FROM order_lines WHERE store = ? AND title IS NOT NULL GROUP BY title ORDER BY n DESC LIMIT 15`
    ).bind(storeId).all().then((r) => (r.results || []).map((x) => x.title)).catch(() => []);
    const r = await dailyRead(env, {
      store: storeId, agent: AGENT, day: today, json: true, maxTokens: 500, label: `${storeName(storeId)} search-term relevance`,
      system: "You check Google Ads search terms for an online clothing store. Mark ONLY terms clearly unrelated to what the store sells (wrong product type, jobs, free, DIY, other brands' customer service, etc). When unsure, leave the term out. Return {\"irrelevant\":[{\"term\":\"...\",\"reason\":\"<8 words\"}]} using terms exactly as given.",
      user: JSON.stringify({ store: storeName(storeId), sells: titles, terms: candidates.map((t) => t.term) }),
    }, { fetchImpl, nowMs });
    if (r.json) {
      const byTerm = new Map(candidates.map((t) => [t.term, t]));
      const named = Array.isArray(r.json.irrelevant) ? r.json.irrelevant : [];
      let accepted = 0;
      for (const x of named.slice(0, AI_BATCH)) {
        const t = x && byTerm.get(String(x.term || "").toLowerCase());
        if (!t) continue; // not in the batch → ignored (never trust an invented term)
        const key = keyFor(t);
        keys.push(key); accepted += 1;
        if (await upsertProposal(db, {
          store: storeId, agent: AGENT, key, kind: "negative_keyword", at,
          title: `Exclude "${t.term}" in "${t.campaign_name || t.campaign_id}": looks unrelated (${String(x.reason || "").slice(0, 60)}), ${money(t.cost)} spent`,
          detail: { term: t.term, campaign_id: t.campaign_id, campaign_name: t.campaign_name, match: "exact", reason: `looks irrelevant: ${String(x.reason || "").slice(0, 80)}`,
            cost: t.cost, clicks: t.clicks, impressions: t.impressions, window: { from, to }, source: "claude" },
        })) fresh += 1;
      }
      ai = `${accepted} irrelevant`;
    } else if (r.already) {
      // Today's batch already ran: keep yesterday's AI proposals open rather than staling them.
      const { results } = await db.prepare(`SELECT key FROM media_proposals WHERE store = ? AND agent = ? AND status = 'open' AND detail LIKE '%"source":"claude"%'`).bind(storeId, AGENT).all();
      for (const x of results || []) keys.push(x.key);
      ai = "already ran today";
    } else {
      ai = `waiting on AI (${r.skipped || r.failed})`;
      const { results } = await db.prepare(`SELECT key FROM media_proposals WHERE store = ? AND agent = ? AND status = 'open' AND detail LIKE '%"source":"claude"%'`).bind(storeId, AGENT).all();
      for (const x of results || []) keys.push(x.key);
    }
  }
  const staled = await staleUnseenProposals(db, { store: storeId, agent: AGENT, keys, at });

  const wastedCost = r2(wasted.reduce((s, t) => s + t.cost, 0));
  await logEvent(db, {
    actor: AGENT, kind: "media.search_terms.digest", store: storeId, target: "sys.ads", at,
    summary: `${storeName(storeId)}: ${terms.length} search terms read (${from} to ${to}); ${wasted.length} spent ${money(minUsd)}+ with no conversion (${money(wastedCost)}); ${keys.length} exclusions proposed (${fresh} new), not applied`,
    data: { terms: terms.length, wasted: wasted.length, wasted_cost: wastedCost, proposed: keys.length, new: fresh, staled, ai },
  });
  return `ok: ${terms.length} terms, ${keys.length} proposals (${fresh} new), AI ${ai}`;
}
