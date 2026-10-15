import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1, makeR2 } from "./helpers/d1.js";

import {
  parseMoney, parseCount, parseSheetDate, headerMap, parseMonthTab, parseSetup, estimatedDays, datesIn, tzHint,
  writableBlank, tabForMonth, colLetter, SHEETS_API,
} from "../src/lib/sheets.js";
import {
  runSheets, trustRow, sheetsWriteOn, sheetsState, fillAdsFromSheet, crossCheck,
} from "../src/agents/pnl/sheets.js";
import { runAdsHistory, historyEnd, CHUNK_DAYS } from "../src/lib/adsHistory.js";
import { runHistoryExtension, extensionTarget } from "../src/lib/historyExtend.js";
import { computeStoreDay } from "../src/lib/pnl.js";
import { encryptToken, _resetGoogleCacheForTests } from "../src/lib/google.js";
import { _resetTokenCacheForTests } from "../src/lib/storeGuard.js";
import { ensureFeeds, markFeedOk } from "../src/lib/freshness.js";
import { upsertOrder } from "../src/lib/shopifyWebhooks.js";
import { STORES, LIVE_STORE_IDS, SHEETS_WRITE_DECISION } from "../src/config/stores.js";
import { SEED_DECISIONS } from "../src/agents/core/decisions.js";
import { AGENTS, AGENT_DOES } from "../src/config/agents.js";

const NOW = Date.parse("2026-10-14T16:00:00Z"); // Oct 14, noon Eastern
const iso = (ms) => new Date(ms).toISOString();
const j = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
const evs = async (DB, kind) => (await DB.prepare(`SELECT * FROM events WHERE kind = ? ORDER BY id`).bind(kind).all()).results;
const HC = STORES.hc.pnlSheetId;

/* ---------------- a fake Google Sheets ---------------- */

const HEADER = ["HOLT & CRANE", "Revenue", "COG", "Adspend Google", "SERVICES", "EMPLOYEE", "Transaction fee", "Profit", "ROAS", "Profit %", "COG %", "CVR %", "CPC", "", "Orders", "Clicks", "Sessions", "COG (EUR)"];
const COL = { revenue: 1, adspend: 3, services: 4, employee: 5, fee: 6, orders: 14, clicks: 15, sessions: 16, cog_eur: 17 };
const serial = (day) => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000);
const money = (n) => (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);
const cell = (f, raw = f) => ({ f, raw });

/** A month tab like Reilly's: formulas in COG, Profit, ROAS, %, CPC; inputs as given (undefined = blank). */
function monthTab(year, month, days, store = "HOLT & CRANE") {
  const rows = [[...HEADER.slice(0, 0), store, ...HEADER.slice(1)].map((h) => cell(h))];
  const n = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = 1; d <= n; d++) {
    const day = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const r = rows.length + 1;
    const v = days[day] || {};
    const row = Array.from({ length: 18 }, () => cell(null, null));
    row[0] = cell(`${day.slice(5, 7)}/${day.slice(8, 10)}/${day.slice(0, 4)}`, serial(day));
    for (const [k, c] of Object.entries(COL)) {
      if (v[k] === undefined) continue;
      row[c] = ["orders", "clicks", "sessions"].includes(k) ? cell(String(v[k]), v[k]) : cell(k === "cog_eur" ? `€${v[k].toFixed(2)}` : money(v[k]), v[k]);
    }
    row[2] = cell(money((v.cog_eur || 0) * 1.19), `=R${r}*SETUP!$B$5`);
    row[7] = cell("$0.00", `=B${r}-C${r}-D${r}-E${r}-F${r}-G${r}`);
    row[8] = cell("", `=IF(D${r}=0,"",B${r}/D${r})`);
    row[12] = cell("", `=IF(P${r}=0,"",D${r}/P${r})`);
    rows.push(row);
  }
  // The OCT totals row has a DATE in column A: only the SUM in Revenue says it is not a day.
  const t = rows.length + 1;
  const tot = Array.from({ length: 18 }, () => cell(null, null));
  tot[0] = cell(`${String(month).padStart(2, "0")}/01/${year}`, serial(`${year}-${String(month).padStart(2, "0")}-01`));
  tot[1] = cell("$9,999.00", `=SUM(B2:B${t - 1})`);
  rows.push(tot);
  rows.push([]);
  rows.push([cell("EMPLOYEE COST"), cell("TOTAL AMOUNT REFUND"), cell("CHARGEBACKS"), cell("OTHER COSTS")]);
  rows.push([cell("$0.00", 0), cell("$423.33", 423.33), cell("$0.00", 0), cell("$0.00", 0)]);
  return rows;
}

function setupTab({ store = "Holt & Crane — holtandcrane.com (jmzjx1-it.myshopify.com)", tz = "EDT", services = "Media buyer fee, 10% of ad spend, from 2026-09-07.", extra = [] } = {}) {
  const rows = [["SETUP / SOURCES"], ["Store", store], ["Currency", "USD throughout."], [], ["EUR → USD rate", "1.1900"], [], [],
    ["Revenue", `Shopify Analytics, daily, store timezone (${tz}). Gross sales less discounts, before returns.`],
    ["COG (EUR)", "KungFuBuy balance ledger — the exact amount charged per Shopify order."],
    ["Adspend", "Google Ads daily FINAL figures."],
    ["Services", services],
    ["Transaction fee", "Shopify Payments capture fee, per order."],
    ...extra];
  return rows.map((r) => r.map((x) => cell(x, x === "1.1900" ? 1.19 : x)));
}

function book(title, tabs) { return { title, tabs }; }

function parseA1(range) {
  const m = /^'((?:[^']|'')+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(range);
  const col = (s) => s.split("").reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  return { tab: m[1].replace(/''/g, "'"), c1: col(m[2]), r1: Number(m[3]) - 1, c2: col(m[4] || m[2]), r2: Number(m[5] || m[3]) - 1 };
}

