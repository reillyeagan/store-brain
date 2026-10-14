/**
 * P&L Sheets (pnl.sheets) — plain code, no AI. Reads Reilly's Google Sheets P&L workbooks,
 * fills the brain's gaps from them, cross-checks the two, and fills the workbooks' BLANK input
 * cells from closed P&L days (the "Sheets Writer").
 *
 * Reilly, 2026-10-14: "why are there so many days missing info, use the spreadsheets to fill in
 * accurate data for every single day we have" and "make sure things like the google drive P&L
 * sheets are all updated by the brain automatically" (decisions pnl.sheets_fill / pnl.sheets_write).
 *
 * Each run (P&L department slot, about hourly):
 *  1. READ every workbook (src/lib/sheets.js parses it by header name). The first read covers
 *     every month tab, later reads the current and previous month. Stored in sheet_pnl_days,
 *     with per-value trust flags (trustRow). A workbook whose SETUP doesn't name its store's
 *     myshopify domain is refused (Store Guard thinking: a wrong sheet id is a hard stop).
 *  2. FILL the brain only where it has nothing: a day with no ad spend row gets the sheet's
 *     figure (source 'sheet', replaced by the Google Ads API when the history backfill reaches
 *     it). Sheet COG and fees are used by the P&L itself (pnl.js sheetDay), only for days the
 *     brain lacks them and only when the sheet's day provably is the brain's day.
 *  3. CROSS-CHECK: API ad spend, revenue, orders, services, fees, KFB COG vs the sheet. A
 *     difference over the threshold is one `pnl.sheet_mismatch` event per store/day/field.
 *  4. WRITE (unless env SHEETS_WRITE = "0"): for each CLOSED P&L day, only INPUT cells that are
 *     BLANK and not formulas (Revenue, Adspend Google, SERVICES, Transaction fee, Orders, Clicks,
 *     Sessions, COG (EUR)). Never a formula, never a non-blank cell (Reilly's numbers win), never
 *     refunds (the workbooks have no per-day refunds cell). The rows are re-read just before
 *     writing, backed up to R2 (and the backup checked), written in one USER_ENTERED batch,
 *     then re-read to confirm every value landed (rule 3). At most once an hour per workbook.
 *  5. The Ecom P&L is static input cells that Reilly fills as the sum of the three store
 *     sheets: its blank cells get exactly that sum, only when all three store cells are filled.
 *  6. A missing tab for the current month is never created: one event a day asks Reilly.
 * Not wired (Google not connected) or a workbook unreachable: nothing changes, and the state
 * says so. Inputs: Sheets API, pnl_days, ad_spend_days, cogs_matches, funnel_days, orders.
 * Outputs: sheet_* tables, ad_spend_days (source 'sheet'), recomputed pnl_days, events, R2 backups.
 */
import { LIVE_STORE_IDS, STORES, ECOM_PNL_SHEET_ID } from "../../config/stores.js";
import { getGoogleAccessToken } from "../../lib/google.js";
import {
  sheetMeta, batchGet, batchUpdate, a1, parseMonthTab, parseSetup, monthTabs, tabForMonth, monthAbbrev,
  writableBlank, INPUT_FIELDS, parseMoney, parseSheetDate, colLetter, SheetsError,
} from "../../lib/sheets.js";
import { backup } from "../../lib/backupVault.js";
import { logEvent } from "../../lib/eventlog.js";
import { claimJob } from "../../lib/jobRuns.js";
import { localDay, nowIso } from "../../lib/time.js";
import { minusDays } from "../../lib/adsSpend.js";
import { computeStoreDay, writePnlRow, storeTz, SHEET_MAX_AGE_MIN } from "../../lib/pnl.js";
import { orderCoverage } from "../../lib/orderBackfill.js";
import { r2, safeJson } from "../core/shared.js";

const ACTOR = "pnl.sheets";
export const WRITE_EVERY_MIN = 60;
export const MISMATCH_EVENTS_PER_RUN = 15;
export const RECOMPUTE_PER_RUN = 12;
/** Sheet rows stored per run at most (a first full read of four workbooks is ~450 rows). */
export const STORE_ROWS_PER_RUN = 200;
/** A COG younger than this many days may still be missing a KFB suborder: not used yet. */
export const COG_SETTLE_DAYS = 2;
/** Money differences up to this are rounding, not a disagreement. */
export const MISMATCH_USD = 0.5;
/** Google keeps adjusting the last days: ads are compared only once a day is this old. */
export const ADS_COMPARE_AFTER_DAYS = 3;

/** The kill switch: SHEETS_WRITE = "0" stops every write. Default ON (Reilly asked for it). */
export const sheetsWriteOn = (env) => !(env && env.SHEETS_WRITE != null && String(env.SHEETS_WRITE).trim() === "0");

/** Every workbook the brain knows: one per live store with a sheet id, plus the Ecom P&L ("all"). */
export function workbooks() {
  const out = LIVE_STORE_IDS.filter((id) => STORES[id].pnlSheetId)
    .map((id) => ({ store: id, sheetId: STORES[id].pnlSheetId, name: `${STORES[id].name} P&L`, domain: STORES[id].domain, tz: storeTz(id) }));
  if (ECOM_PNL_SHEET_ID) out.push({ store: "all", sheetId: ECOM_PNL_SHEET_ID, name: "Ecom P&L", domain: null, tz: "America/New_York" });
  return out;
}

/* ---------------- 1. read ---------------- */

/**
 * Pure: may this sheet day fill a gap in the brain? Per value: { ok: 0|1, why }.
 * Rule 5: anything doubtful stays out (the brain keeps its own, labelled, estimate).
 */
