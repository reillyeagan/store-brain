/**
 * media.guy_monitor — Guy Monitor. SHADOW / WATCH ONLY. Plain code.
 *
 * Does: per store, every few hours, reads the Google Ads change history (change_event, last
 *   7 days; Google keeps 30 days and returns at most the LIMIT asked) and stores each change
 *   once, deduped by Google's own change id. Each new change becomes ONE event
 *   (kind media.change, actor media.guy_monitor), at most 25 per run so a big first import
 *   is spread over a few runs instead of flooding the feed. This is how Reilly sees what Guy
 *   (or anyone, or Google's automation) changed, and when.
 *   It then tracks what happened after each campaign change: spend, Google conversion value
 *   and ROAS for the 7 days before vs the 7 (and later 14) days after, from media_campaign_days.
 * Inputs: Google Ads change_event (read-only), media_campaign_days.
 * Outputs: media_changes rows (with `effect`), media.change events.
 * Guy's fee (10% of ad spend since 2026-09-07) is already in the P&L; not computed here.
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { accountTz, windowFor, minusDays, r2, storeName, money } from "./common.js";

export const AGENT = "media.guy_monitor";
export const CHANGE_DAYS = 7;
export const EVENTS_PER_RUN = 25;
export const EFFECTS_PER_RUN = 10;

const camel = (s) => String(s).replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function pathGet(obj, path) {
  let cur = obj;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[camel(seg)];
  }
  return cur;
}

/** The one populated resource inside ChangedResource ({ campaignBudget: {...} } → that object). */
function inner(res) {
  if (!res || typeof res !== "object") return null;
  const k = Object.keys(res)[0];
  return k ? res[k] : null;
}

function show(field, v) {
  if (v === undefined || v === null) return "—";
  if (/micros$/i.test(field) && Number.isFinite(Number(v))) return money(Number(v) / 1e6);
  if (typeof v === "object") return JSON.stringify(v).slice(0, 40);
  return String(v).slice(0, 40);
}

/** Pure: one change_event row → what we store and say. */
export function describeChange(row, campaignNames = new Map()) {
  const ce = (row && row.changeEvent) || {};
  const fields = String(ce.changedFields || "").split(",").map((s) => s.trim()).filter(Boolean);
  const oldR = inner(ce.oldResource); const newR = inner(ce.newResource);
  const diffs = fields.slice(0, 4).map((f) => ({ field: f, from: show(f, pathGet(oldR, f)), to: show(f, pathGet(newR, f)) }));
  const campaignId = ce.campaign ? String(ce.campaign).split("/").pop() : null;
  const who = ce.userEmail || ce.clientType || "unknown";
  const what = `${String(ce.resourceChangeOperation || "CHANGE").toLowerCase()} ${String(ce.changeResourceType || "item").toLowerCase().replace(/_/g, " ")}`;
  const where = campaignId ? ` in "${campaignNames.get(campaignId) || campaignId}"` : "";
  const detail = diffs.length ? `: ${diffs.map((d) => `${d.field} ${d.from} → ${d.to}`).join("; ")}` : "";
  return {
    change_id: ce.resourceName, changed_at: ce.changeDateTime || null, user_email: ce.userEmail || null, client_type: ce.clientType || null,
    resource_type: ce.changeResourceType || null, operation: ce.resourceChangeOperation || null, campaign_id: campaignId,
    summary: `${who}: ${what}${where}${detail}`.slice(0, 400),
    data: { fields, diffs, resource: ce.changeResourceName || null },
  };
}

/** Pure-ish: campaign totals over [from, to] from stored days. */
async function campaignWindow(db, storeId, campaignId, from, to) {
  const r = await db.prepare(
    `SELECT COUNT(*) AS days, COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(conv_value), 0) AS value, COALESCE(SUM(conversions), 0) AS conv
     FROM media_campaign_days WHERE store = ? AND campaign_id = ? AND day >= ? AND day <= ?`
  ).bind(storeId, campaignId, from, to).first();
  const days = Number((r && r.days) || 0);
  if (!days) return { days: 0, cost: null, value: null, roas: null };
  const cost = r2(r.cost); const value = r2(r.value);
  return { days, cost, value, conversions: Number(r.conv), roas: cost > 0 ? r2(value / cost) : null };
}