/** Google token + Sheets values API over in-memory workbooks. */
function fakeGoogle(books, { failIds = [], onUpdate = null, tamper = null, failUpdate = false, failVerify = false, shopTz = "America/New_York", onGet = null } = {}) {
  const log = { updates: [], gets: 0, calls: [], shop: 0 };
  const fetchImpl = async (url, init = {}) => {
    if (url === "https://oauth2.googleapis.com/token") return j({ access_token: "g", expires_in: 3600 });
    // Shopify (read only): the store's own timezone, through Store Guard.
    if (/myshopify\.com\/admin\/oauth\/access_token$/.test(url)) return j({ access_token: "tok", expires_in: 86400 });
    if (/myshopify\.com\/admin\/api\//.test(url)) {
      const body = JSON.parse(init.body);
      assert.match(body.query, /shop \{ ianaTimezone \}/);
      assert.ok(!/mutation/.test(body.query), "read only");
      log.shop++;
      return j({ data: { shop: { ianaTimezone: shopTz } } });
    }
    assert.ok(url.startsWith(SHEETS_API), `only the Sheets API: ${url}`);
    const u = new URL(url);
    const parts = u.pathname.split("/");
    const id = decodeURIComponent(parts[3]);
    log.calls.push({ id, what: parts[4] || "meta", method: init.method || "GET" });
    if (failIds.includes(id)) return j({ error: { code: 403, status: "PERMISSION_DENIED", message: "The caller does not have permission" } }, 403);
    const b = books[id];
    if (!b) return j({ error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found." } }, 404);
    if (!parts[4]) return j({ properties: { title: b.title }, sheets: Object.keys(b.tabs).map((t) => ({ properties: { title: t } })) });
    if (parts[4] === "values:batchGet") {
      log.gets++;
      const render = u.searchParams.get("valueRenderOption");
      if (failVerify && render === "UNFORMATTED_VALUE") return j({ error: { code: 503, status: "UNAVAILABLE", message: "try later" } }, 503);
      if (onGet) onGet(id, u.searchParams.getAll("ranges"), render);
      return j({ valueRanges: u.searchParams.getAll("ranges").map((r) => {
        const a = parseA1(r);
        const grid = b.tabs[a.tab] || [];
        const rows = [];
        for (let ri = a.r1; ri <= Math.min(a.r2, grid.length - 1); ri++) {
          const row = [];
          for (let ci = a.c1; ci <= a.c2; ci++) {
            const c = (grid[ri] || [])[ci];
            let v = "";
            if (c) {
              if (render === "FORMATTED_VALUE") v = c.f == null ? "" : c.f;
              else if (render === "FORMULA") v = c.raw == null ? "" : c.raw;
              else v = typeof c.raw === "string" && c.raw.startsWith("=") ? c.f : c.raw == null ? "" : c.raw;
            }
            row.push(v);
          }
          while (row.length && row[row.length - 1] === "") row.pop();
          rows.push(row);
        }
        while (rows.length && !rows[rows.length - 1].length) rows.pop();
        return { range: r, values: rows };
      }) });
    }
    if (parts[4] === "values:batchUpdate") {
      if (failUpdate) return j({ error: { code: 500, status: "INTERNAL", message: "backend error" } }, 500);
      const body = JSON.parse(init.body);
      assert.equal(body.valueInputOption, "USER_ENTERED");
      if (onUpdate) onUpdate(id, body);
      for (const d of body.data) {
        const a = parseA1(d.range);
        const v = tamper ? tamper(d.values[0][0]) : d.values[0][0];
        const grid = b.tabs[a.tab];
        while (grid.length <= a.r1) grid.push([]);
        grid[a.r1][a.c1] = cell(String(v), v);
        log.updates.push({ id, tab: a.tab, range: d.range, value: d.values[0][0] });
      }
      return j({ totalUpdatedCells: body.data.length });
    }
    return j({ error: { message: "unknown" } }, 400);
  };
  return { fetchImpl, log };
}

async function connectGoogle(env) {
  _resetGoogleCacheForTests();
  const { enc_token, iv } = await encryptToken(env, "1//refresh");
  await env.DB.prepare(`INSERT INTO oauth_tokens (provider, account, scopes, enc_token, iv, created_at, verified_at) VALUES ('google','reillyworking26@gmail.com','x',?,?,'t','t')`).bind(enc_token, iv).run();
}

function baseEnv(extra = {}) {
  return { DB: makeD1(), BACKUPS: makeR2(), APPROVAL_SIGNING_KEY: "k".repeat(48), GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsec", ...extra };
}

/** Every P&L input fresh (as in pnl-extras.test.js). */
async function allFresh(DB, nowMs) {
  await ensureFeeds(DB);
  const at = iso(nowMs - 60000);
  for (const id of LIVE_STORE_IDS) {
    await DB.prepare(`INSERT INTO order_coverage (store, covered_from, completed_at) VALUES (?, '2026-09-01', ?)`).bind(id, at).run();
    await DB.prepare(`INSERT INTO order_backfill (store, query_from, started_at, updated_at, completed_at, last_full_read_at) VALUES (?, '2026-09-01', ?, ?, ?, ?)`).bind(id, at, at, at, at).run();
    for (const f of [`shopify.orders.${id}`, `ads.spend.${id}`, `shopify.payouts.${id}`]) await markFeedOk(DB, f, at);
    await DB.prepare(`INSERT INTO job_runs (job, last_run_at) VALUES (?, ?)`).bind(`refunds.${id}`, at).run();
    await DB.prepare(`INSERT INTO feed_coverage (store, feed, start_day, covered_from, updated_at) VALUES (?, 'refunds', '2026-09-01', '2026-09-01', ?)`).bind(id, at).run();
    // Fees known only from Oct 1 on: earlier days have no fees, like the live problem (Sep 25).
    await DB.prepare(`INSERT INTO balance_txns (store, txn_id, type, date, amount, fee, net, currency, test, fetched_at) VALUES (?, ?, 'ADJUSTMENT', '2026-09-30T12:00:00Z', 0, 0, 0, 'USD', 0, ?)`).bind(id, `anchor-${id}`, at).run();
  }
}

async function order(DB, store, { id, created_at, total, raw = null }) {
  await upsertOrder(DB, STORES[store], {
    order_id: `gid://shopify/Order/${store}-${id}`, name: `#${id}`, created_at, currency: "USD",
    subtotal: total, discounts: 0, total, financial_status: "paid", payload_updated_at: created_at,
  }, JSON.stringify(raw || { total_price: String(total), subtotal_price: String(total), total_tax: "0.00", total_shipping_price_set: { shop_money: { amount: "0.00" } }, line_items: [{ gift_card: false }] }), STORES[store].timezone, created_at);
}

async function closedDay(DB, store, day, f) {
  await DB.prepare(
    `INSERT INTO pnl_days (store, day, revenue, orders, ads, guy_fee, services, fees, cogs, cogs_est, cogs_actual, cogs_source, cogs_basis, profit, complete, status, notes, updated_at, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'closed', ?, ?, ?)`
  ).bind(store, day, f.revenue, f.orders, f.ads, f.guy_fee, f.guy_fee, f.fees, f.cogs ?? 30, f.cogs_est ?? 30, f.cogs_actual ?? null, f.cogs_source || "estimate",
    JSON.stringify(f.cogs_basis || {}), 1, JSON.stringify(f.notes || {}), iso(NOW), iso(NOW)).run();
}

/* ---------------- parsing ---------------- */

test("sheets: money and count parsing — $, €, commas, minus, \\-, parentheses; blank is null, never 0", () => {
  assert.equal(parseMoney("$1,045.28"), 1045.28);
  assert.equal(parseMoney("-$261.05"), -261.05);
  assert.equal(parseMoney("\\-$261.05"), -261.05);
  assert.equal(parseMoney("($12.50)"), -12.5);
  assert.equal(parseMoney("−$3.00"), -3);
  assert.equal(parseMoney("€313.03"), 313.03);
  assert.equal(parseMoney("$0.00"), 0);
  assert.equal(parseMoney(0), 0);
  assert.equal(parseMoney(""), null);
  assert.equal(parseMoney("   "), null);
  assert.equal(parseMoney(null), null);
  assert.equal(parseMoney(undefined), null);
  assert.equal(parseMoney("#DIV/0!"), null);
  assert.equal(parseMoney("n/a"), null);
  assert.equal(parseMoney("2.53x"), null, "a ROAS is not money");
  assert.equal(parseCount("1,204"), 1204);
  assert.equal(parseCount(""), null);
  assert.equal(parseSheetDate("10/01/2026"), "2026-10-01");
  assert.equal(parseSheetDate("7/4/2026"), "2026-07-04");
  assert.equal(parseSheetDate("2026-10-01"), "2026-10-01");
  assert.equal(parseSheetDate(serial("2026-10-13")), "2026-10-13");
  assert.equal(parseSheetDate("JULY 2026"), null);
  assert.equal(colLetter(0), "A");
  assert.equal(colLetter(17), "R");
  assert.equal(colLetter(26), "AA");
});

test("sheets: columns by header NAME (a moved column still maps), day rows only, the OCT totals row with a date is not a day", () => {
  const cols = headerMap(["X", "Orders", "Revenue", "Adspend Google", "COG (EUR)", "COG", "Transaction fee"]);
  assert.deepEqual(cols, { orders: 1, revenue: 2, adspend: 3, cog_eur: 4, cog_usd: 5, fee: 6 });
  const rows = monthTab(2026, 10, { "2026-10-01": { revenue: 604.75, adspend: 238.93, orders: 8, cog_eur: 159.6 }, "2026-10-02": { revenue: 0, orders: 0 } });
  const fmt = rows.map((r) => r.map((c) => (c && c.f != null ? c.f : "")));
  const frm = rows.map((r) => r.map((c) => (c && c.raw != null ? c.raw : "")));
  const p = parseMonthTab(fmt, frm);
  assert.equal(p.days.length, 31, "31 days, the totals row skipped although column A holds 10/01/2026");
  assert.equal(p.month, "2026-10");
  const d1 = p.days[0];
  assert.equal(d1.day, "2026-10-01");
  assert.equal(d1.values.revenue, 604.75);
  assert.equal(d1.values.cog_eur, 159.6);
  assert.equal(d1.values.orders, 8);
  assert.deepEqual(d1.formulas.sort(), ["cog_usd", "cpc", "profit", "roas"].sort());
  assert.equal(d1.cells.revenue, "B2");
  assert.equal(d1.cells.cog_eur, "R2");
  const d2 = p.days[1];
  assert.equal(d2.values.revenue, 0, "zero is a claim");
  assert.equal(d2.values.fee, null, "blank is null");
  assert.equal(writableBlank(d2, "fee"), true);
  assert.equal(writableBlank(d2, "revenue"), false, "a $0.00 the sheet holds is not blank");
  assert.equal(writableBlank(d2, "cog_usd"), false, "a formula is never writable");
  assert.equal(writableBlank(d2, "profit"), false);
  assert.equal(writableBlank(d2, "employee"), false, "EMPLOYEE is not an input the brain writes");
  assert.equal(tabForMonth(["SUMMARY", "JUL", "AUG", "SEP", "OCT", "SETUP"], "2026-10-14"), "OCT");
  assert.equal(tabForMonth(["SUMMARY", "SEP", "SETUP"], "2026-10-14"), null);
});

test("sheets: SETUP — FX rate, the revenue timezone, services ended, and the days named as estimates", () => {
  assert.deepEqual(datesIn("10-12 #1248 and 2026-09-09 and 10-13", "2026"), ["2026-09-09", "2026-10-12", "2026-10-13"]);
  assert.equal(tzHint("store timezone (CDT)"), "America/Chicago");
  assert.equal(tzHint("store timezone (EDT)"), "America/New_York");
  const rows = [
    ["Store", "Holt & Crane — holtandcrane.com (jmzjx1-it.myshopify.com)"],
    ["EUR → USD rate", "1.1900"],
    ["Revenue", "Shopify Analytics, daily, store timezone (CDT). Gross sales less discounts, before returns."],
    ["Services", "** ENDED 2026-10-13/14 — REILLY HAS STOPPED WORKING WITH THE MEDIA BUYER. Services was 10% of ad spend from 2026-09-07."],
    ["", "2026-09-09 is a partial day — Google Ads had not closed it when this was built."],
    ["", "Order #1024 (09-18) has not been billed by KungFuBuy yet, so 09-18 carries $0 COG."],
    ["", "Transaction fees for 09-21 and 09-22 are ESTIMATED at the measured 3.650%. 09-11 and 09-13 are actual payout fees."],
    ["** ESTIMATED COGS — GO BACK AND FIX (OCT)", "Updated 2026-10-14. KungFuBuy caught up and 10-01 through 10-11 are now FULLY INVOICED. Only two single orders remain unbilled: 10-12 #1248 $49.95 (est EUR 14.83) and 10-13 #1255 $79.94 (est EUR 23.73)."],
  ];
  const s = parseSetup(rows, { year: "2026" });
  assert.equal(s.fx_rate, 1.19);
  assert.equal(s.revenue_tz, "America/Chicago");
  assert.equal(s.services_ended, "2026-10-13", "the date right after ENDED, not the start date");
  assert.deepEqual(s.estimated.ads, ["2026-09-09"]);
  assert.deepEqual(s.estimated.fees, ["2026-09-21", "2026-09-22"]);
  assert.deepEqual(s.estimated.cogs, ["2026-09-18", "2026-10-12", "2026-10-13"], "fully invoiced days are not estimates");
  const cleared = estimatedDays([["** ESTIMATED COGS — GO BACK AND FIX (OCT)", "CLEARED 2026-10-14. Every order through 10-13 is now INVOICED."]], "2026");
  assert.deepEqual(cleared.cogs, []);
});

test("sheets: trust rules — $0 COG on a day with orders is unknown, not zero; estimates and recent days are not used", () => {
  const setup = { fx_rate: 1.19, estimated: { cogs: ["2026-10-12"], fees: ["2026-09-21"], ads: ["2026-09-09"] } };
  const today = "2026-10-14";
  const ok = trustRow({ cog_eur: 100, fee: 3, adspend: 50, orders: 2 }, setup, "2026-10-01", today);
  assert.deepEqual([ok.cog_ok, ok.fee_ok, ok.ads_ok], [1, 1, 1]);
  const zero = trustRow({ cog_eur: 0, fee: 0, adspend: 50, orders: 3 }, setup, "2026-09-18", today);
  assert.equal(zero.cog_ok, 0);
  assert.match(zero.cog_why, /\$0 on a day with 3 orders: unknown, not zero/);
  assert.equal(zero.fee_ok, 0);
  assert.equal(trustRow({ cog_eur: 0, orders: 0 }, setup, "2026-07-02", today).cog_ok, 1, "$0 COG with no orders is a real zero");
  assert.equal(trustRow({ cog_eur: 50, orders: 1 }, setup, "2026-10-12", today).cog_ok, 0, "named in SETUP as an estimate");
  assert.equal(trustRow({ cog_eur: 50, orders: 1 }, setup, "2026-10-13", today).cog_ok, 0, "too recent");
  assert.equal(trustRow({ fee: 5, orders: 1 }, setup, "2026-09-21", today).fee_ok, 0);
  assert.equal(trustRow({ adspend: 200 }, setup, "2026-09-09", today).ads_ok, 0, "partial day");
  assert.equal(trustRow({ cog_eur: 50, orders: 1 }, { estimated: setup.estimated }, "2026-10-01", today).cog_ok, 0, "no FX rate, no COG");
});

test("sheets: not wired → nothing changes and the state says so", async () => {
  const env = baseEnv();
  const r = await runSheets(env, { nowMs: NOW, fetchImpl: async () => { throw new Error("no network"); } });
  assert.match(r.status, /not wired/);
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM sheet_pnl_days`).first()).n, 0);
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM events`).first()).n, 0);
  const st = await sheetsState(env, { nowMs: NOW });
  assert.ok(st.workbooks.every((w) => w.status === "never read"));
});

test("sheets: a workbook that can't be read changes nothing (no fill, no write) and says so once a day", async () => {
  const env = baseEnv();
  await connectGoogle(env);
  await allFresh(env.DB, NOW);
  const books = { [HC]: book("Holt & Crane P&L", { SETUP: setupTab(), OCT: monthTab(2026, 10, { "2026-10-05": { adspend: 305.4, orders: 2, revenue: 111.9 } }) }) };
  const g = fakeGoogle(books, { failIds: [HC] });
  const r = await runSheets(env, { nowMs: NOW, fetchImpl: g.fetchImpl });
  assert.ok(r.unreachable.some((u) => u.store === "hc"));
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM sheet_pnl_days`).first()).n, 0);
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ad_spend_days`).first()).n, 0);
  assert.ok(!g.log.calls.some((c) => c.method === "POST"), "never writes");
  await runSheets(env, { nowMs: NOW + 3600000, fetchImpl: g.fetchImpl });
  const ev = (await evs(env.DB, "pnl.sheet_unreachable")).filter((e) => /Holt & Crane P&L/.test(e.summary));
  assert.equal(ev.length, 1, "once a day, not every hour");
  const st = await sheetsState(env, { nowMs: NOW });
  assert.match(st.workbooks.find((w) => w.store === "hc").status, /unreachable/);
});