export function trustRow(v, setup, day, today) {
  const est = (setup && setup.estimated) || { cogs: [], fees: [], ads: [] };
  const orders = v.orders;
  const cog = (() => {
    if (v.cog_eur == null) return [0, "COG (EUR) blank"];
    if (!setup || !setup.fx_rate) return [0, "no EUR → USD rate in SETUP"];
    if (est.cogs.includes(day)) return [0, "SETUP names this day's COG as an estimate"];
    if (day > minusDays(today, COG_SETTLE_DAYS)) return [0, `too recent: KFB may not have billed every order yet (used after ${COG_SETTLE_DAYS} days)`];
    if (orders == null) return [0, "orders blank, so a $0 COG can't be checked"];
    if (v.cog_eur === 0 && orders > 0) return [0, `sheet COG is $0 on a day with ${orders} order${orders === 1 ? "" : "s"}: unknown, not zero`];
    return [1, null];
  })();
  const fee = (() => {
    if (v.fee == null) return [0, "transaction fee blank"];
    if (est.fees.includes(day)) return [0, "SETUP names this day's fees as an estimate"];
    if (orders == null) return [0, "orders blank, so a $0 fee can't be checked"];
    if (v.fee === 0 && orders > 0) return [0, `sheet fee is $0 on a day with ${orders} order${orders === 1 ? "" : "s"}: unknown, not zero`];
    return [1, null];
  })();
  const ads = (() => {
    if (v.adspend == null) return [0, "ad spend blank"];
    if (est.ads.includes(day)) return [0, "SETUP says this day's ad spend is partial"];
    if (day >= today) return [0, "day not over"];
    return [1, null];
  })();
  return { cog_ok: cog[0], cog_why: cog[1], fee_ok: fee[0], fee_why: fee[1], ads_ok: ads[0], ads_why: ads[1] };
}