/** Fill `effect` for campaign changes 7+ days old (and again at 14+ days). Google's numbers, as stored. */
export async function updateEffects(db, storeId, today, { limit = EFFECTS_PER_RUN } = {}) {
  const { results } = await db.prepare(
    `SELECT change_id, changed_at, campaign_id, effect FROM media_changes
     WHERE store = ? AND campaign_id IS NOT NULL AND substr(changed_at, 1, 10) <= ?
       AND (effect IS NULL OR (effect NOT LIKE '%"after14"%' AND substr(changed_at, 1, 10) <= ?))
     ORDER BY changed_at LIMIT ?`
  ).bind(storeId, minusDays(today, 8), minusDays(today, 15), limit).all();
  let n = 0;
  for (const c of results || []) {
    const day = String(c.changed_at).slice(0, 10);
    const before = await campaignWindow(db, storeId, c.campaign_id, minusDays(day, 7), minusDays(day, 1));
    const after7 = await campaignWindow(db, storeId, c.campaign_id, minusDays(day, -1), minusDays(day, -7));
    const effect = { before, after7, note: before.days ? null : "no stored days before the change (watching started later)" };
    if (day <= minusDays(today, 15)) effect.after14 = await campaignWindow(db, storeId, c.campaign_id, minusDays(day, -1), minusDays(day, -14));
    await db.prepare(`UPDATE media_changes SET effect = ? WHERE store = ? AND change_id = ?`).bind(JSON.stringify(effect), storeId, c.change_id).run();
    n += 1;
  }
  return n;
}

export async function runGuyMonitor(env, { storeId, session, nowMs = Date.now() }) {
  const db = env.DB;
  const tz = await accountTz(env, storeId, session);
  const { today } = windowFor(nowMs, tz, 1);
  const from = minusDays(today, CHANGE_DAYS);
  const rows = await session.query(storeId,
    `SELECT change_event.resource_name, change_event.change_date_time, change_event.change_resource_type,
       change_event.change_resource_name, change_event.client_type, change_event.user_email,
       change_event.resource_change_operation, change_event.changed_fields, change_event.campaign,
       change_event.old_resource, change_event.new_resource
     FROM change_event
     WHERE change_event.change_date_time >= '${from}' AND change_event.change_date_time <= '${today} 23:59:59'
     ORDER BY change_event.change_date_time DESC LIMIT 500`);
  const names = new Map();
  const nm = await db.prepare(`SELECT campaign_id, campaign_name FROM media_campaign_days WHERE store = ? AND campaign_name IS NOT NULL GROUP BY campaign_id`).bind(storeId).all();
  for (const r of nm.results || []) names.set(String(r.campaign_id), r.campaign_name);
  const at = nowIso(nowMs);
  let added = 0;
  for (const row of rows) {
    const c = describeChange(row, names);
    if (!c.change_id || !c.changed_at) continue;
    const res = await db.prepare(
      `INSERT INTO media_changes (store, change_id, changed_at, user_email, client_type, resource_type, operation, campaign_id, summary, data, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(store, change_id) DO NOTHING`
    ).bind(storeId, c.change_id, c.changed_at, c.user_email, c.client_type, c.resource_type, c.operation, c.campaign_id, c.summary, JSON.stringify(c.data), at).run();
    if (res.meta && res.meta.changes > 0) added += 1;
  }
  // One event per change, oldest first, capped per run; the rest follow on the next runs.
  const { results: pending } = await db.prepare(
    `SELECT change_id, changed_at, summary, resource_type, campaign_id FROM media_changes WHERE store = ? AND logged = 0 ORDER BY changed_at LIMIT ?`
  ).bind(storeId, EVENTS_PER_RUN).all();
  for (const p of pending || []) {
    await logEvent(db, {
      actor: AGENT, kind: "media.change", store: storeId, target: "sys.ads", at,
      summary: `${storeName(storeId)} ads change (${String(p.changed_at).slice(0, 16)}): ${p.summary}`,
      data: { change_id: p.change_id, resource_type: p.resource_type, campaign_id: p.campaign_id, changed_at: p.changed_at },
    });
    await db.prepare(`UPDATE media_changes SET logged = 1 WHERE store = ? AND change_id = ?`).bind(storeId, p.change_id).run();
  }
  const effects = await updateEffects(db, storeId, today);
  return `ok: ${rows.length} changes read, ${added} new, ${(pending || []).length} logged, ${effects} effects updated`;
}