test("sheets: a wrong sheet id (SETUP names another store) is refused — nothing read into the ledger", async () => {
  const env = baseEnv();
  await connectGoogle(env);
  const books = { [HC]: book("Auberlane P&L", { SETUP: setupTab({ store: "Auberlane — auberlane.com (3as2ya-dw.myshopify.com)" }), OCT: monthTab(2026, 10, { "2026-10-05": { revenue: 1, orders: 1 } }) }) };
  const r = await runSheets(env, { nowMs: NOW, fetchImpl: fakeGoogle(books).fetchImpl });
  assert.match(r.unreachable.find((u) => u.store === "hc").error, /does not name jmzjx1-it\.myshopify\.com/);
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM sheet_pnl_days WHERE store = 'hc'`).first()).n, 0);
});

test("sheets: fills ONLY missing ad spend days (source 'sheet'); an API day is never overwritten, a difference is logged once", async () => {
  const env = baseEnv({ SHEETS_WRITE: "0" });
  await connectGoogle(env);
  await allFresh(env.DB, NOW);
  // The API has Oct 6; Oct 5 and Sep 25 have no row (the live problem).
  await env.DB.prepare(`INSERT INTO ad_spend_days (store, day, cost, clicks, impressions, conv_value, currency, account_tz, fetched_at, source) VALUES ('hc', '2026-10-06', 359.49, 493, 900, 0, 'USD', 'America/Chicago', ?, 'api')`).bind(iso(NOW)).run();
  const books = { [HC]: book("Holt & Crane P&L", {
    SETUP: setupTab({ extra: [["", "2026-10-04 is a partial day — Google Ads had not closed it."]] }),
    SEP: monthTab(2026, 9, { "2026-09-25": { adspend: 230.1, clicks: 300 } }),
    OCT: monthTab(2026, 10, { "2026-10-04": { adspend: 1 }, "2026-10-05": { adspend: 305.4, clicks: 391 }, "2026-10-06": { adspend: 350.0, clicks: 493 } }),
  }) };
  const g = fakeGoogle(books);
  await runSheets(env, { nowMs: NOW, fetchImpl: g.fetchImpl });
  const ads = (await env.DB.prepare(`SELECT day, cost, clicks, source FROM ad_spend_days WHERE store = 'hc' ORDER BY day`).all()).results;
  const by = Object.fromEntries(ads.map((a) => [a.day, a]));
  assert.deepEqual([by["2026-09-25"].cost, by["2026-09-25"].source], [230.1, "sheet"]);
  assert.deepEqual([by["2026-10-05"].cost, by["2026-10-05"].clicks, by["2026-10-05"].source], [305.4, 391, "sheet"]);
  assert.equal(by["2026-10-04"], undefined, "a partial day named in SETUP is not used");
  assert.deepEqual([by["2026-10-06"].cost, by["2026-10-06"].source], [359.49, "api"], "the API row stays");
  assert.ok(!by["2026-10-14"], "today is never filled");
  assert.equal((await evs(env.DB, "pnl.sheet_filled")).length, 1);
  const mm = await evs(env.DB, "pnl.sheet_mismatch");
  assert.equal(mm.length, 1);
  assert.match(mm[0].summary, /2026-10-06 adspend: sheet \$350\.00 vs Google Ads API \$359\.49/);
  // A second run: no new fill, no second event for the same store/day/field.
  await runSheets(env, { nowMs: NOW + 3600000, fetchImpl: g.fetchImpl });
  assert.equal((await evs(env.DB, "pnl.sheet_mismatch")).length, 1);
  assert.equal((await evs(env.DB, "pnl.sheet_filled")).length, 1);
  assert.ok(!g.log.calls.some((c) => c.method === "POST"), "SHEETS_WRITE=0: no write");
  assert.equal(g.log.updates.length, 0);
});

test("sheets: the P&L uses the sheet's COG and fee only where the brain has none, and only when the sheet's day is the brain's day", async () => {
  const env = baseEnv();
  const DB = env.DB;
  await allFresh(DB, NOW);
  const day = "2026-09-25";
  await order(DB, "hc", { id: 1, created_at: "2026-09-25T15:00:00Z", total: 100 });
  await order(DB, "hc", { id: 2, created_at: "2026-09-25T16:00:00Z", total: 50 });
  await DB.prepare(`INSERT INTO ad_spend_days (store, day, cost, clicks, impressions, conv_value, currency, account_tz, fetched_at, source) VALUES ('hc', ?, 60, 90, 0, 0, 'USD', NULL, ?, 'sheet')`).bind(day, iso(NOW)).run();
  // Freshness is the row's tab: seen_at = when that tab was last read in full.
  const sheetRow = async (d, v) => DB.prepare(
    `INSERT OR REPLACE INTO sheet_pnl_days (store, day, sheet_id, tab, row_no, revenue, orders, fee, cog_eur, fx_rate, cog_ok, cog_why, fee_ok, fee_why, ads_ok, read_at, seen_at)
     VALUES ('hc', ?, 'x', 'SEP', 26, ?, ?, ?, ?, 1.19, ?, ?, ?, ?, 1, ?, ?)`
  ).bind(d, v.revenue, v.orders, v.fee, v.cog_eur, v.cog_ok, v.cog_why || null, v.fee_ok, v.fee_why || null, iso(NOW - 3 * 86400000), v.read_at || iso(NOW - 600000)).run();

  // Before: Sep 25 has no fees (payouts only read from Oct 1) and an estimated COGS.
  let row = await computeStoreDay(DB, "hc", day, { nowMs: NOW });
  assert.equal(row.fees, null);
  assert.equal(row.cogs_source, "estimate");
  assert.equal(row.profit, null);

  await sheetRow(day, { revenue: 150, orders: 2, fee: 5.2, cog_eur: 40, cog_ok: 1, fee_ok: 1 });
  row = await computeStoreDay(DB, "hc", day, { nowMs: NOW });
  assert.equal(row.fees, 5.2);
  assert.equal(row.notes.fees_source, "sheet");
  assert.equal(row.cogs, 47.6);
  assert.equal(row.cogs_source, "sheet (KFB ledger, EUR at 1.19)");
  assert.equal(row.cogs_basis.sheet.fx_estimate, true, "the FX rate stays an estimate");
  assert.equal(row.cogs_basis.sheet.estimated_part, "fx");
  // The EUR is exact but the dollars rest on an estimated rate: the COGS counts as estimated.
  assert.equal(row.cogs_est, 47.6);
  assert.equal(row.cogs_actual, null);
  assert.equal(row.cogs_estimated_share, 1);
  assert.match(row.notes.cogs_fx, /the rate is an estimate/);
  assert.equal(row.notes.ads_source, "sheet");
  assert.ok(row.profit != null, "the day is no longer missing its costs");

  // A sheet COG well under the brain's estimate ($150 x 33% = $49.50) is probably partial: refused.
  await sheetRow(day, { revenue: 150, orders: 2, fee: 5.2, cog_eur: 20, cog_ok: 1, fee_ok: 1 });
  row = await computeStoreDay(DB, "hc", day, { nowMs: NOW });
  assert.equal(row.cogs_source, "estimate");
  assert.equal(row.cogs, 49.5);
  assert.match(row.notes.cogs_sheet_unused, /under 85% of the estimate/);

  // $0 COG on a day with orders: unknown → the brain keeps its own (labelled) estimate.
  await sheetRow(day, { revenue: 150, orders: 2, fee: 5.2, cog_eur: 0, cog_ok: 0, cog_why: "sheet COG is $0 on a day with 2 orders: unknown, not zero", fee_ok: 1 });
  row = await computeStoreDay(DB, "hc", day, { nowMs: NOW });
  assert.equal(row.cogs_source, "estimate");
  assert.match(row.notes.cogs_sheet_unused, /unknown, not zero/);

  // A different set of orders (the sheet counts days in another timezone): nothing is used.
  await sheetRow(day, { revenue: 199.95, orders: 3, fee: 7, cog_eur: 60, cog_ok: 1, fee_ok: 1 });
  row = await computeStoreDay(DB, "hc", day, { nowMs: NOW });
  assert.equal(row.fees, null);
  assert.equal(row.cogs_source, "estimate");
  assert.match(row.notes.missing_why.fees, /sheet's day doesn't match the brain's \(orders 3 vs 2/);

  // A sheet read older than 26 h (it is read every morning) is not used (rule 4).
  await sheetRow(day, { revenue: 150, orders: 2, fee: 5.2, cog_eur: 40, cog_ok: 1, fee_ok: 1, read_at: iso(NOW - 27 * 3600000) });
  row = await computeStoreDay(DB, "hc", day, { nowMs: NOW });
  assert.equal(row.fees, null);
  assert.match(row.notes.missing_why.fees, /older than 26 h/);

  // The brain's own fee wins: Oct 2 is covered by payouts, so the sheet's fee is ignored.
  await order(DB, "hc", { id: 3, created_at: "2026-10-02T15:00:00Z", total: 80 });
  await DB.prepare(`INSERT INTO balance_txns (store, txn_id, type, date, amount, fee, net, currency, test, fetched_at) VALUES ('hc', 'c1', 'CHARGE', '2026-10-02T15:00:05Z', 80, 2.62, 77.38, 'USD', 0, ?)`).bind(iso(NOW)).run();
  await sheetRow("2026-10-02", { revenue: 80, orders: 1, fee: 9.99, cog_eur: 20, cog_ok: 1, fee_ok: 1 });
  row = await computeStoreDay(DB, "hc", "2026-10-02", { nowMs: NOW });
  assert.equal(row.fees, 2.62);
  assert.equal(row.notes.fees_source, undefined);
});

test("sheets: cross-check — revenue, orders, services and fees vs closed brain days, once per store/day/field", async () => {
  const env = baseEnv();
  const DB = env.DB;
  await closedDay(DB, "hc", "2026-10-03", { revenue: 726.44, orders: 11, ads: 326.57, guy_fee: 32.66, fees: 24.19 });
  await DB.prepare(`INSERT INTO sheet_pnl_days (store, day, sheet_id, tab, row_no, revenue, orders, services, fee, read_at) VALUES ('hc', '2026-10-03', 'x', 'OCT', 4, 700.00, 10, 32.66, 24.50, ?)`).bind(iso(NOW)).run();
  // Not compared while its tab has no complete read in the last 24 h (rule 4).
  assert.equal((await crossCheck(DB, { nowMs: NOW })).length, 0);
  await DB.prepare(`UPDATE sheet_pnl_days SET seen_at = ? WHERE store = 'hc' AND tab = 'OCT'`).bind(iso(NOW)).run();
  const found = await crossCheck(DB, { nowMs: NOW });
  // Revenue before 2026-10-14 isn't compared: the sheet's was products only, the brain's is
  // everything the customer paid (Reilly 2026-10-15).
  assert.deepEqual(found.map((f) => f.field).sort(), ["orders"], "a $0.31 fee difference is rounding, services agree");
  assert.equal((await crossCheck(DB, { nowMs: NOW + 3600000 })).length, 0, "already logged");
  assert.equal((await evs(DB, "pnl.sheet_mismatch")).length, 1);
  assert.equal((await DB.prepare(`SELECT revenue FROM pnl_days WHERE store = 'hc' AND day = '2026-10-03'`).first()).revenue, 726.44, "nothing overwritten");
  assert.equal(await fillAdsFromSheet(DB, { nowMs: NOW }).then((x) => x.length), 0);
});

/* ---------------- the writer ---------------- */

async function writerFixture(envExtra = {}, { tz = "EDT", oct = null, basisMatch = 8 } = {}) {
  _resetTokenCacheForTests();
  const env = baseEnv({ SB_HC_CLIENT_ID: "hc-id", SB_HC_CLIENT_SECRET: "hc-secret", ...envExtra });
  await connectGoogle(env);
  const DB = env.DB;
  // Oct 1-8: days Reilly filled by hand, all closed in the brain. `basisMatch` of them agree
  // with the brain (orders exact, revenue within $1); the rest are cut on another day basis.
  const handFilled = {};
  for (let d = 1; d <= 8; d++) {
    const day = `2026-10-0${d}`;
    const agree = d <= basisMatch;
    await closedDay(DB, "hc", day, { revenue: 100 + d, orders: 2, ads: 50, guy_fee: 5, fees: 3 });
    handFilled[day] = { revenue: agree ? 100 + d : 160 + d, orders: agree ? 2 : 3, adspend: 50, services: 5, fee: 3, clicks: 60, sessions: 70, cog_eur: 30 };
  }
  // Oct 11 closed in the brain (3 days old, so its ad numbers have settled): 2 orders, $100, no shipping or tax.
  await order(DB, "hc", { id: 11, created_at: "2026-10-11T15:00:00Z", total: 60 });
  await order(DB, "hc", { id: 12, created_at: "2026-10-11T16:00:00Z", total: 40 });
  await closedDay(DB, "hc", "2026-10-11", { revenue: 100, orders: 2, ads: 420.05, guy_fee: 42.01, fees: 3.5 });
  await closedDay(DB, "hc", "2026-10-12", { revenue: 240, orders: 4, ads: 394.42, guy_fee: 39.44, fees: 7.89 });
  await DB.prepare(`INSERT INTO ad_spend_days (store, day, cost, clicks, impressions, conv_value, currency, account_tz, fetched_at, source) VALUES ('hc', '2026-10-11', 420.05, 543, 900, 0, 'USD', 'America/Chicago', ?, 'api')`).bind(iso(NOW)).run();
  await DB.prepare(`INSERT INTO funnel_days (store, day, sessions, partial, fetched_at) VALUES ('hc', '2026-10-11', 727, 0, ?)`).bind(iso(NOW)).run();
  const books = { [HC]: book("Holt & Crane P&L", {
    SUMMARY: [[cell("HOLT & CRANE — P&L")]],
    OCT: oct || monthTab(2026, 10, {
      ...handFilled,
      // Reilly typed Oct 12 by hand (revenue differs from the brain's): his numbers win.
      "2026-10-12": { revenue: 236.8, adspend: 394.42, services: 39.44, fee: 7.89, orders: 4, clicks: 547, sessions: 709, cog_eur: 61.9 },
      // Oct 11: Reilly has only typed Clicks so far.
      "2026-10-11": { clicks: 540 },
    }),
    SETUP: setupTab({ tz }),
  }) };
  return { env, DB, books };
}

test("sheets writer: fills only BLANK input cells of a CLOSED day — never a formula, never a non-blank cell, never outside the row", async () => {
  const { env, DB, books } = await writerFixture();
  const before = JSON.parse(JSON.stringify(books[HC].tabs.OCT));
  const g = fakeGoogle(books);
  const r = await runSheets(env, { nowMs: NOW, fetchImpl: g.fetchImpl });
  assert.equal(r.written.hc, 7);
  assert.equal(r.mode, "live (Reilly 2026-10-14, decision pnl.sheets_write)");
  const cells = Object.fromEntries(g.log.updates.map((u) => [u.range, u.value]));
  // Oct 13 is row 14.
  assert.deepEqual(cells, { "'OCT'!B12": 100, "'OCT'!D12": 420.05, "'OCT'!E12": 42.01, "'OCT'!G12": 3.5, "'OCT'!O12": 2, "'OCT'!Q12": 727, "'OCT'!R12": 25.21 });
  assert.ok(!("'OCT'!P12" in cells), "Clicks was typed by Reilly: not touched");
  // Not every KFB charge is in: the brain's COGS estimate goes in, in EUR at the sheet's rate
  // (Reilly 2026-10-15), and is replaced by the actual total later.
  assert.equal(cells["'OCT'!R12"], 25.21, "COG (EUR) estimate = brain COGS $30 / 1.19");
  assert.ok(Object.keys(cells).every((c) => /12$/.test(c)), "nothing outside the day's row");
  assert.ok(!Object.keys(cells).some((c) => /'OCT'!(C|H|I|J|K|L|M)\d+/.test(c)), "no formula column");
  assert.ok(!Object.keys(cells).some((c) => /13$/.test(c)), "Oct 12 (row 13) is Reilly's: untouched");
  assert.ok(!Object.keys(cells).some((c) => /'(SUMMARY|SETUP)'/.test(c)));
  // Every other cell of the workbook is exactly as it was.
  const after = books[HC].tabs.OCT;
  for (let ri = 0; ri < before.length; ri++) for (let ci = 0; ci < 18; ci++) {
    if (ri === 11 && [1, 3, 4, 6, 14, 16, 17].includes(ci)) continue;
    assert.deepEqual(after[ri] && after[ri][ci] ? after[ri][ci] : null, before[ri] && before[ri][ci] ? before[ri][ci] : null, `cell r${ri + 1}c${ci} unchanged`);
  }
  const ev = await evs(DB, "pnl.sheet_written");
  assert.equal(ev.length, 1);
  assert.match(ev[0].summary, /filled 7 blank cells \(2026-10-11\), each confirmed by a re-read/);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM sheet_writes WHERE verified = 1`).first()).n, 7);
  // Reilly's Oct 12 revenue (products only, before the 10-15 decision) is not compared or overwritten.
  const mm = await evs(DB, "pnl.sheet_mismatch");
  assert.ok(!mm.some((e) => /2026-10-12 revenue/.test(e.summary)));
  // Once an hour per workbook.
  const again = await runSheets(env, { nowMs: NOW + 10 * 60000, fetchImpl: g.fetchImpl });
  assert.equal(again.written.hc, "not due");
  const st = await sheetsState(env, { nowMs: NOW });
  assert.equal(st.cells_written_today, 7);
  assert.ok(st.mismatches_total >= 1);
});