/** Read one workbook: tabs, SETUP, and the month tabs this run needs. Throws SheetsError. */
export async function readWorkbook(env, wb, { token, fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const opts = { token, fetchImpl };
  const meta = await sheetMeta(wb.sheetId, opts);
  const setupTab = meta.tabs.find((t) => /^setup$/i.test(String(t).trim()));
  const months = monthTabs(meta.tabs);
  const prev = await env.DB.prepare(`SELECT full_read_at FROM sheet_workbooks WHERE store = ?`).bind(wb.store).first().catch(() => null);
  const today = localDay(nowMs, wb.tz);
  const full = !(prev && prev.full_read_at);
  const wanted = full ? months : [tabForMonth(months, today), tabForMonth(months, `${minusDays(`${today.slice(0, 7)}-01`, 1)}`)].filter(Boolean);
  const tabs = [...new Set(wanted)];
  const ranges = [...(setupTab ? [a1(setupTab, "A1:B60")] : []), ...tabs.map((t) => a1(t, "A1:Z45"))];
  const formatted = await batchGet(wb.sheetId, ranges, "FORMATTED_VALUE", opts);
  const formulas = await batchGet(wb.sheetId, ranges, "FORMULA", opts);
  const off = setupTab ? 1 : 0;
  const setup = parseSetup(setupTab ? formatted[0] : [], { year: today.slice(0, 4) });
  // A wrong sheet id must never put one store's numbers into another's ledger or workbook.
  const okStore = wb.store === "all" ? /ALL STORES/i.test(setup.store_text || "") : String(setup.store_text || "").toLowerCase().includes(String(wb.domain).toLowerCase());
  if (!okStore) {
    throw new SheetsError(`${wb.name} (${wb.sheetId}): SETUP does not name ${wb.store === "all" ? "ALL STORES" : wb.domain}; refusing to read or write it`, "WRONG_WORKBOOK");
  }
  const parsed = tabs.map((t, i) => ({ tab: t, ...parseMonthTab(formatted[off + i], formulas[off + i]) }));
  return { title: meta.title, tabs: meta.tabs, setup, months: parsed, full };
}

const KEY_FIELDS = ["revenue", "orders", "adspend", "fee", "cog_eur", "fx_rate", "cog_ok", "fee_ok", "ads_ok", "clicks"];

/**
 * Store a read: the sheet_pnl_days rows that CHANGED (an unchanged row is not rewritten: the
 * workbook's last_ok_at is what says the data is fresh), then the workbook row. Bounded by
 * `budget.rows` per run so a first full read can't use up the run's D1 queries; the rest are
 * stored on the next run (they still differ then). Returns the days written.
 */
export async function storeRead(db, wb, read, nowMs = Date.now(), budget = { rows: STORE_ROWS_PER_RUN }) {
  const at = nowIso(nowMs);
  const today = localDay(nowMs, wb.tz);
  const changed = [];
  const { results: prevRows } = await db.prepare(`SELECT * FROM sheet_pnl_days WHERE store = ?`).bind(wb.store).all();
  const prev = new Map((prevRows || []).map((r) => [r.day, r]));
  const stmts = [];
  let complete = true;
  for (const m of read.months) {
    for (const d of m.days) {
      const v = d.values;
      const t = trustRow(v, read.setup, d.day, today);
      const row = {
        revenue: v.revenue ?? null, cog_usd: v.cog_usd ?? null, adspend: v.adspend ?? null, services: v.services ?? null,
        employee: v.employee ?? null, fee: v.fee ?? null, profit: v.profit ?? null, orders: v.orders ?? null,
        clicks: v.clicks ?? null, sessions: v.sessions ?? null, cog_eur: v.cog_eur ?? null, fx_rate: read.setup.fx_rate, ...t,
      };
      const before = prev.get(d.day);
      const num = (x) => (x == null ? null : Number(x));
      const differs = !before || KEY_FIELDS.some((k) => num(before[k]) !== num(row[k]));
      const moved = before && (before.row_no !== d.row_no || before.tab !== m.tab || before.cog_why !== row.cog_why || before.fee_why !== row.fee_why || before.ads_why !== row.ads_why
        || num(before.services) !== num(row.services) || num(before.sessions) !== num(row.sessions) || before.formulas !== JSON.stringify(d.formulas));
      if (!differs && !moved) continue;
      if (budget.rows <= 0) { complete = false; continue; }
      budget.rows--;
      stmts.push(db.prepare(
        `INSERT INTO sheet_pnl_days (store, day, sheet_id, tab, row_no, revenue, cog_usd, adspend, services, employee, fee, profit, orders, clicks, sessions,
           cog_eur, fx_rate, formulas, cog_ok, cog_why, fee_ok, fee_why, ads_ok, ads_why, read_at, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(store, day) DO UPDATE SET sheet_id = excluded.sheet_id, tab = excluded.tab, row_no = excluded.row_no,
           revenue = excluded.revenue, cog_usd = excluded.cog_usd, adspend = excluded.adspend, services = excluded.services,
           employee = excluded.employee, fee = excluded.fee, profit = excluded.profit, orders = excluded.orders, clicks = excluded.clicks,
           sessions = excluded.sessions, cog_eur = excluded.cog_eur, fx_rate = excluded.fx_rate, formulas = excluded.formulas,
           cog_ok = excluded.cog_ok, cog_why = excluded.cog_why, fee_ok = excluded.fee_ok, fee_why = excluded.fee_why,
           ads_ok = excluded.ads_ok, ads_why = excluded.ads_why, read_at = excluded.read_at,
           applied_at = CASE WHEN ? THEN NULL ELSE sheet_pnl_days.applied_at END`
      ).bind(wb.store, d.day, wb.sheetId, m.tab, d.row_no, row.revenue, row.cog_usd, row.adspend, row.services, row.employee, row.fee,
        row.profit, row.orders, row.clicks, row.sessions, row.cog_eur, row.fx_rate, JSON.stringify(d.formulas), row.cog_ok, row.cog_why,
        row.fee_ok, row.fee_why, row.ads_ok, row.ads_why, at, null, differs ? 1 : 0));
      if (differs) changed.push(d.day);
    }
  }
  await runBatch(db, stmts);
  // A read stored only in part is not a "full read" yet: the next run carries on.
  await db.prepare(
    `INSERT INTO sheet_workbooks (store, sheet_id, title, fx_rate, revenue_tz, services_ended, setup, tabs, last_read_at, last_ok_at, last_error, full_read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(store) DO UPDATE SET sheet_id = excluded.sheet_id, title = excluded.title, fx_rate = excluded.fx_rate,
       revenue_tz = excluded.revenue_tz, services_ended = excluded.services_ended, setup = excluded.setup, tabs = excluded.tabs,
       last_read_at = excluded.last_read_at, last_ok_at = COALESCE(excluded.last_ok_at, sheet_workbooks.last_ok_at), last_error = NULL,
       full_read_at = COALESCE(sheet_workbooks.full_read_at, excluded.full_read_at)`
  ).bind(wb.store, wb.sheetId, read.title, read.setup.fx_rate, read.setup.revenue_tz, read.setup.services_ended,
    JSON.stringify({ estimated: read.setup.estimated, revenue: read.setup.revenue_text, services: read.setup.services_text }),
    // last_ok_at says "every row in the ledger matches the sheet as of now": only when all were stored.
    JSON.stringify(read.tabs), at, complete ? at : null, read.full && complete ? at : null).run();
  return { changed, complete };
}

/** Several writes in one D1 call (fewer round trips), in chunks. */
async function runBatch(db, stmts, size = 50) {
  for (let i = 0; i < stmts.length; i += size) {
    const part = stmts.slice(i, i + size);
    if (db.batch) await db.batch(part);
    else for (const s of part) await s.run();
  }
}

/* ---------------- 2. fill ---------------- */

/** Days with no ad spend row get the sheet's figure (source 'sheet'). The API replaces them later. */
export async function fillAdsFromSheet(db, { nowMs = Date.now() } = {}) {
  const at = nowIso(nowMs);
  const cutoff = nowIso(nowMs - SHEET_MAX_AGE_MIN * 60000);
  const out = [];
  for (const id of LIVE_STORE_IDS) {
    const today = localDay(nowMs, storeTz(id));
    const { results } = await db.prepare(
      `SELECT s.day, s.adspend, s.clicks FROM sheet_pnl_days s
         LEFT JOIN ad_spend_days a ON a.store = s.store AND a.day = s.day
        WHERE s.store = ? AND s.ads_ok = 1 AND s.adspend IS NOT NULL AND a.day IS NULL AND EXISTS (SELECT 1 FROM sheet_workbooks w WHERE w.store = s.store AND w.last_ok_at >= ?) AND s.day < ?
        ORDER BY s.day`
    ).bind(id, cutoff, today).all();
    if (!results || !results.length) continue;
    const acct = await db.prepare(`SELECT account_tz FROM ad_spend_days WHERE store = ? AND source = 'api' AND account_tz IS NOT NULL ORDER BY fetched_at DESC LIMIT 1`).bind(id).first();
    const stmts = [];
    for (const r of results) {
      // INSERT only (never an update): a row the API wrote in the meantime is left alone.
      stmts.push(db.prepare(
        `INSERT INTO ad_spend_days (store, day, cost, clicks, impressions, conv_value, currency, account_tz, fetched_at, source)
         VALUES (?, ?, ?, ?, 0, 0, 'USD', ?, ?, 'sheet') ON CONFLICT(store, day) DO NOTHING`
      ).bind(id, r.day, r2(r.adspend), r.clicks == null ? 0 : Math.round(r.clicks), acct ? acct.account_tz : null, at));
      // The P&L day is recomputed with it (recomputeChanged).
      stmts.push(db.prepare(`UPDATE sheet_pnl_days SET applied_at = NULL WHERE store = ? AND day = ?`).bind(id, r.day));
      out.push({ store: id, day: r.day, cost: r2(r.adspend) });
    }
    await runBatch(db, stmts);
  }
  if (out.length) {
    const by = {};
    for (const o of out) (by[o.store] = by[o.store] || []).push(o);
    for (const [id, list] of Object.entries(by)) {
      await logEvent(db, {
        actor: ACTOR, kind: "pnl.sheet_filled", store: id, target: "pnl.ledger",
        summary: `${STORES[id].name}: ad spend for ${list.length} day${list.length === 1 ? "" : "s"} the Google Ads API never answered for filled from the P&L sheet (${list[0].day} to ${list[list.length - 1].day}); the API replaces them when its history read reaches them`,
        data: { field: "ads", days: list.map((x) => x.day) }, at,
      });
    }
  }
  return out;
}

/** Recompute the P&L days whose sheet row (or sheet-filled ad spend) changed. Bounded per run. */
export async function recomputeChanged(db, { nowMs = Date.now(), limit = RECOMPUTE_PER_RUN } = {}) {
  const at = nowIso(nowMs);
  // Rows with no P&L day to recompute are simply marked done, in one statement per store:
  // the Ecom rows, days before the order history starts (they get their row when the history
  // reaches them, pnl.js fillMissingDays, with the sheet data already in place) and today (the
  // 15-minute job's).
  await db.prepare(`UPDATE sheet_pnl_days SET applied_at = ? WHERE applied_at IS NULL AND store = 'all'`).bind(at).run();
  for (const id of LIVE_STORE_IDS) {
    const cov = (await orderCoverage(db, id)).covered_from;
    await db.prepare(`UPDATE sheet_pnl_days SET applied_at = ? WHERE applied_at IS NULL AND store = ? AND (? IS NULL OR day < ? OR day >= ?)`)
      .bind(at, id, cov, cov, localDay(nowMs, storeTz(id))).run();
  }
  const { results } = await db.prepare(`SELECT store, day FROM sheet_pnl_days WHERE applied_at IS NULL ORDER BY day DESC LIMIT ?`).bind(limit).all();
  const out = [];
  for (const r of results || []) {
    if (STORES[r.store] && STORES[r.store].live) {
      const row = await computeStoreDay(db, r.store, r.day, { nowMs });
      const w = await writePnlRow(db, row, at);
      out.push({ store: r.store, day: r.day, status: w.status });
    }
    await db.prepare(`UPDATE sheet_pnl_days SET applied_at = ? WHERE store = ? AND day = ?`).bind(at, r.store, r.day).run();
  }
  return out;
}

/* ---------------- 3. cross-check ---------------- */

/** The mismatches already logged (so they cost no query) and how many new events this run may log. */
async function mismatchBudget(db) {
  const { results } = await db.prepare(`SELECT store, day, field FROM sheet_mismatches`).all().catch(() => ({ results: [] }));
  return { left: MISMATCH_EVENTS_PER_RUN, known: new Set((results || []).map((r) => `${r.store}|${r.day}|${r.field}`)) };
}

/** Record a mismatch once per store/day/field; log an event for a new one. True if new. */
async function mismatch(db, m, budget, at) {
  const key = `${m.store}|${m.day}|${m.field}`;
  if (budget.known && budget.known.has(key)) return false;
  if (budget.left <= 0) return false;
  if (budget.known) budget.known.add(key);
  const res = await db.prepare(
    `INSERT INTO sheet_mismatches (store, day, field, sheet_value, brain_value, brain_source, note, logged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(store, day, field) DO NOTHING`
  ).bind(m.store, m.day, m.field, m.sheet, m.brain, m.source, m.note || null, at).run();
  if (!(res.meta && res.meta.changes)) return false;
  budget.left--;
  const name = m.store === "all" ? "Ecom P&L" : STORES[m.store].name;
  const f = (v) => (v == null ? "—" : ["orders", "clicks", "sessions"].includes(m.field) ? String(v) : `${m.field === "cog_eur" ? "€" : "$"}${Number(v).toFixed(2)}`);
  await logEvent(db, {
    actor: ACTOR, kind: "pnl.sheet_mismatch", store: m.store === "all" ? null : m.store, target: "sys.sheets",
    summary: `${name} ${m.day} ${m.field}: sheet ${f(m.sheet)} vs ${m.source} ${f(m.brain)}${m.note ? ` (${m.note})` : ""}. Nothing was overwritten`,
    data: m, at,
  });
  return true;
}

/** Sheet vs brain, per live store, for days both sides have. Returns the new mismatches. */
export async function crossCheck(db, { nowMs = Date.now() } = {}) {
  const at = nowIso(nowMs);
  const cutoff = nowIso(nowMs - SHEET_MAX_AGE_MIN * 60000);
  const budget = await mismatchBudget(db);
  const found = [];
  for (const id of LIVE_STORE_IDS) {
    const today = localDay(nowMs, storeTz(id));
    const adsBefore = minusDays(today, ADS_COMPARE_AFTER_DAYS - 1);
    const { results: rows } = await db.prepare(
      `SELECT s.*, a.cost AS api_cost, a.clicks AS api_clicks, a.source AS a_source,
              p.revenue AS p_revenue, p.orders AS p_orders, p.guy_fee AS p_guy, p.fees AS p_fees, p.complete AS p_complete,
              p.cogs_source AS p_cogs_source, p.notes AS p_notes
         FROM sheet_pnl_days s
         LEFT JOIN ad_spend_days a ON a.store = s.store AND a.day = s.day
         LEFT JOIN pnl_days p ON p.store = s.store AND p.day = s.day
        WHERE s.store = ? AND EXISTS (SELECT 1 FROM sheet_workbooks w WHERE w.store = s.store AND w.last_ok_at >= ?) AND s.day < ? ORDER BY s.day`
    ).bind(id, cutoff, today).all();
    for (const r of rows || []) {
      const push = async (m) => { if (await mismatch(db, { store: id, day: r.day, ...m }, budget, at)) found.push({ store: id, day: r.day, field: m.field }); };
      if (r.a_source === "api" && r.day < adsBefore) {
        if (r.adspend != null && Math.abs(Number(r.adspend) - Number(r.api_cost)) > MISMATCH_USD) await push({ field: "adspend", sheet: r.adspend, brain: r2(r.api_cost), source: "Google Ads API" });
        if (r.clicks != null && Number(r.clicks) !== Number(r.api_clicks)) await push({ field: "clicks", sheet: r.clicks, brain: r.api_clicks, source: "Google Ads API" });
      }
      if (!r.p_complete) continue; // only days the brain has closed
      const notes = safeJson(r.p_notes, {}) || {};
      if (r.revenue != null && r.p_revenue != null && Math.abs(Number(r.revenue) - Number(r.p_revenue)) > Math.max(1, 0.01 * Number(r.p_revenue))) {
        await push({ field: "revenue", sheet: r.revenue, brain: r.p_revenue, source: "brain (Shopify orders)" });
      }
      if (r.orders != null && r.p_orders != null && Number(r.orders) !== Number(r.p_orders)) await push({ field: "orders", sheet: r.orders, brain: r.p_orders, source: "brain (Shopify orders)" });
      if (r.services != null && r.p_guy != null && Math.abs(Number(r.services) - Number(r.p_guy)) > MISMATCH_USD) await push({ field: "services", sheet: r.services, brain: r.p_guy, source: "brain (10% of ad spend)" });
      if (r.fee != null && r.p_fees != null && notes.fees_source !== "sheet" && Math.abs(Number(r.fee) - Number(r.p_fees)) > MISMATCH_USD) {
        await push({ field: "fee", sheet: r.fee, brain: r.p_fees, source: "brain (Shopify Payments)" });
      }
      if (r.cog_eur != null && r.p_cogs_source === "actual") {
        const k = await db.prepare(`SELECT SUM(cost_eur) AS eur FROM cogs_matches WHERE store = ? AND local_day = ? AND status = 'matched'`).bind(id, r.day).first();
        if (k && k.eur != null && Math.abs(Number(r.cog_eur) - Number(k.eur)) > MISMATCH_USD) await push({ field: "cog_eur", sheet: r.cog_eur, brain: r2(k.eur), source: "brain (KFB bills)" });
      }
    }
  }
  return found;
}

/* ---------------- 4. write ---------------- */

/**
 * Does an order's original total equal the sheet's revenue definition ("gross sales less
 * discounts, before returns")? Only when it carries no shipping and no tax. true / false /
 * null (the payload can't tell).
 */
export function revenueDefinitionMatch(rawText) {
  const raw = safeJson(rawText, null);
  if (!raw) return null;
  const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  if (raw.total_price != null) {
    const tax = num(raw.total_tax);
    const shipSet = raw.total_shipping_price_set && raw.total_shipping_price_set.shop_money && raw.total_shipping_price_set.shop_money.amount;
    const ship = shipSet != null ? num(shipSet) : Array.isArray(raw.shipping_lines) ? raw.shipping_lines.reduce((s, l) => s + (num(l && l.price) || 0), 0) : null;
    if (tax == null || ship == null) return null;
    return Math.abs(tax) < 0.005 && Math.abs(ship) < 0.005;
  }
  const sub = num(raw.currentSubtotalPriceSet && raw.currentSubtotalPriceSet.shopMoney && raw.currentSubtotalPriceSet.shopMoney.amount);
  const tot = num(raw.currentTotalPriceSet && raw.currentTotalPriceSet.shopMoney && raw.currentTotalPriceSet.shopMoney.amount);
  if (sub == null || tot == null || tot === 0) return null; // fully refunded: can't tell
  return Math.abs(sub - tot) < 0.005;
}

async function revenueMatchesDefinition(db, storeId, day) {
  const { results } = await db.prepare(`SELECT raw, financial_status FROM orders WHERE store = ? AND local_day = ?`).bind(storeId, day).all();
  for (const o of results || []) {
    const raw = safeJson(o.raw, null);
    if (raw && raw.test === true) continue;
    if (String(o.financial_status || "").toLowerCase() === "voided") continue;
    const m = revenueDefinitionMatch(o.raw);
    if (m !== true) return m === false ? "an order carries shipping or tax, so the brain's total isn't gross sales less discounts" : "an order's payload can't show shipping and tax";
  }
  return null;
}

/**
 * The value the brain would put in one blank cell of a closed day, or { skip: reason }.
 * Day-based numbers (revenue, orders, fees, COG) are only written when the sheet's timezone
 * (SETUP) is the brain's store timezone: otherwise "a day" is a different set of orders.
 */
export async function brainValue(db, storeId, day, field, { pnl, setup, tz }) {
  const notes = safeJson(pnl.notes, {}) || {};
  const tzOk = !setup.revenue_tz || setup.revenue_tz === tz;
  const tzWhy = `the sheet counts days in ${setup.revenue_tz} (SETUP), the brain in ${tz}`;
  switch (field) {
    case "revenue": {
      if (!tzOk) return { skip: tzWhy };
      if (pnl.revenue == null) return { skip: "revenue unknown" };
      const bad = await revenueMatchesDefinition(db, storeId, day);
      return bad ? { skip: bad } : { value: r2(pnl.revenue) };
    }
    case "orders":
      if (!tzOk) return { skip: tzWhy };
      return pnl.orders == null ? { skip: "orders unknown" } : { value: Number(pnl.orders) };
    case "adspend":
      if (notes.ads_source === "sheet") return { skip: "ad spend came from this sheet" };
      return pnl.ads == null ? { skip: "ad spend unknown" } : { value: r2(pnl.ads) };
    case "services":
      if (setup.services_ended && (setup.services_ended === "all" || day >= setup.services_ended)) return { skip: `SETUP says the media buyer ended (${setup.services_ended})` };
      return pnl.guy_fee == null ? { skip: "services unknown" } : { value: r2(pnl.guy_fee) };
    case "fee":
      if (!tzOk) return { skip: tzWhy };
      if (notes.fees_source === "sheet") return { skip: "fees came from this sheet" };
      return pnl.fees == null ? { skip: "fees unknown" } : { value: r2(pnl.fees) };
    case "clicks": {
      const a = await db.prepare(`SELECT clicks FROM ad_spend_days WHERE store = ? AND day = ? AND source = 'api'`).bind(storeId, day).first();
      return a ? { value: Number(a.clicks) } : { skip: "no Google Ads API row" };
    }
    case "sessions": {
      const f = await db.prepare(`SELECT sessions FROM funnel_days WHERE store = ? AND day = ? AND partial = 0`).bind(storeId, day).first().catch(() => null);
      return f && f.sessions != null ? { value: Number(f.sessions) } : { skip: "no Shopify sessions for that day" };
    }
    case "cog_eur": {
      if (!tzOk) return { skip: tzWhy };
      if (Number(pnl.orders) === 0) return { value: 0 };
      const basis = safeJson(pnl.cogs_basis, {}) || {};
      if (pnl.cogs_source !== "actual" || Number(basis.orders_actual) !== Number(pnl.orders)) return { skip: "not every order has its actual KFB charge" };
      const k = await db.prepare(`SELECT SUM(cost_eur) AS eur, COUNT(*) AS n FROM cogs_matches WHERE store = ? AND local_day = ? AND status = 'matched'`).bind(storeId, day).first();
      return k && Number(k.n) === Number(pnl.orders) ? { value: r2(k.eur) } : { skip: "KFB matches don't cover every order" };
    }
    default:
      return { skip: "not an input the brain writes" };
  }
}

const close = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005;

/**
 * Write a plan of cells into one workbook: re-read the rows, keep only cells still blank,
 * back up, write, re-read and verify. `plan` = [{ tab, day, row_no, field, cell, value }].
 * Throws if the backup can't be confirmed (nothing is written).
 */
export async function writeCells(env, wb, plan, { token, fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const opts = { token, fetchImpl };
  const at = nowIso(nowMs);
  if (!plan.length) return { written: [], dropped: 0 };
  // 1. Fresh look at exactly those rows (Reilly may have typed since the read).
  const rowKeys = [...new Set(plan.map((p) => `${p.tab}\u0000${p.row_no}`))].map((k) => { const [tab, row] = k.split("\u0000"); return { tab, row: Number(row) }; });
  const lastCol = colLetter(25);
  const ranges = rowKeys.map((k) => a1(k.tab, `A${k.row}:${lastCol}${k.row}`));
  const [fmt, frm] = [await batchGet(wb.sheetId, ranges, "FORMATTED_VALUE", opts), await batchGet(wb.sheetId, ranges, "FORMULA", opts)];
  const snapshot = rowKeys.map((k, i) => ({ tab: k.tab, row: k.row, range: ranges[i], formatted: (fmt[i] && fmt[i][0]) || [], formulas: (frm[i] && frm[i][0]) || [] }));
  const keep = plan.filter((p) => {
    const s = snapshot.find((x) => x.tab === p.tab && x.row === p.row_no);
    if (!s) return false;
    const colIdx = p.cell.replace(/\d+$/, "").split("").reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
    const fv = s.formatted[colIdx], fo = s.formulas[colIdx];
    const blank = (v) => v == null || String(v).trim() === "";
    // The row must still be that day (a row inserted above it would shift everything down).
    const sameDay = (parseSheetDate(s.formatted[0]) || parseSheetDate(s.formulas[0])) === p.day;
    return sameDay && blank(fv) && blank(fo);
  });
  if (!keep.length) return { written: [], dropped: plan.length };
  // 2. Backup (rule 8): every affected row, values and formulas, per tab, checked before writing.
  const backups = {};
  for (const tab of [...new Set(keep.map((p) => p.tab))]) {
    const b = await backup(env.BACKUPS, {
      store: wb.store, label: `sheets_${wb.sheetId}_${tab}`, atIso: at,
      data: { sheet_id: wb.sheetId, workbook: wb.name, tab, rows: snapshot.filter((s) => s.tab === tab) },
    });
    if (!b || !b.ok) throw new Error(`backup for ${wb.name} ${tab} not confirmed; nothing written`);
    backups[tab] = b.key;
  }
  // 3. Write, one batch, USER_ENTERED.
  await batchUpdate(wb.sheetId, keep.map((p) => ({ range: a1(p.tab, p.cell), values: [[p.value]] })), opts);
  // 4. Verify against the sheet itself (rule 3): a 200 is not proof.
  const check = await batchGet(wb.sheetId, keep.map((p) => a1(p.tab, p.cell)), "UNFORMATTED_VALUE", opts);
  const written = keep.map((p, i) => {
    const got = check[i] && check[i][0] ? check[i][0][0] : null;
    return { ...p, got: parseMoney(got), verified: close(parseMoney(got), p.value), backup_key: backups[p.tab] };
  });
  for (const w of written) {
    await env.DB.prepare(
      `INSERT INTO sheet_writes (store, sheet_id, tab, cell, day, field, value, backup_key, written_at, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(wb.store, wb.sheetId, w.tab, w.cell, w.day, w.field, w.value, w.backup_key, at, w.verified ? 1 : 0).run();
  }
  const ok = written.filter((w) => w.verified), bad = written.filter((w) => !w.verified);
  await logEvent(env.DB, {
    actor: ACTOR, kind: "pnl.sheet_written", store: wb.store === "all" ? null : wb.store, target: "sys.sheets",
    summary: `${wb.name}: filled ${ok.length} blank cell${ok.length === 1 ? "" : "s"} (${[...new Set(ok.map((w) => w.day))].sort().join(", ")}), each confirmed by a re-read; backup ${Object.values(backups).join(", ")}`,
    data: { cells: ok.map((w) => ({ tab: w.tab, cell: w.cell, day: w.day, field: w.field, value: w.value })), backups }, at,
  });
  if (bad.length) {
    await logEvent(env.DB, {
      actor: ACTOR, kind: "pnl.sheet_write_unverified", store: wb.store === "all" ? null : wb.store, target: "sys.sheets",
      summary: `${wb.name}: ${bad.length} written cell${bad.length === 1 ? "" : "s"} did not read back as written (${bad.map((w) => `${w.tab}!${w.cell}`).join(", ")}); check them. Backup ${Object.values(backups).join(", ")}`,
      data: { cells: bad.map((w) => ({ tab: w.tab, cell: w.cell, wrote: w.value, got: w.got })) }, at,
    });
  }
  return { written, dropped: plan.length - keep.length, backups };
}

/** The cells the brain would fill in one store workbook (closed days, blank inputs only). */
export async function planStore(db, wb, read, { nowMs = Date.now() } = {}) {
  const today = localDay(nowMs, wb.tz);
  const plan = [], skipped = {};
  for (const m of read.months) {
    for (const d of m.days) {
      if (d.day >= today) continue;
      const fields = INPUT_FIELDS.filter((f) => writableBlank(d, f));
      if (!fields.length) continue;
      const pnl = await db.prepare(`SELECT * FROM pnl_days WHERE store = ? AND day = ? AND complete = 1`).bind(wb.store, d.day).first();
      if (!pnl) { skipped["day not closed by the brain"] = (skipped["day not closed by the brain"] || 0) + fields.length; continue; }
      for (const f of fields) {
        const v = await brainValue(db, wb.store, d.day, f, { pnl, setup: read.setup, tz: wb.tz });
        if (v.skip) { skipped[v.skip] = (skipped[v.skip] || 0) + 1; continue; }
        if (v.value == null || !Number.isFinite(Number(v.value))) continue;
        plan.push({ tab: m.tab, day: d.day, row_no: d.row_no, field: f, cell: d.cells[f], value: v.value });
      }
    }
  }
  return { plan, skipped };
}

/** Ecom P&L: blank inputs get the sum of the three store sheets; filled ones are checked against it. */
export async function planEcom(db, read, { nowMs = Date.now() } = {}) {
  const at = nowIso(nowMs);
  const stores = LIVE_STORE_IDS.filter((id) => STORES[id].pnlSheetId);
  const today = localDay(nowMs, "America/New_York");
  const plan = [], skipped = {};
  const budget = await mismatchBudget(db);
  // Every store workbook must have been read in THIS run (the last 90 minutes): the Ecom sum is
  // only as good as the three sheets it adds up.
  const marks = stores.map(() => "?").join(", ");
  const fresh = await db.prepare(`SELECT COUNT(*) AS n FROM sheet_workbooks WHERE store IN (${marks}) AND last_ok_at >= ?`).bind(...stores, nowIso(nowMs - 90 * 60000)).first();
  if (!fresh || Number(fresh.n) !== stores.length) return { plan, skipped: { "a store workbook was not read this run": 1 } };
  const { results: all } = await db.prepare(`SELECT * FROM sheet_pnl_days WHERE store IN (${marks})`).bind(...stores).all();
  const byDay = new Map();
  for (const r of all || []) { if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day).push(r); }
  for (const m of read.months) {
    for (const d of m.days) {
      if (d.day >= today) continue;
      const results = byDay.get(d.day) || [];
      if (results.length !== stores.length) { skipped["a store sheet has no row for the day"] = (skipped["a store sheet has no row for the day"] || 0) + 1; continue; }
      for (const f of INPUT_FIELDS) {
        const parts = results.map((r) => r[f]);
        if (parts.some((x) => x == null)) continue;
        const sum = ["orders", "clicks", "sessions"].includes(f) ? parts.reduce((s, x) => s + Number(x), 0) : r2(parts.reduce((s, x) => s + Number(x), 0));
        if (writableBlank(d, f)) {
          plan.push({ tab: m.tab, day: d.day, row_no: d.row_no, field: f, cell: d.cells[f], value: sum });
        } else if (d.values[f] != null && Math.abs(Number(d.values[f]) - sum) > (["orders", "clicks", "sessions"].includes(f) ? 0 : MISMATCH_USD)) {
          await mismatch(db, { store: "all", day: d.day, field: f, sheet: d.values[f], brain: sum, source: "sum of the three store sheets" }, budget, at);
        }
      }
    }
  }
  return { plan, skipped };
}

/** One "OCT tab missing" event per workbook per day; the brain never creates tabs. */
async function tabMissing(db, wb, read, nowMs) {
  const today = localDay(nowMs, wb.tz);
  if (tabForMonth(monthTabs(read.tabs), today)) return null;
  const mon = monthAbbrev(today);
  const dayStart = nowIso(nowMs - 20 * 3600000);
  const seen = await db.prepare(`SELECT id FROM events WHERE kind = 'pnl.sheet_tab_missing' AND summary LIKE ? AND at >= ? LIMIT 1`).bind(`%${wb.name}%`, dayStart).first();
  if (!seen) {
    await logEvent(db, {
      actor: ACTOR, kind: "pnl.sheet_tab_missing", store: wb.store === "all" ? null : wb.store, target: "sys.sheets",
      summary: `${mon} tab missing in ${wb.name}; Reilly adds month tabs (the brain never creates them)`, at: nowIso(nowMs),
    });
  }
  return mon;
}

/** Once a day per workbook: it couldn't be read. */
async function unreachable(db, wb, msg, nowMs) {
  const at = nowIso(nowMs);
  await db.prepare(
    `INSERT INTO sheet_workbooks (store, sheet_id, last_read_at, last_error) VALUES (?, ?, ?, ?)
     ON CONFLICT(store) DO UPDATE SET last_read_at = excluded.last_read_at, last_error = excluded.last_error`
  ).bind(wb.store, wb.sheetId, at, msg).run();
  const seen = await db.prepare(`SELECT id FROM events WHERE kind = 'pnl.sheet_unreachable' AND summary LIKE ? AND at >= ? LIMIT 1`).bind(`%${wb.name}%`, nowIso(nowMs - 20 * 3600000)).first();
  if (!seen) {
    await logEvent(db, {
      actor: ACTOR, kind: "pnl.sheet_unreachable", store: wb.store === "all" ? null : wb.store, target: "sys.sheets",
      summary: `${wb.name} couldn't be read (${msg}); nothing was changed, the brain keeps its own numbers and tries again within the hour`, at,
    });
  }
}

/** The department step. Never throws past its caller's guard; returns what it did. */
export async function runSheets(env, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const db = env.DB;
  let token;
  try {
    token = await getGoogleAccessToken(env, { fetchImpl, nowMs });
  } catch (err) {
    // Not connected: nothing changes, and the state says so.
    return { status: err.code === "NOT_WIRED" ? "not wired: Google not connected" : `Google sign-in failed (${String(err.message).slice(0, 80)})`, read: 0 };
  }
  const out = { status: "ran", read: [], unreachable: [], filled: 0, recomputed: 0, mismatches: 0, written: {}, missing_tabs: [], write: sheetsWriteOn(env) ? "on" : "off (SHEETS_WRITE=0)" };
  const reads = {};
  const rowBudget = { rows: STORE_ROWS_PER_RUN };
  for (const wb of workbooks()) {
    try {
      const read = await readWorkbook(env, wb, { token, fetchImpl, nowMs });
      await storeRead(db, wb, read, nowMs, rowBudget);
      reads[wb.store] = read;
      out.read.push(wb.store);
      const mon = await tabMissing(db, wb, read, nowMs);
      if (mon) out.missing_tabs.push(`${wb.name}: ${mon}`);
    } catch (err) {
      const msg = String((err && err.message) || err).slice(0, 200);
      await unreachable(db, wb, msg, nowMs);
      out.unreachable.push({ store: wb.store, error: msg });
    }
  }
  if (!out.read.length) return out;
  out.filled = (await fillAdsFromSheet(db, { nowMs })).length;
  out.recomputed = (await recomputeChanged(db, { nowMs })).length;
  out.mismatches = (await crossCheck(db, { nowMs })).length;
  if (!sheetsWriteOn(env)) return out;
  for (const wb of workbooks()) {
    const read = reads[wb.store];
    if (!read) continue; // unreachable this run: never write blind
    if (!(await claimJob(db, `pnl.sheets.write.${wb.store}`, WRITE_EVERY_MIN, nowMs))) { out.written[wb.store] = "not due"; continue; }
    try {
      const { plan, skipped } = wb.store === "all" ? await planEcom(db, read, { nowMs }) : await planStore(db, wb, read, { nowMs });
      const r = await writeCells(env, wb, plan, { token, fetchImpl, nowMs });
      const ok = (r.written || []).filter((w) => w.verified).length;
      out.written[wb.store] = ok;
      await db.prepare(`UPDATE sheet_workbooks SET last_write_at = ?, last_write = ? WHERE store = ?`)
        .bind(nowIso(nowMs), JSON.stringify({ planned: plan.length, written: ok, unverified: (r.written || []).length - ok, dropped_not_blank_any_more: r.dropped || 0, skipped }), wb.store).run();
    } catch (err) {
      const msg = String((err && err.message) || err).slice(0, 200);
      out.written[wb.store] = { error: msg };
      await logEvent(db, {
        actor: ACTOR, kind: "error.sheet_write", store: wb.store === "all" ? null : wb.store, target: "sys.sheets",
        summary: `${wb.name}: write stopped before changing anything it couldn't back up or confirm (${msg})`, at: nowIso(nowMs),
      }).catch(() => {});
    }
  }
  return out;
}

/* ---------------- state for /api/dept/pnl ---------------- */

export async function sheetsState(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const since = `${localDay(nowMs, "America/New_York")}`;
  const { results: wbs } = await db.prepare(`SELECT * FROM sheet_workbooks ORDER BY store`).all().catch(() => ({ results: [] }));
  const byStore = Object.fromEntries((wbs || []).map((w) => [w.store, w]));
  const books = workbooks().map((wb) => {
    const w = byStore[wb.store] || {};
    const tabs = safeJson(w.tabs, []) || [];
    const today = localDay(nowMs, wb.tz);
    return {
      store: wb.store, workbook: wb.name, sheet_id: wb.sheetId,
      status: !w.last_read_at ? "never read" : w.last_error ? `unreachable: ${w.last_error}` : "read ok",
      last_read_at: w.last_read_at || null, last_ok_at: w.last_ok_at || null, last_write_at: w.last_write_at || null,
      last_write: safeJson(w.last_write, null),
      fx_rate: w.fx_rate ?? null,
      sheet_timezone: w.revenue_tz || null,
      brain_timezone: wb.store === "all" ? null : wb.tz,
      timezone_note: w.revenue_tz && wb.store !== "all" && w.revenue_tz !== wb.tz ? `sheet days are ${w.revenue_tz}, brain days ${wb.tz}: revenue, orders, fees and COG are not written` : null,
      services_ended: w.services_ended || null,
      missing_tab: w.last_ok_at && !tabForMonth(monthTabs(tabs), today) ? monthAbbrev(today) : null,
    };
  });
  const n = async (sql, ...b) => ((await db.prepare(sql).bind(...b).first().catch(() => null)) || {}).n || 0;
  const { results: mm } = await db.prepare(`SELECT store, day, field, sheet_value, brain_value, brain_source, logged_at FROM sheet_mismatches ORDER BY logged_at DESC, day DESC LIMIT 25`).all().catch(() => ({ results: [] }));
  return {
    mode: "shadow",
    write: sheetsWriteOn(env) ? "on (SHEETS_WRITE=0 stops it)" : "off (SHEETS_WRITE=0)",
    workbooks: books,
    cells_written_today: await n(`SELECT COUNT(*) AS n FROM sheet_writes WHERE written_at >= ? AND verified = 1`, `${since}T00:00:00`),
    cells_written_total: await n(`SELECT COUNT(*) AS n FROM sheet_writes WHERE verified = 1`),
    unverified_writes: await n(`SELECT COUNT(*) AS n FROM sheet_writes WHERE verified = 0`),
    days_read: await n(`SELECT COUNT(*) AS n FROM sheet_pnl_days`),
    ads_days_from_sheet: await n(`SELECT COUNT(*) AS n FROM ad_spend_days WHERE source = 'sheet'`),
    mismatches_total: await n(`SELECT COUNT(*) AS n FROM sheet_mismatches`),
    mismatches: mm || [],
    missing_tabs: books.filter((b) => b.missing_tab).map((b) => `${b.workbook}: ${b.missing_tab}`),
  };
}