test("sheets writer: a backup in R2 exists (and was checked) before the write; no backup bucket → nothing written", async () => {
  const { env, books } = await writerFixture();
  let backedUp = false;
  const g = fakeGoogle(books, { onUpdate: (id) => {
    const keys = [...env.BACKUPS._store.keys()];
    backedUp = keys.some((k) => k.includes(`sheets_${id}_OCT`));
    const snap = JSON.parse(env.BACKUPS._store.get(keys[0]));
    assert.equal(snap.data.rows[0].formatted[0], "10/13/2026", "the snapshot holds the row as it was");
    assert.ok(snap.data.rows[0].formulas.some((f) => String(f).startsWith("=")), "and its formulas");
  } });
  await runSheets(env, { nowMs: NOW, fetchImpl: g.fetchImpl });
  assert.ok(backedUp, "backup present at the moment of writing");
  const w = await env.DB.prepare(`SELECT backup_key FROM sheet_writes LIMIT 1`).first();
  assert.ok(env.BACKUPS._store.has(w.backup_key));

  const noBucket = await writerFixture({ BACKUPS: undefined });
  delete noBucket.env.BACKUPS;
  const g2 = fakeGoogle(noBucket.books);
  const r = await runSheets(noBucket.env, { nowMs: NOW, fetchImpl: g2.fetchImpl });
  assert.equal(g2.log.updates.length, 0);
  assert.match(r.written.hc.error, /Backup Vault is not bound/);
  assert.equal((await evs(noBucket.DB, "error.sheet_write")).length, 1);
});

test("sheets writer: re-read verification — a value that didn't land is reported, not claimed", async () => {
  const { env, DB, books } = await writerFixture();
  const g = fakeGoogle(books, { tamper: (v) => v + 1 });
  await runSheets(env, { nowMs: NOW, fetchImpl: g.fetchImpl });
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM sheet_writes WHERE verified = 1`).first()).n, 0);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM sheet_writes WHERE verified = 0`).first()).n, 7);
  const bad = await evs(DB, "pnl.sheet_write_unverified");
  assert.equal(bad.length, 1);
  assert.match(bad[0].summary, /did not read back as written/);
  assert.match((await evs(DB, "pnl.sheet_written"))[0].summary, /filled 0 blank cells/);
});

test("sheets writer: the kill switch SHEETS_WRITE=0 stops every write; default is on", async () => {
  assert.equal(sheetsWriteOn({}), true);
  assert.equal(sheetsWriteOn({ SHEETS_WRITE: "1" }), true);
  assert.equal(sheetsWriteOn({ SHEETS_WRITE: "0" }), false);
  const { env, books } = await writerFixture({ SHEETS_WRITE: "0" });
  const g = fakeGoogle(books);
  const r = await runSheets(env, { nowMs: NOW, fetchImpl: g.fetchImpl });
  assert.equal(r.write, "off (SHEETS_WRITE=0)");
  assert.equal(g.log.updates.length, 0);
  assert.ok(!g.log.calls.some((c) => c.method === "POST"));
  assert.equal(r.read.includes("hc"), true, "still reads and cross-checks");
  // Reilly's words are recorded verbatim as the decision behind it.
  const seed = SEED_DECISIONS.find((s) => s.topic === "pnl.sheets_write");
  assert.equal(seed.words, "make sure things like the google drive P&L sheets are all updated by the brain automatically");
  assert.equal(seed.words, SHEETS_WRITE_DECISION.words);
  const agent = AGENTS.find((a) => a.id === "pnl.sheets");
  assert.equal(agent.status, "live", "Reilly asked for it in so many words: live, not shadow");
  for (const v of ["0", "false", "off", "OFF", " False "]) assert.equal(sheetsWriteOn({ SHEETS_WRITE: v }), false, v);
  assert.ok(AGENT_DOES["pnl.sheets"]);
});

test("sheets writer: Shopify's timezone is the authority — a stale SETUP label (CDT) doesn't block writing once the sheet's own days prove the same day basis; the label conflict is noted", async () => {
  const { env, books } = await writerFixture({}, { tz: "CDT" });
  const g = fakeGoogle(books);
  await runSheets(env, { nowMs: NOW, fetchImpl: g.fetchImpl });
  const cells = g.log.updates.map((u) => u.range).sort();
  assert.deepEqual(cells, ["'OCT'!B12", "'OCT'!D12", "'OCT'!E12", "'OCT'!G12", "'OCT'!O12", "'OCT'!Q12", "'OCT'!R12"]);
  assert.equal(g.log.shop, 1, "Shopify asked once (cached for the day)");
  const st = await sheetsState(env, { nowMs: NOW });
  const hc = st.workbooks.find((w) => w.store === "hc");
  assert.equal(hc.shopify_timezone, "America/New_York");
  assert.equal(hc.timezone_note, "SETUP says CDT but Shopify says Eastern (America/New_York); please fix the label in SETUP (the brain never edits SETUP)");
  assert.equal(hc.day_basis.ok, true);
  assert.equal(hc.day_basis.checked, 9);
  assert.equal(hc.day_basis.matched, 9, "orders only: the one day that differs only in revenue still matches");
  assert.ok(!g.log.updates.some((u) => /SETUP/.test(u.range)), "SETUP is never edited");
  assert.match(books[HC].tabs.SETUP.find((r) => r[0] && r[0].f === "Revenue")[1].f, /\(CDT\)/, "the label is left for Reilly");
});

test("sheets writer: day basis NOT proven (fewer than 8 of the last 10 hand-filled days match) → no revenue, orders, fees, COG or sessions, and it says which days differ", async () => {
  const { env, books } = await writerFixture({}, { basisMatch: 5 });
  const g = fakeGoogle(books);
  await runSheets(env, { nowMs: NOW, fetchImpl: g.fetchImpl });
  assert.deepEqual(g.log.updates.map((u) => u.range).sort(), ["'OCT'!D12", "'OCT'!E12"], "ad-account numbers only");
  const st = await sheetsState(env, { nowMs: NOW });
  const hc = st.workbooks.find((w) => w.store === "hc");
  assert.equal(hc.day_basis.ok, false);
  assert.match(hc.day_basis.why, /6 of 9 match/);
  assert.ok(hc.day_basis.mismatching_days.some((d) => /^2026-10-06 \(orders 3 vs 2/.test(d)));
  assert.ok(Object.keys(hc.last_write.skipped).some((k) => /don't match the brain's/.test(k)));
});

test("sheets writer: Shopify's timezone differs from stores.js → alarm, and no day-based cell is written", async () => {
  const { env, DB, books } = await writerFixture();
  const g = fakeGoogle(books, { shopTz: "America/Chicago" });
  await runSheets(env, { nowMs: NOW, fetchImpl: g.fetchImpl });
  assert.deepEqual(g.log.updates.map((u) => u.range).sort(), ["'OCT'!D12", "'OCT'!E12"]);
  const ev = await evs(DB, "error.store_timezone");
  assert.equal(ev.length, 1);
  assert.match(ev[0].summary, /Shopify says the store runs on America\/Chicago but the brain counts days in America\/New_York/);
});

test("sheets: the day-basis proof is pure; a pass is cached for a day, a failure is re-worked every run", async () => {
  const { judgeDayBasis, dayBasis } = await import("../src/agents/pnl/sheets.js");
  const pair = (day, so, bo, sr, br) => ({ day, sheet_orders: so, brain_orders: bo, sheet_revenue: sr, brain_revenue: br });
  const ten = Array.from({ length: 10 }, (_, i) => pair(`2026-10-${String(i + 1).padStart(2, "0")}`, 2, 2, 100, 100.5));
  assert.equal(judgeDayBasis(ten).ok, true);
  ten[0] = pair("2026-10-01", 3, 2, 100, 100); ten[1] = pair("2026-10-02", 1, 2, 100, 102); ten[2] = pair("2026-10-03", 4, 2, 90, 100);
  // Revenue alone never fails the proof (the sheet's hand-filled revenue was products only).
  assert.equal(judgeDayBasis(Array.from({ length: 10 }, (_, i) => pair(`2026-10-${String(i + 1).padStart(2, "0")}`, 2, 2, 100, 140))).ok, true);
  const r = judgeDayBasis(ten);
  assert.deepEqual([r.ok, r.matched, r.checked], [false, 7, 10]);
  assert.equal(r.mismatching_days.length, 3);
  assert.equal(judgeDayBasis(ten.slice(5)).ok, false, "too few days to prove anything");
  // Only the LAST 10 days count.
  const old = [pair("2026-09-01", 9, 1, 0, 50), ...Array.from({ length: 10 }, (_, i) => pair(`2026-10-${String(i + 1).padStart(2, "0")}`, 1, 1, 10, 10))];
  assert.equal(judgeDayBasis(old).ok, true);
  // Cached a day.
  const DB = makeD1();
  await DB.prepare(`INSERT INTO sheet_workbooks (store, sheet_id) VALUES ('hc', 'x')`).run();
  const a = await dayBasis(DB, "hc", { nowMs: NOW });
  assert.equal(a.ok, false);
  for (let d = 1; d <= 8; d++) {
    await closedDay(DB, "hc", `2026-10-0${d}`, { revenue: 10, orders: 1, ads: 1, guy_fee: 0.1, fees: 0.3 });
    await DB.prepare(`INSERT INTO sheet_pnl_days (store, day, sheet_id, tab, row_no, revenue, orders, read_at) VALUES ('hc', ?, 'x', 'OCT', 2, 10, 1, 't')`).bind(`2026-10-0${d}`).run();
  }
  // A FAILING proof is never kept (live 2026-10-15: a stale "0 days" blocked two stores' fill).
  assert.equal((await dayBasis(DB, "hc", { nowMs: NOW + 3600000 })).ok, true, "a failure is re-worked next run");
  // A passing proof is kept for a day, then re-evaluated.
  await DB.prepare(`UPDATE sheet_pnl_days SET orders = 5 WHERE store = 'hc'`).run();
  assert.equal((await dayBasis(DB, "hc", { nowMs: NOW + 2 * 3600000 })).ok, true, "a pass is cached for a day");
  assert.equal((await dayBasis(DB, "hc", { nowMs: NOW + 26 * 3600000 })).ok, false, "re-evaluated daily");
});

test("sheets writer: a missing month tab is never created — one event a day asks Reilly", async () => {
  const env = baseEnv();
  await connectGoogle(env);
  const books = { [HC]: book("Holt & Crane P&L", { SUMMARY: [[cell("x")]], SEP: monthTab(2026, 9, {}), SETUP: setupTab() }) };
  const g = fakeGoogle(books);
  const r = await runSheets(env, { nowMs: NOW, fetchImpl: g.fetchImpl });
  assert.ok(r.missing_tabs.includes("Holt & Crane P&L: OCT"));
  await runSheets(env, { nowMs: NOW + 3600000, fetchImpl: g.fetchImpl });
  const ev = (await evs(env.DB, "pnl.sheet_tab_missing")).filter((e) => /Holt & Crane/.test(e.summary));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].summary, "OCT tab missing in Holt & Crane P&L; Reilly adds month tabs (the brain never creates them)");
  assert.deepEqual(Object.keys(books[HC].tabs), ["SUMMARY", "SEP", "SETUP"], "no tab created");
  assert.ok(!g.log.calls.some((c) => c.method === "POST" && c.what !== "values:batchUpdate"));
  assert.deepEqual((await sheetsState(env, { nowMs: NOW })).missing_tabs, ["Holt & Crane P&L: OCT"]);
});

test("sheets: the Ecom P&L gets the sum of the three store sheets in its blank cells, and a filled cell that disagrees is a mismatch", async () => {
  const env = baseEnv();
  await connectGoogle(env);
  const mk = (store, domain, d13) => book(`${store} P&L`, { OCT: monthTab(2026, 10, { "2026-10-13": d13 }, store.toUpperCase()), SETUP: setupTab({ store: `${store} (${domain})` }) });
  const books = {
    [STORES.hc.pnlSheetId]: mk("Holt & Crane", "jmzjx1-it.myshopify.com", { revenue: 543.44, orders: 7, adspend: 420.05 }),
    [STORES.aub.pnlSheetId]: mk("Auberlane", "3as2ya-dw.myshopify.com", { revenue: 0, orders: 0, adspend: 14.4 }),
    [STORES.mar.pnlSheetId]: mk("Marlowe Standard", "806080-g8.myshopify.com", { revenue: 79.95, orders: 1 }),
    "1xL1Nbv0I1rztGx_a--1LJPg_YnjrdRkR04oLbIHDFw4": book("Ecom P&L", {
      OCT: monthTab(2026, 10, { "2026-10-13": { orders: 9 } }, "ALL STORES"),
      SETUP: setupTab({ store: "x", extra: [] }).map((r) => (r[0] && r[0].f === "Store" ? [cell("Scope"), cell("ALL STORES — the three stores summed day by day.")] : r)),
    }),
  };
  const g = fakeGoogle(books);
  const r = await runSheets(env, { nowMs: NOW, fetchImpl: g.fetchImpl });
  assert.equal(r.written.all, 1);
  const ecom = g.log.updates.filter((u) => u.id === "1xL1Nbv0I1rztGx_a--1LJPg_YnjrdRkR04oLbIHDFw4");
  assert.deepEqual(ecom.map((u) => [u.range, u.value]), [["'OCT'!B14", 623.39]], "revenue = 543.44 + 0 + 79.95; ad spend not summed (Marlowe blank)");
  const mm = await evs(env.DB, "pnl.sheet_mismatch");
  assert.ok(mm.some((e) => /Ecom P&L 2026-10-13 orders: sheet 9 vs sum of the three store sheets 8/.test(e.summary)));
});

/* ---------------- Google Ads history backfill ---------------- */

test("ads history: reads from 2026-07-01 in chunks with a saved cursor, skips days before first spend, the API replaces sheet days", async () => {
  const env = baseEnv();
  await connectGoogle(env);
  const DB = env.DB;
  await DB.prepare(`INSERT INTO ad_spend_days (store, day, cost, clicks, impressions, conv_value, currency, account_tz, fetched_at, source) VALUES ('hc', '2026-07-20', 2.00, 4, 0, 0, 'USD', NULL, ?, 'sheet')`).bind(iso(NOW)).run();
  const queries = [];
  let fail = false;
  const fetchImpl = async (url, init) => {
    if (url === "https://oauth2.googleapis.com/token") return j({ access_token: "g", expires_in: 3600 });
    assert.match(url, /^https:\/\/googleads\.googleapis\.com\/v\d+\/customers\/\d+\/googleAds:searchStream$/);
    const q = JSON.parse(init.body).query;
    if (!/segments\.date/.test(q)) return j([{ results: [{ customer: { timeZone: "America/Chicago", currencyCode: "USD" } }] }]);
    if (fail) return j({ error: { status: "UNAVAILABLE", message: "try later" } }, 503);
    const cid = url.match(/customers\/(\d+)\//)[1];
    const [, from, to] = q.match(/BETWEEN '([\d-]+)' AND '([\d-]+)'/);
    queries.push({ cid, from, to });
    const rows = [];
    for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
      if (cid === "7108143649" && d >= "2026-07-13") rows.push({ segments: { date: d }, metrics: { costMicros: String(2190000), clicks: "4", impressions: "50", conversionsValue: 0 } });
    }
    return j([{ results: rows }]);
  };
  assert.equal(historyEnd("2026-10-14"), "2026-10-06");
  await runAdsHistory(env, { nowMs: NOW, fetchImpl });
  let st = await DB.prepare(`SELECT * FROM ads_backfill WHERE store = 'hc'`).first();
  assert.equal(st.cursor_day, "2026-09-01", "two 31-day chunks this run, cursor saved");
  assert.equal(st.first_spend_day, "2026-07-13");
  assert.equal(st.done_at, null);
  assert.equal((await DB.prepare(`SELECT MIN(day) AS d FROM ad_spend_days WHERE store = 'hc'`).first()).d, "2026-07-13", "nothing before the first spend");
  const r720 = await DB.prepare(`SELECT cost, source FROM ad_spend_days WHERE store = 'hc' AND day = '2026-07-20'`).first();
  assert.deepEqual([r720.cost, r720.source], [2.19, "api"], "the API replaced the sheet's figure");
  // A failed chunk leaves the cursor where it was (retried next run).
  fail = true;
  const failed = await runAdsHistory(env, { nowMs: NOW + 3600000, fetchImpl });
  assert.ok(failed.find((x) => x.store === "hc").error);
  assert.equal((await DB.prepare(`SELECT cursor_day FROM ads_backfill WHERE store = 'hc'`).first()).cursor_day, "2026-09-01");
  fail = false;
  await runAdsHistory(env, { nowMs: NOW + 7200000, fetchImpl });
  st = await DB.prepare(`SELECT * FROM ads_backfill WHERE store = 'hc'`).first();
  assert.ok(st.done_at, "done after reaching the hourly window");
  assert.equal((await DB.prepare(`SELECT MAX(day) AS d FROM ad_spend_days WHERE store = 'hc'`).first()).d, "2026-10-06");
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM ad_spend_days WHERE store = 'hc' AND day BETWEEN '2026-09-25' AND '2026-10-03'`).first()).n, 9, "the live gap (Sep 25 to Oct 3) is filled");
  assert.ok(queries.every((q) => Math.round((Date.parse(q.to) - Date.parse(q.from)) / 86400000) + 1 <= CHUNK_DAYS));
  const ev = (await evs(DB, "ads.history_backfilled")).filter((e) => e.store === "hc");
  assert.equal(ev.length, 1);
  // An account with no spend at all writes nothing.
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM ad_spend_days WHERE store = 'aub'`).first()).n, 0);
  const n = queries.length;
  await runAdsHistory(env, { nowMs: NOW + 3 * 3600000, fetchImpl });
  assert.equal(queries.filter((q) => q.cid === "7108143649").length, queries.slice(0, n).filter((q) => q.cid === "7108143649").length, "done: no more reads");
});

/* ---------------- order history extension ---------------- */

const ENV_SHOP = { SB_HC_CLIENT_ID: "hc-id", SB_HC_CLIENT_SECRET: "hc-secret" };

function fakeShop({ scopes, orders, refundOrders = [] }) {
  const queries = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/admin/oauth/access_token")) return j({ access_token: "tok", expires_in: 86400 });
    assert.ok(url.startsWith("https://jmzjx1-it.myshopify.com/admin/api/"));
    const body = JSON.parse(init.body);
    if (/currentAppInstallation/.test(body.query)) return j({ data: { currentAppInstallation: { accessScopes: scopes.map((h) => ({ handle: h })) } } });
    const q = body.variables.query;
    queries.push(q);
    if (/RecentRefunds/.test(body.query)) return j({ data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: refundOrders } } });
    const from = q.match(/created_at:>='([^']+)'/)[1], to = q.match(/created_at:<'([^']+)'/)[1];
    const nodes = orders.filter((o) => o.createdAt >= from && o.createdAt < to);
    return j({ data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } });
  };
  return { fetchImpl, queries };
}
const node = (id, at, total) => ({
  id: `gid://shopify/Order/${id}`, name: `#${id}`, createdAt: at, updatedAt: at, test: false, currencyCode: "USD", displayFinancialStatus: "PAID",
  currentSubtotalPriceSet: { shopMoney: { amount: String(total) } }, currentTotalDiscountsSet: { shopMoney: { amount: "0" } },
  currentTotalPriceSet: { shopMoney: { amount: String(total) } }, totalPriceSet: { shopMoney: { amount: String(total) } }, shippingLine: null,
});

async function historyFixture(DB) {
  const at = iso(NOW - 86400000);
  await DB.prepare(`INSERT INTO order_coverage (store, covered_from, completed_at) VALUES ('hc', '2026-09-01', ?)`).bind(at).run();
  await DB.prepare(`INSERT INTO order_backfill (store, query_from, started_at, updated_at, completed_at, last_full_read_at) VALUES ('hc', '2026-09-01', ?, ?, ?, ?)`).bind(at, at, at, at).run();
  await DB.prepare(`INSERT INTO feed_coverage (store, feed, start_day, covered_from, updated_at) VALUES ('hc', 'refunds', '2026-09-01', '2026-09-01', ?)`).bind(at).run();
}

test("history extension: with read_all_orders, orders and refunds reach back to 2026-07-01, and coverage moves only when each gap is read", async () => {
  _resetTokenCacheForTests();
  const env = { DB: makeD1(), ...ENV_SHOP };
  await historyFixture(env.DB);
  const shop = fakeShop({
    scopes: ["read_orders", "read_all_orders"],
    orders: [node(1004, "2026-08-15T18:00:00Z", 56.95), node(1005, "2026-08-16T18:00:00Z", 73.95), node(1100, "2026-09-03T18:00:00Z", 10)],
    refundOrders: [{ id: "gid://shopify/Order/1004", name: "#1004", updatedAt: "2026-08-20T12:00:00Z", refunds: [{ id: "gid://shopify/Refund/1", createdAt: "2026-08-20T12:00:00Z", processedAt: "2026-08-20T12:00:00Z",
      transactions: { nodes: [{ id: "t1", kind: "REFUND", status: "SUCCESS", processedAt: "2026-08-20T12:00:00Z", amountSet: { shopMoney: { amount: "56.95", currencyCode: "USD" } } }] } }] }],
  });
  await runHistoryExtension(env, { nowMs: NOW, opts: { fetchImpl: shop.fetchImpl } });
  assert.equal((await env.DB.prepare(`SELECT covered_from FROM order_coverage WHERE store = 'hc'`).first()).covered_from, "2026-07-01");
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM orders WHERE store = 'hc'`).first()).n, 2, "only the gap was read (the Sep order is outside it)");
  assert.match(shop.queries[0], /^created_at:>='2026-07-01T04:00:00\.000Z' created_at:<'2026-09-01T04:00:00\.000Z'$/);
  // Refunds still from Sep 1 until their own gap is read (next run).
  assert.equal((await env.DB.prepare(`SELECT covered_from FROM feed_coverage WHERE store = 'hc' AND feed = 'refunds'`).first()).covered_from, "2026-09-01");
  await runHistoryExtension(env, { nowMs: NOW + 15 * 60000, opts: { fetchImpl: shop.fetchImpl } });
  assert.equal((await env.DB.prepare(`SELECT covered_from FROM feed_coverage WHERE store = 'hc' AND feed = 'refunds'`).first()).covered_from, "2026-07-01");
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM refunds WHERE store = 'hc'`).first()).n, 1);
  assert.match(shop.queries[1], /^updated_at:>='2026-06-30T04:00:00\.000Z' updated_at:<'2026-08-31T02:00:00\.000Z'$/);
  assert.equal((await evs(env.DB, "orders.history_extended")).length, 1);
  assert.equal((await evs(env.DB, "refunds.history_extended")).length, 1);
  const done = await runHistoryExtension(env, { nowMs: NOW + 30 * 60000, opts: { fetchImpl: shop.fetchImpl } });
  assert.equal(done.find((x) => x.store === "hc").done, true);
});

test("history extension: without read_all_orders it only reaches the 58-day window (Shopify hides older orders), and says why", async () => {
  _resetTokenCacheForTests();
  const env = { DB: makeD1(), ...ENV_SHOP };
  await historyFixture(env.DB);
  assert.equal(extensionTarget(NOW, "America/New_York", false), "2026-08-17");
  assert.equal(extensionTarget(NOW, "America/New_York", true), "2026-07-01");
  const shop = fakeShop({ scopes: ["read_orders"], orders: [node(1004, "2026-08-15T18:00:00Z", 56.95), node(1010, "2026-08-20T18:00:00Z", 60)] });
  await runHistoryExtension(env, { nowMs: NOW, opts: { fetchImpl: shop.fetchImpl } });
  assert.equal((await env.DB.prepare(`SELECT covered_from FROM order_coverage WHERE store = 'hc'`).first()).covered_from, "2026-08-17");
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM orders WHERE store = 'hc'`).first()).n, 1);
  const ev = await evs(env.DB, "orders.history_extended");
  assert.match(ev[0].summary, /read_all_orders not granted/);
  // A day before the new start stays open, with the reason.
  await ensureFeeds(env.DB);
  const row = await computeStoreDay(env.DB, "hc", "2026-08-15", { nowMs: NOW });
  assert.equal(row.profit, null);
  assert.match(row.notes.missing_why.order_history, /only covers 2026-08-17 onwards/);
});

test("history extension: nothing happens before the first pass has finished", async () => {
  _resetTokenCacheForTests();
  const env = { DB: makeD1(), ...ENV_SHOP };
  const shop = fakeShop({ scopes: ["read_all_orders"], orders: [] });
  const r = await runHistoryExtension(env, { nowMs: NOW, opts: { fetchImpl: shop.fetchImpl } });
  assert.equal(r.find((x) => x.store === "hc").reason, "first pass not finished");
  assert.equal(shop.queries.length, 0);
});

test("dashboard: the P&L status says COGS sheet vs COGS est., marks sheet ad spend, and the script still parses", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const block = html.slice(html.indexOf("function rowStatus"), html.indexOf("function byStore"));
  assert.match(block, /COGS sheet/);
  assert.match(block, /COGS est\./);
  assert.match(block, /ads sheet/);
  // No escaped apostrophes inside single-quoted strings (one blanked the page before).
  for (const s of block.match(/'(?:[^'\\\n]|\\.)*'/g) || []) assert.ok(!/\\'/.test(s), `escaped apostrophe in ${s}`);
  assert.match(html, /r\.ads_sheet\?'<span class="warn-t" title="From the P&amp;L sheet/);
  assert.doesNotThrow(() => new Function(html.match(/<script>([\s\S]*)<\/script>/)[1]));
});

test("P&L history days say where their numbers came from (sheet COGS, sheet ads, why a day is open)", async () => {
  const { pnlHistory } = await import("../src/lib/pnl.js");
  const DB = makeD1();
  for (const id of LIVE_STORE_IDS) await DB.prepare(`INSERT INTO order_coverage (store, covered_from, completed_at) VALUES (?, '2026-09-25', 't')`).bind(id).run();
  await DB.prepare(`INSERT INTO pnl_days (store, day, revenue, cogs_source, notes, status, complete, updated_at) VALUES ('hc', '2026-09-25', 100, 'sheet (KFB ledger, EUR at 1.19)', ?, 'partial', 0, 't')`)
    .bind(JSON.stringify({ ads_source: "sheet", missing: ["refunds"], missing_why: { refunds: "refunds only read from 2026-09-26" } })).run();
  const h = await pnlHistory(DB, "hc", { nowMs: NOW });
  const d = h.days.find((x) => x.day === "2026-09-25");
  assert.deepEqual(d.cogs_sources, ["sheet (KFB ledger, EUR at 1.19)"]);
  assert.equal(d.ads_sheet, true);
  assert.equal(d.open_why.refunds, "refunds only read from 2026-09-26");
});

test("sheets: a read too big for one run is stored over several; the workbook only counts as fresh once every row is in", async () => {
  const { storeRead, readWorkbook, workbooks } = await import("../src/agents/pnl/sheets.js");
  const env = baseEnv();
  await connectGoogle(env);
  const books = { [HC]: book("Holt & Crane P&L", { SEP: monthTab(2026, 9, {}), OCT: monthTab(2026, 10, {}), SETUP: setupTab() }) };
  const g = fakeGoogle(books);
  const wb = workbooks().find((w) => w.store === "hc");
  const read = await readWorkbook(env, wb, { token: "g", fetchImpl: g.fetchImpl, nowMs: NOW });
  assert.equal(read.full, true);
  const first = await storeRead(env.DB, wb, read, NOW, { rows: 40 });
  assert.equal(first.complete, false);
  let w = await env.DB.prepare(`SELECT last_ok_at, full_read_at FROM sheet_workbooks WHERE store = 'hc'`).first();
  assert.deepEqual([w.last_ok_at, w.full_read_at], [null, null], "half-stored: not fresh, not a full read");
  const second = await storeRead(env.DB, wb, read, NOW + 1000, { rows: 40 });
  assert.equal(second.complete, true);
  w = await env.DB.prepare(`SELECT last_ok_at, full_read_at FROM sheet_workbooks WHERE store = 'hc'`).first();
  assert.ok(w.last_ok_at && w.full_read_at);
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM sheet_pnl_days WHERE store = 'hc'`).first()).n, 61);
  // Nothing changed in the sheet: a re-read rewrites nothing.
  const third = await storeRead(env.DB, wb, read, NOW + 2000, { rows: 0 });
  assert.deepEqual([third.complete, third.changed.length], [true, 0]);
});


/* ---------------- review fixes (2026-10-14) ---------------- */

test("history extension: WITHOUT read_all_orders refund coverage is not moved back (those days stay open: refunds unprovable); the scope is re-checked daily and the extension resumes once granted", async () => {
  _resetTokenCacheForTests();
  const env = { DB: makeD1(), ...ENV_SHOP };
  await historyFixture(env.DB);
  const scopes = ["read_orders"];
  const shop = fakeShop({ scopes, orders: [node(1004, "2026-08-15T18:00:00Z", 56.95), node(1010, "2026-08-20T18:00:00Z", 60)] });
  await runHistoryExtension(env, { nowMs: NOW, opts: { fetchImpl: shop.fetchImpl } });
  await runHistoryExtension(env, { nowMs: NOW + 15 * 60000, opts: { fetchImpl: shop.fetchImpl } });
  assert.equal((await env.DB.prepare(`SELECT covered_from FROM order_coverage WHERE store = 'hc'`).first()).covered_from, "2026-08-17");
  assert.equal((await env.DB.prepare(`SELECT covered_from FROM feed_coverage WHERE store = 'hc' AND feed = 'refunds'`).first()).covered_from, "2026-09-01", "refunds NOT moved back");
  assert.ok(!shop.queries.some((q) => /^updated_at/.test(q)), "no refund read that could not be proven anyway");
  await ensureFeeds(env.DB);
  await env.DB.prepare(`INSERT INTO job_runs (job, last_run_at) VALUES ('refunds.hc', ?)`).bind(iso(NOW)).run();
  const row = await computeStoreDay(env.DB, "hc", "2026-08-20", { nowMs: NOW });
  assert.equal(row.refunds, null);
  assert.match(row.notes.missing_why.refunds, /refunds unprovable before 2026-09-01/);
  // Same day: no second scope check.
  const n = shop.queries.length;
  const again = await runHistoryExtension(env, { nowMs: NOW + 2 * 3600000, opts: { fetchImpl: shop.fetchImpl } });
  assert.equal(again.find((x) => x.store === "hc").done, true);
  // Reilly grants read_all_orders; a day later the brain notices and reads back to Jul 1.
  scopes.push("read_all_orders");
  for (let i = 0; i < 3; i++) await runHistoryExtension(env, { nowMs: NOW + 25 * 3600000 + i * 15 * 60000, opts: { fetchImpl: shop.fetchImpl } });
  assert.equal((await env.DB.prepare(`SELECT covered_from FROM order_coverage WHERE store = 'hc'`).first()).covered_from, "2026-07-01");
  assert.equal((await env.DB.prepare(`SELECT covered_from FROM feed_coverage WHERE store = 'hc' AND feed = 'refunds'`).first()).covered_from, "2026-07-01");
  assert.ok(shop.queries.length > n);
});

test("sheets writer: fail-closed day basis, settled ads, and no $0 services before the media buyer started", async () => {
  const { brainValue } = await import("../src/agents/pnl/sheets.js");
  const DB = makeD1();
  const tz = "America/New_York";
  const pnl = { revenue: 100, orders: 2, ads: 50, guy_fee: 5, fees: 3, notes: "{}", cogs_basis: "{}", cogs_source: "estimate" };
  await DB.prepare(`INSERT INTO funnel_days (store, day, sessions, partial, fetched_at) VALUES ('hc', '2026-10-01', 500, 0, 't')`).run();
  await DB.prepare(`INSERT INTO ad_spend_days (store, day, cost, clicks, impressions, conv_value, fetched_at, source) VALUES ('hc', '2026-10-12', 50, 70, 0, 0, 't', 'api')`).run();
  const noTz = { revenue_tz: null, services_ended: null };
  for (const f of ["revenue", "orders", "fee", "sessions", "cog_eur"]) {
    const v = await brainValue(DB, "hc", "2026-10-01", f, { pnl, setup: noTz, tz, today: "2026-10-14" });
    assert.match(v.skip || "", /day basis is not proven/, `${f} fails closed without proof`);
  }
  assert.match((await brainValue(DB, "hc", "2026-10-01", "sessions", { pnl, setup: noTz, tz, today: "2026-10-14", dayOk: false, dayWhy: "Shopify says America/Chicago, stores.js says America/New_York" })).skip, /America\/Chicago/);
  // A SETUP label alone neither allows nor blocks: only the proof does.
  assert.equal((await brainValue(DB, "hc", "2026-10-01", "sessions", { pnl, setup: { revenue_tz: "America/Chicago" }, tz, today: "2026-10-14", dayOk: true })).value, 500);
  // Ad numbers wait 3 days.
  for (const f of ["adspend", "clicks", "services"]) {
    assert.match((await brainValue(DB, "hc", "2026-10-12", f, { pnl, setup: noTz, tz, today: "2026-10-14" })).skip, /settle/, f);
  }
  assert.equal((await brainValue(DB, "hc", "2026-10-11", "adspend", { pnl, setup: noTz, tz, today: "2026-10-14" })).value, 50);
  // SERVICES before 2026-09-07 stays blank (never a $0 claim).
  assert.match((await brainValue(DB, "hc", "2026-09-06", "services", { pnl: { ...pnl, guy_fee: 0 }, setup: noTz, tz, today: "2026-10-14" })).skip, /before the media buyer started/);
  assert.equal((await brainValue(DB, "hc", "2026-09-07", "services", { pnl, setup: noTz, tz, today: "2026-10-14" })).value, 5);
});

test("sheets: the once-a-day read covers every month tab; rows stay fresh until the next morning (26 h)", async () => {
  const { readWorkbook, storeRead, workbooks } = await import("../src/agents/pnl/sheets.js");
  const env = baseEnv();
  const books = { [HC]: book("Holt & Crane P&L", { AUG: monthTab(2026, 8, { "2026-08-20": { revenue: 60, orders: 1 } }), SEP: monthTab(2026, 9, {}), OCT: monthTab(2026, 10, {}), SETUP: setupTab() }) };
  const g = fakeGoogle(books);
  const wb = workbooks().find((w) => w.store === "hc");
  for (const t of [NOW, NOW + 24 * 3600000]) {
    const read = await readWorkbook(env, wb, { token: "g", fetchImpl: g.fetchImpl, nowMs: t });
    assert.deepEqual(read.months.map((m) => m.tab), ["AUG", "SEP", "OCT"], "every month tab, every (daily) run");
    await storeRead(env.DB, wb, read, t, { rows: 500 });
  }
  assert.equal((await env.DB.prepare(`SELECT seen_at FROM sheet_pnl_days WHERE store = 'hc' AND day = '2026-08-20'`).first()).seen_at, iso(NOW + 24 * 3600000));
  const { SHEET_MAX_AGE_MIN } = await import("../src/lib/pnl.js");
  assert.equal(SHEET_MAX_AGE_MIN, 26 * 60);
});

test("sheets writer: intended cells are recorded as pending BEFORE the write; a failed write call says its outcome is unknown; a failed re-read marks them unverified", async () => {
  const a = await writerFixture();
  const g1 = fakeGoogle(a.books, { failUpdate: true });
  const r1 = await runSheets(a.env, { nowMs: NOW, fetchImpl: g1.fetchImpl });
  assert.equal(r1.written.hc.phase, "write_unknown");
  assert.equal((await a.DB.prepare(`SELECT COUNT(*) AS n FROM sheet_writes WHERE status = 'pending'`).first()).n, 7, "the record survives the failure");
  const e1 = (await evs(a.DB, "error.sheet_write"))[0];
  assert.match(e1.summary, /may or may not have landed/);
  assert.doesNotMatch(e1.summary, /nothing/i, "never claims nothing changed once the write was sent");
  assert.equal((await sheetsState(a.env, { nowMs: NOW })).pending_writes, 7);

  const b = await writerFixture();
  const g2 = fakeGoogle(b.books, { failVerify: true });
  await runSheets(b.env, { nowMs: NOW, fetchImpl: g2.fetchImpl });
  assert.equal(g2.log.updates.length, 7, "the write itself went through");
  assert.equal((await b.DB.prepare(`SELECT COUNT(*) AS n FROM sheet_writes WHERE status = 'unverified'`).first()).n, 7);
  assert.match((await evs(b.DB, "pnl.sheet_write_unverified"))[0].summary, /written but the confirming re-read failed/);

  // A failure before anything is sent (no backup bucket) does say nothing changed, and records nothing.
  const c = await writerFixture();
  delete c.env.BACKUPS;
  await runSheets(c.env, { nowMs: NOW, fetchImpl: fakeGoogle(c.books).fetchImpl });
  assert.match((await evs(c.DB, "error.sheet_write"))[0].summary, /before anything was sent, nothing in the sheet changed/);
  assert.equal((await c.DB.prepare(`SELECT COUNT(*) AS n FROM sheet_writes`).first()).n, 0);
});

test("P&L slot: one outbound-call budget shared by every job; the sheets and ads history stop cleanly when it runs out", async () => {
  const { callBudget } = await import("../src/lib/callBudget.js");
  const { PNL_SLOT_CALLS } = await import("../src/agents/pnl/index.js");
  assert.ok(PNL_SLOT_CALLS < 50, "inside the Worker's 50 subrequests");
  const { env, books } = await writerFixture();
  const g = fakeGoogle(books);
  const calls = callBudget(5, g.fetchImpl);
  const r = await runSheets(env, { nowMs: NOW, fetchImpl: g.fetchImpl, calls });
  assert.ok(calls.used <= 5);
  assert.deepEqual(r.read, ["hc"], "one workbook read (token + 3 calls), then a clean stop");
  assert.ok(r.skipped.some((x) => /call budget/.test(x)));
  assert.equal(r.unreachable.length, 0, "running out of budget is not 'unreachable'");
  assert.equal(r.written.hc, "call budget for this run used up");
  assert.equal(g.log.updates.length, 0);
  // The whole slot never goes past its budget, whatever the jobs want.
  const { runPnlExtras } = await import("../src/agents/pnl/index.js");
  let n = 0;
  const counting = async (url, init) => { n++; return g.fetchImpl(url, init); };
  const out = await runPnlExtras(env, { nowMs: NOW + 2 * 3600000, fetchImpl: counting });
  assert.ok(n <= PNL_SLOT_CALLS && out.calls_used <= PNL_SLOT_CALLS);
});

test("sheets writer: planning is bounded per run (days and cells), the rest next run", async () => {
  const { planStore, readWorkbook, workbooks } = await import("../src/agents/pnl/sheets.js");
  const env = baseEnv();
  const days = {};
  for (let d = 1; d <= 9; d++) {
    const day = `2026-10-0${d}`;
    days[day] = {};
    await closedDay(env.DB, "hc", day, { revenue: 10, orders: 1, ads: 5, guy_fee: 0.5, fees: 0.3 });
  }
  const books = { [HC]: book("Holt & Crane P&L", { OCT: monthTab(2026, 10, days), SETUP: setupTab() }) };
  const wb = workbooks().find((w) => w.store === "hc");
  const read = await readWorkbook(env, wb, { token: "g", fetchImpl: fakeGoogle(books).fetchImpl, nowMs: NOW });
  const p = await planStore(env.DB, wb, read, { nowMs: NOW, maxDays: 3 });
  assert.deepEqual([...new Set(p.plan.map((x) => x.day))], ["2026-10-09", "2026-10-08", "2026-10-07"], "most recent gaps first");
  assert.ok(p.skipped["more days next run (per-run limit)"] > 0);
});

test("ads history: a day the hourly pull already had is re-read, and a changed figure is logged as a restatement", async () => {
  const env = baseEnv();
  await connectGoogle(env);
  await env.DB.prepare(`INSERT INTO ad_spend_days (store, day, cost, clicks, impressions, conv_value, currency, account_tz, fetched_at, source) VALUES ('hc', '2026-10-05', 300, 4, 0, 0, 'USD', 'America/Chicago', ?, 'api')`).bind(iso(NOW - 86400000)).run();
  const fetchImpl = async (url, init) => {
    if (url === "https://oauth2.googleapis.com/token") return j({ access_token: "g", expires_in: 3600 });
    const q = JSON.parse(init.body).query;
    if (!/segments\.date/.test(q)) return j([{ results: [{ customer: { timeZone: "America/Chicago", currencyCode: "USD" } }] }]);
    const cid = url.match(/customers\/(\d+)\//)[1];
    const [, from, to] = q.match(/BETWEEN '([\d-]+)' AND '([\d-]+)'/);
    const rows = [];
    if (cid === "7108143649") for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) rows.push({ segments: { date: d }, metrics: { costMicros: d === "2026-10-05" ? "305400000" : "1000000", clicks: "1", impressions: "1", conversionsValue: 0 } });
    return j([{ results: rows }]);
  };
  for (let i = 0; i < 3; i++) await runAdsHistory(env, { nowMs: NOW + i * 3600000, fetchImpl });
  assert.equal((await env.DB.prepare(`SELECT cost FROM ad_spend_days WHERE store = 'hc' AND day = '2026-10-05'`).first()).cost, 305.4);
  const ev = (await evs(env.DB, "ads.restated")).filter((e) => e.store === "hc");
  assert.equal(ev.length, 1);
  assert.match(ev[0].summary, /2026-10-05 300\.00 → 305\.40/);
});


/* ---------------- once a day, in the morning (decision pnl.sheets_schedule) ---------------- */

const etMs = (day, hh, mm = 36) => Date.parse(`${day}T${String(hh + 4).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`); // EDT = UTC-4

test("schedule: once a day from 07:00 New York; retried each slot until noon while yesterday isn't closed; a missed morning still runs once that day", async () => {
  const { sheetsDue, runSheetsMorning, sheetsSchedule } = await import("../src/agents/pnl/sheets.js");
  const DB = makeD1();
  const env = { DB };
  assert.deepEqual(await sheetsDue(DB, etMs("2026-10-15", 6, 36)), { due: false, why: "before 07:00 New York" });
  assert.equal((await sheetsSchedule(DB, etMs("2026-10-15", 6, 36))).next_run, "2026-10-15T11:00:00.000Z", "07:00 EDT");
  // 07:36: due. Google isn't connected here, so yesterday can't be filled: not done.
  const r1 = await runSheetsMorning(env, { nowMs: etMs("2026-10-15", 7) });
  assert.equal(r1.ran, true);
  assert.equal(r1.waiting_on.length, LIVE_STORE_IDS.length + 1, "every store workbook and the Ecom P&L");
  assert.equal(r1.filled_yesterday, false);
  assert.equal((await sheetsDue(DB, etMs("2026-10-15", 8))).why, "retry: yesterday was not closed yet");
  await runSheetsMorning(env, { nowMs: etMs("2026-10-15", 8) });
  assert.deepEqual(await sheetsDue(DB, etMs("2026-10-15", 12)), { due: false, why: "retries stop at noon; next run tomorrow 07:00" });
  assert.equal((await runSheetsMorning(env, { nowMs: etMs("2026-10-15", 13) })).ran, false);
  assert.equal((await sheetsSchedule(DB, etMs("2026-10-15", 13))).next_run, "2026-10-16T11:00:00.000Z");
  // A morning missed entirely (nothing ran before noon) still gets ONE run that day.
  assert.equal((await sheetsDue(DB, etMs("2026-10-16", 15))).due, true);
  await runSheetsMorning(env, { nowMs: etMs("2026-10-16", 15) });
  assert.equal((await sheetsDue(DB, etMs("2026-10-16", 16))).due, false);
  // Done for the day → not due again until tomorrow.
  await DB.prepare(`INSERT INTO job_runs (job, last_run_at, last_result) VALUES ('pnl.sheets.done', ?, 'ran; yesterday filled')`).bind(iso(etMs("2026-10-17", 7))).run();
  assert.equal((await sheetsDue(DB, etMs("2026-10-17", 8))).why, "done for today");
  assert.equal((await sheetsDue(DB, etMs("2026-10-18", 7))).due, true);
  const st = await sheetsSchedule(DB, etMs("2026-10-17", 9));
  assert.equal(st.decision, "pnl.sheets_schedule");
  assert.ok(st.last_run_at && st.last_done_at);
  // Reilly's words, verbatim.
  const seed = SEED_DECISIONS.find((x) => x.topic === "pnl.sheets_schedule");
  assert.equal(seed.words, "P&L sheets only have to update once per day, in the monring, it should fill in yesterdays P&L. does not need to be hourly for the google sheets");
  assert.equal(seed.at, "2026-10-14T23:03:00Z");
  assert.equal(seed.source, "chat 2026-10-14");
});

const ECOM = "1xL1Nbv0I1rztGx_a--1LJPg_YnjrdRkR04oLbIHDFw4";
async function morningFixture(envExtra = {}) {
  const env = baseEnv(envExtra);
  await connectGoogle(env);
  const books = {};
  for (const id of LIVE_STORE_IDS) {
    books[STORES[id].pnlSheetId] = book(`${STORES[id].name} P&L`, { OCT: monthTab(2026, 10, {}), SETUP: setupTab({ store: `${STORES[id].name} (${STORES[id].domain})` }) });
    await closedDay(env.DB, id, "2026-10-14", { revenue: 0, orders: 0, ads: 10, guy_fee: 1, fees: 0 });
  }
  books[ECOM] = book("Ecom P&L", {
    OCT: monthTab(2026, 10, {}, "ALL STORES"),
    SETUP: setupTab().map((r) => (r[0] && r[0].f === "Store" ? [cell("Scope"), cell("ALL STORES — the three stores summed day by day.")] : r)),
  });
  return { env, books };
}

test("schedule: 'filled' is recorded only when every workbook's yesterday cells were written AND verified (stores first, the Ecom sum at the next slot)", async () => {
  const { runSheetsMorning, sheetsDue } = await import("../src/agents/pnl/sheets.js");
  const { env, books } = await morningFixture();
  const g = fakeGoogle(books);
  const r1 = await runSheetsMorning(env, { nowMs: etMs("2026-10-15", 7), fetchImpl: g.fetchImpl });
  assert.equal(r1.filled_yesterday, false);
  assert.deepEqual(r1.waiting_on.map((w) => w.store), ["all"]);
  assert.match(r1.waiting_on[0].why, /Ecom row is summed next slot/);
  // Yesterday's ad spend and services went into each store sheet (no 3-day wait for yesterday).
  for (const id of LIVE_STORE_IDS) {
    assert.ok(g.log.updates.some((u) => u.id === STORES[id].pnlSheetId && u.range === "'OCT'!D15" && u.value === 10));
    assert.ok(g.log.updates.some((u) => u.id === STORES[id].pnlSheetId && u.range === "'OCT'!E15" && u.value === 1));
  }
  assert.match((await env.DB.prepare(`SELECT last_result FROM job_runs WHERE job = 'pnl.sheets.morning'`).first()).last_result, /^retrying until noon: all:/);
  const r2 = await runSheetsMorning(env, { nowMs: etMs("2026-10-15", 8), fetchImpl: g.fetchImpl });
  assert.equal(r2.filled_yesterday, true);
  assert.ok(g.log.updates.some((u) => u.id === ECOM && u.range === "'OCT'!D15" && u.value === 30), "Ecom = 10 + 10 + 10");
  assert.equal((await sheetsDue(env.DB, etMs("2026-10-15", 9))).why, "done for today");
  assert.match((await env.DB.prepare(`SELECT last_result FROM job_runs WHERE job = 'pnl.sheets.done'`).first()).last_result, /^filled: /);
});

test("schedule: never 'filled' when writes fail, the kill switch is on or yesterday isn't closed; after noon it records 'not filled' with the reason", async () => {
  const { runSheetsMorning } = await import("../src/agents/pnl/sheets.js");
  const last = async (DB, job) => (await DB.prepare(`SELECT last_result FROM job_runs WHERE job = ?`).bind(job).first()) || {};
  // Write calls fail.
  const a = await morningFixture();
  const r = await runSheetsMorning(a.env, { nowMs: etMs("2026-10-15", 7), fetchImpl: fakeGoogle(a.books, { failUpdate: true }).fetchImpl });
  assert.equal(r.filled_yesterday, false);
  assert.match(r.waiting_on.find((w) => w.store === "hc").why, /write failed/);
  assert.equal((await last(a.env.DB, "pnl.sheets.done")).last_result, undefined);
  // Still failing at the 11:36 retry, then the noon slot records "not filled".
  await runSheetsMorning(a.env, { nowMs: etMs("2026-10-15", 11), fetchImpl: fakeGoogle(a.books, { failUpdate: true }).fetchImpl });
  await runSheetsMorning(a.env, { nowMs: etMs("2026-10-15", 12), fetchImpl: fakeGoogle(a.books).fetchImpl });
  assert.match((await last(a.env.DB, "pnl.sheets.morning")).last_result, /^not filled: /);
  assert.equal((await last(a.env.DB, "pnl.sheets.done")).last_result, undefined, "never 'filled'");
  // Kill switch.
  const b = await morningFixture({ SHEETS_WRITE: "off" });
  const rb = await runSheetsMorning(b.env, { nowMs: etMs("2026-10-15", 7), fetchImpl: fakeGoogle(b.books).fetchImpl });
  assert.equal(rb.filled_yesterday, false);
  assert.ok(rb.waiting_on.every((w) => /kill switch/.test(w.why)));
  // Yesterday not closed in the brain.
  const c = await morningFixture();
  await c.env.DB.prepare(`UPDATE pnl_days SET complete = 0 WHERE store = 'aub'`).run();
  const rc = await runSheetsMorning(c.env, { nowMs: etMs("2026-10-15", 7), fetchImpl: fakeGoogle(c.books).fetchImpl });
  assert.match(rc.waiting_on.find((w) => w.store === "aub").why, /2026-10-14 not closed by the brain yet/);
  // A missed morning, single run after noon, failing: "not filled" straight away.
  const d = await morningFixture();
  await runSheetsMorning(d.env, { nowMs: etMs("2026-10-15", 14), fetchImpl: fakeGoogle(d.books, { failUpdate: true }).fetchImpl });
  assert.match((await last(d.env.DB, "pnl.sheets.morning")).last_result, /^not filled: /);
});

test("schedule: two runs at the same moment — one atomic claim, only one goes ahead", async () => {
  const { runSheetsMorning, claimMorning } = await import("../src/agents/pnl/sheets.js");
  const { env, books } = await morningFixture();
  const g = fakeGoogle(books);
  const t = etMs("2026-10-15", 7);
  const [x, y] = await Promise.all([runSheetsMorning(env, { nowMs: t, fetchImpl: g.fetchImpl }), runSheetsMorning(env, { nowMs: t, fetchImpl: g.fetchImpl })]);
  assert.equal([x, y].filter((r) => r.ran).length, 1);
  assert.match([x, y].find((r) => !r.ran).reason, /another run holds this slot|morning run/);
  // The claim itself: first wins, the second at the same instant gets nothing.
  const DB = makeD1();
  assert.equal(await claimMorning(DB, t, "a"), true);
  assert.equal(await claimMorning(DB, t, "b"), false);
  assert.equal(await claimMorning(DB, t + 31 * 60000, "c"), true);
});

test("planning: yesterday is planned first and never crowded out by older gaps; days with only permanent skips don't use up the cap", async () => {
  const { planStore, readWorkbook, workbooks } = await import("../src/agents/pnl/sheets.js");
  const env = baseEnv();
  const days = {};
  // Sep 1-12: closed, with blank cells. Sep 1-5 only have blanks the rules keep blank.
  for (let d = 1; d <= 12; d++) {
    const day = `2026-09-${String(d).padStart(2, "0")}`;
    days[day] = d <= 5 ? { revenue: 10, adspend: 5, services: 0.5, fee: 0.3, orders: 1, clicks: 1, cog_eur: 1 } : {};
    await closedDay(env.DB, "hc", day, { revenue: 10, orders: 1, ads: 5, guy_fee: d <= 5 ? 0 : 0.5, fees: 0.3 });
  }
  await closedDay(env.DB, "hc", "2026-10-13", { revenue: 50, orders: 1, ads: 300, guy_fee: 30, fees: 1.5 });
  const books = { [HC]: book("Holt & Crane P&L", { SEP: monthTab(2026, 9, days), OCT: monthTab(2026, 10, {}), SETUP: setupTab() }) };
  const wb = workbooks().find((w) => w.store === "hc");
  const read = await readWorkbook(env, wb, { token: "g", fetchImpl: fakeGoogle(books).fetchImpl, nowMs: NOW });
  const p = await planStore(env.DB, wb, read, { nowMs: NOW, maxDays: 3, maxCells: 2 });
  const planned = [...new Set(p.plan.map((x) => x.day))];
  assert.equal(planned[0], "2026-10-13", "yesterday first");
  assert.ok(p.plan.filter((x) => x.day === "2026-10-13").length >= 2, "all of yesterday's writable cells, outside the cell cap");
  assert.ok(!planned.some((d) => d <= "2026-09-05"), "Sep 1-5 (sessions only, never written without the day basis) didn't count");
  assert.deepEqual(planned.slice(1), ["2026-09-12"], "older gaps newest first, within their own 2-cell cap (Sep 12: 2 cells)");
  assert.equal(p.yesterday.planned, p.plan.filter((x) => x.day === "2026-10-13").length);
});

test("corrections: a cell the brain wrote in the last 3 days is updated when the brain's value changed (ads restated) and the cell still holds the brain's value; a cell Reilly changed is never touched", async () => {
  const { env, DB, books } = await writerFixture();
  // Yesterday (Oct 13) closed: written this morning without the 3-day wait.
  await closedDay(DB, "hc", "2026-10-13", { revenue: 50, orders: 1, ads: 300, guy_fee: 30, fees: 1.5 });
  await DB.prepare(`INSERT INTO ad_spend_days (store, day, cost, clicks, impressions, conv_value, currency, account_tz, fetched_at, source) VALUES ('hc', '2026-10-13', 300, 400, 900, 0, 'USD', 'America/Chicago', ?, 'api')`).bind(iso(NOW)).run();
  const g = fakeGoogle(books);
  await runSheets(env, { nowMs: NOW, fetchImpl: g.fetchImpl });
  const at = (cell) => books[HC].tabs.OCT[Number(cell.slice(1)) - 1][cell.charCodeAt(0) - 65].raw;
  assert.equal(at("D14"), 300);
  assert.equal(at("E14"), 30);
  assert.equal(at("P14"), 400);
  // Google restates Oct 13; Reilly meanwhile types his own clicks over the brain's.
  await DB.prepare(`UPDATE pnl_days SET ads = 310, guy_fee = 31 WHERE store = 'hc' AND day = '2026-10-13'`).run();
  await DB.prepare(`UPDATE ad_spend_days SET cost = 310, clicks = 410 WHERE store = 'hc' AND day = '2026-10-13'`).run();
  books[HC].tabs.OCT[13][15] = cell("405", 405);
  const next = etMs("2026-10-15", 7);
  await runSheets(env, { nowMs: next, fetchImpl: g.fetchImpl });
  assert.equal(at("D14"), 310, "ad spend corrected");
  assert.equal(at("E14"), 31, "services corrected");
  assert.equal(at("P14"), 405, "Reilly's clicks stay");
  const ev = await evs(DB, "pnl.sheet_corrected");
  assert.equal(ev.length, 1);
  assert.match(ev[0].summary, /2026-10-13 adspend 300 → 310/);
  assert.ok(JSON.parse(ev[0].data).backups.OCT, "backed up first");
  // Older than 3 days: never re-checked.
  await DB.prepare(`UPDATE pnl_days SET ads = 999 WHERE store = 'hc' AND day = '2026-10-11'`).run();
  await runSheets(env, { nowMs: etMs("2026-10-16", 7), fetchImpl: g.fetchImpl });
  assert.equal(at("D12"), 420.05);
});


test("planning: days whose blanks are all permanent skips never starve an older real gap (no evaluation cap on them)", async () => {
  const { planStore, readWorkbook, workbooks } = await import("../src/agents/pnl/sheets.js");
  const env = baseEnv();
  const days = {};
  // Sep 1: a real gap (ad spend blank). Sep 2 - Oct 12: closed, every cell filled except Sessions,
  // which stays blank without the day-basis proof (a permanent skip).
  const full = { revenue: 10, adspend: 5, services: 0.5, fee: 0.3, orders: 1, clicks: 1, cog_eur: 1 };
  for (let t = Date.parse("2026-09-01T12:00:00Z"); t <= Date.parse("2026-10-12T12:00:00Z"); t += 86400000) {
    const day = new Date(t).toISOString().slice(0, 10);
    days[day] = day === "2026-09-01" ? { revenue: 10, orders: 1, fee: 0.3, clicks: 1, cog_eur: 1 } : full;
    await closedDay(env.DB, "hc", day, { revenue: 10, orders: 1, ads: 5, guy_fee: 0.5, fees: 0.3 });
  }
  const sep = {}, oct = {};
  for (const [d, v] of Object.entries(days)) (d < "2026-10-01" ? sep : oct)[d] = v;
  const books = { [HC]: book("Holt & Crane P&L", { SEP: monthTab(2026, 9, sep), OCT: monthTab(2026, 10, oct), SETUP: setupTab() }) };
  const wb = workbooks().find((w) => w.store === "hc");
  const read = await readWorkbook(env, wb, { token: "g", fetchImpl: fakeGoogle(books).fetchImpl, nowMs: NOW });
  const p = await planStore(env.DB, wb, read, { nowMs: NOW, maxDays: 1 });
  assert.deepEqual(p.plan.map((x) => [x.day, x.field]), [["2026-09-01", "adspend"]], "41 newer permanent-skip days didn't use up anything");
});

test("verdict: a cell dropped because its row moved is NOT 'filled by hand' — retried, and 'not filled: row moved' after noon; only a typed value counts as filled by hand", async () => {
  const { yesterdayVerdict, writeCells, runSheetsMorning, workbooks } = await import("../src/agents/pnl/sheets.js");
  const wb = { store: "hc", name: "Holt & Crane P&L", sheetId: HC };
  const y = { day: "2026-10-14", in_sheet: true, closed: true, planned: 2, skipped: {} };
  const plan = [{ day: "2026-10-14", field: "adspend", cell: "D15", row_no: 15, value: 10 }, { day: "2026-10-14", field: "services", cell: "E15", row_no: 15, value: 1 }];
  assert.match(yesterdayVerdict(wb, y, plan, { written: [], drops: plan.map((p) => ({ ...p, reason: "row_moved" })) }).why, /^row moved/);
  assert.equal(yesterdayVerdict(wb, y, plan, { written: [], drops: plan.map((p) => ({ ...p, reason: "row_moved" })) }).ok, false);
  assert.equal(yesterdayVerdict(wb, y, plan, { written: [], drops: plan.map((p) => ({ ...p, reason: "now_formula" })) }).ok, false);
  assert.equal(yesterdayVerdict(wb, y, plan, { written: [], drops: [] }).ok, false, "unaccounted cells are not filled");
  const hand = yesterdayVerdict(wb, y, plan, { written: [{ ...plan[0], verified: true }], drops: [{ ...plan[1], reason: "filled_by_hand" }] });
  assert.deepEqual([hand.ok, /1 already filled by hand/.test(hand.why)], [true, true]);

  // writeCells says why each cell was dropped.
  const env = baseEnv();
  const books = { [HC]: book("Holt & Crane P&L", { OCT: monthTab(2026, 10, { "2026-10-14": { services: 1.5 } }), SETUP: setupTab() }) };
  const r = await writeCells(env, wb, [
    { tab: "OCT", day: "2026-10-14", row_no: 16, field: "adspend", cell: "D16", value: 10 },  // row 16 is Oct 15: moved
    { tab: "OCT", day: "2026-10-14", row_no: 15, field: "services", cell: "E15", value: 1 },  // Reilly typed 1.5
  ], { token: "g", fetchImpl: fakeGoogle(books).fetchImpl, nowMs: NOW });
  assert.deepEqual(r.drops.map((d) => d.reason), ["row_moved", "filled_by_hand"]);
  assert.equal(r.written.length, 0);

  // End to end: a row is inserted above yesterday's between the morning read and the write.
  const m = await morningFixture();
  let shifted = false;
  const insertRowAbove = (id, ranges) => {
    if (shifted || id !== HC || !ranges.some((x) => /^'OCT'!A15:Z15$/.test(x))) return;
    shifted = true;
    m.books[HC].tabs.OCT.splice(1, 0, [cell("NOTE")]); // everything below moves down one row
  };
  const g = fakeGoogle(m.books, { onGet: insertRowAbove });
  const r1 = await runSheetsMorning(m.env, { nowMs: etMs("2026-10-15", 7), fetchImpl: g.fetchImpl });
  assert.equal(shifted, true);
  assert.match(r1.waiting_on.find((w) => w.store === "hc").why, /^row moved/);
  assert.ok(!g.log.updates.some((u) => u.id === HC), "nothing written into the wrong row");
  // Not fixed by noon: the noon slot records "not filled" with the reason, never "filled".
  await runSheetsMorning(m.env, { nowMs: etMs("2026-10-15", 12), fetchImpl: g.fetchImpl });
  const last = (await m.env.DB.prepare(`SELECT last_result FROM job_runs WHERE job = 'pnl.sheets.morning'`).first()).last_result;
  assert.match(last, /^not filled: .*row moved/);
  assert.equal(await m.env.DB.prepare(`SELECT last_result FROM job_runs WHERE job = 'pnl.sheets.done'`).first(), null);
});


test("COG (Reilly 2026-10-15): an estimate goes in while KFB charges are missing, and is replaced by the actual KFB total when it lands, even weeks later; a cell Reilly changed is never touched", async () => {
  const { env, DB, books } = await writerFixture();
  const g = fakeGoogle(books);
  await runSheets(env, { nowMs: NOW, fetchImpl: g.fetchImpl });
  const at = (cell) => books[HC].tabs.OCT[Number(cell.slice(1)) - 1][cell.charCodeAt(0) - 65].raw;
  assert.equal(at("R12"), 25.21, "estimate: brain COGS $30 at the sheet's 1.19");
  // The brain never reads its own estimate back as the sheet's KFB figure (rule 9).
  const { sheetDay } = await import("../src/lib/pnl.js");
  await runSheets(env, { nowMs: NOW + 2 * 3600000, fetchImpl: g.fetchImpl });
  const sd = await sheetDay(DB, "hc", "2026-10-11", { nowMs: NOW + 2 * 3600000, revenue: 100, orders: 2 });
  assert.equal(sd.use.cog, false);
  assert.match(sd.why.cog, /brain wrote this cell itself/);
  // Ten days later every KFB charge for Oct 11 is in.
  await DB.prepare(`UPDATE pnl_days SET cogs = 33.5, cogs_actual = 33.5, cogs_est = 0, cogs_source = 'actual', cogs_basis = ? WHERE store = 'hc' AND day = '2026-10-11'`).bind(JSON.stringify({ orders_actual: 2 })).run();
  for (const [id, eur] of [["o1", 12.5], ["o2", 15]]) {
    await DB.prepare(`INSERT INTO cogs_matches (store, order_id, local_day, cost_eur, status, line_count, matched_at) VALUES ('hc', ?, '2026-10-11', ?, 'matched', 1, 't')`).bind(id, eur).run();
  }
  await runSheets(env, { nowMs: NOW + 10 * 86400000, fetchImpl: g.fetchImpl });
  assert.equal(at("R12"), 27.5, "the actual KFB total replaced the estimate");
  // Reilly's own edit wins over any later change.
  books[HC].tabs.OCT[11][17] = cell("€26.00", 26);
  await DB.prepare(`UPDATE cogs_matches SET cost_eur = 20 WHERE order_id = 'o1'`).run();
  await runSheets(env, { nowMs: NOW + 12 * 86400000, fetchImpl: g.fetchImpl });
  assert.equal(at("R12"), 26);
});

test("COG estimate still standing after 38 days is reported to Reilly (rule 5)", async () => {
  const { env, DB, books } = await writerFixture();
  const g = fakeGoogle(books);
  await runSheets(env, { nowMs: NOW, fetchImpl: g.fetchImpl });
  await runSheets(env, { nowMs: NOW + 40 * 86400000, fetchImpl: g.fetchImpl });
  const ev = await evs(DB, "pnl.sheet_cog_still_estimate");
  assert.equal(ev.length, 1);
  assert.match(ev[0].summary, /2026-10-11: COG is still the brain's estimate/);
});
