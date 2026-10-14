/**
 * Google Sheets: a thin client and the pure parsers for Reilly's P&L workbooks.
 *
 * Access: Reilly's own Google connection (src/lib/google.js). The `spreadsheets` scope is
 * part of the one consent he already gave ("P&L workbooks (Sheets Writer)"). No new secret.
 *
 * Layout (read from the four workbooks on 2026-10-14, coded by HEADER NAME, never position):
 *  - Tabs: SUMMARY, one tab per month named JUL, AUG, SEP, OCT (Marlowe has no JUL), SETUP.
 *  - Month tab row 1: [store name] | Revenue | COG | Adspend Google | SERVICES | EMPLOYEE |
 *    Transaction fee | Profit | ROAS | Profit % | COG % | CVR % | CPC | (blank) | Orders |
 *    Clicks | Sessions | COG (EUR). Then one row per day, column A a date ("10/01/2026").
 *  - COG (USD), Profit, ROAS, the % columns and CPC are formulas. Below the days: a totals row
 *    (label "JULY 2026", or on OCT a DATE cell, so a SUM formula in Revenue marks it), then
 *    month-level boxes (EMPLOYEE COST, TOTAL AMOUNT REFUND, CHARGEBACKS, OTHER COSTS). There is
 *    NO per-day refunds cell: refunds are a month total typed by hand, so the brain never writes them.
 *  - SETUP: column A labels, column B values. "EUR → USD rate" in B (1.19), source notes per
 *    column, and free-text notes naming days whose numbers are estimates.
 *
 * Values come in two renders: FORMATTED_VALUE ("$1,045.28", "-$261.05", "\-$0.02", "€313.03")
 * and FORMULA ("=R2*SETUP!$B$5" for a formula cell, the raw value otherwise). Blank = null, never 0.
 */

export const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

export class SheetsError extends Error {
  constructor(message, code, status = null) {
    super(message);
    this.name = "SheetsError";
    this.code = code;
    this.status = status;
  }
}

/* ---------------- client ---------------- */

async function call(url, { token, fetchImpl = fetch, method = "GET", body = null }) {
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new SheetsError(`Google Sheets unreachable (network: ${String(err && err.message).slice(0, 80)})`, "UNREACHABLE");
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) {
    // Never echo the body in full: keep Google's short status/message only.
    const msg = json && json.error ? `${json.error.status || ""} ${String(json.error.message || "").slice(0, 120)}`.trim() : "";
    const code = res.status === 403 || res.status === 404 ? "UNREACHABLE" : "SHEETS_HTTP";
    throw new SheetsError(`Google Sheets HTTP ${res.status}${msg ? ` — ${msg}` : ""}`, code, res.status);
  }
  return json;
}

/** Workbook title and tab names. */
export async function sheetMeta(sheetId, opts) {
  const j = await call(`${SHEETS_API}/${encodeURIComponent(sheetId)}?fields=properties.title,sheets.properties(title,sheetId)`, opts);
  return { title: (j.properties && j.properties.title) || null, tabs: (j.sheets || []).map((s) => s.properties && s.properties.title).filter(Boolean) };
}

/** A1 range for a tab name (quotes doubled, as Sheets wants). */
export const a1 = (tab, range) => `'${String(tab).replace(/'/g, "''")}'!${range}`;

/** values:batchGet. render = FORMATTED_VALUE | FORMULA | UNFORMATTED_VALUE. Returns an array of row arrays per range. */
export async function batchGet(sheetId, ranges, render, opts) {
  const qs = new URLSearchParams({ valueRenderOption: render, majorDimension: "ROWS" });
  if (render !== "FORMATTED_VALUE") qs.set("dateTimeRenderOption", "SERIAL_NUMBER");
  for (const r of ranges) qs.append("ranges", r);
  const j = await call(`${SHEETS_API}/${encodeURIComponent(sheetId)}/values:batchGet?${qs}`, opts);
  return (j.valueRanges || []).map((v) => v.values || []);
}

/** values:batchUpdate with USER_ENTERED (Sheets parses numbers and keeps the cell's format). */
export async function batchUpdate(sheetId, data, opts) {
  return call(`${SHEETS_API}/${encodeURIComponent(sheetId)}/values:batchUpdate`, {
    ...opts, method: "POST", body: { valueInputOption: "USER_ENTERED", data },
  });
}

/* ---------------- parsing values ---------------- */

const isBlank = (v) => v == null || (typeof v === "string" && v.trim() === "");

/**
 * "$1,045.28" → 1045.28 · "-$261.05" / "\-$261.05" / "($261.05)" / "−261.05" → -261.05 ·
 * "€313.03" → 313.03 · 12 → 12 · "" / null → null · "#DIV/0!" / "n/a" → null (not a number is not 0).
 */
export function parseMoney(v) {
  if (isBlank(v)) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/\\/g, "").replace(/[−‒–—]/g, "-");
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$€£\s,]/g, "").replace(/^(USD|EUR)/i, "").replace(/(USD|EUR)$/i, "");
  if (s.startsWith("-")) { neg = !neg; s = s.slice(1); }
  if (s.startsWith("+")) s = s.slice(1);
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** A count cell ("13", "1,204", 13) → integer, blank → null. */
export function parseCount(v) {
  const n = parseMoney(v);
  return n == null ? null : Math.round(n);
}

/** Days since 1899-12-30 (Sheets serial) → YYYY-MM-DD. */
function serialDay(n) {
  const ms = Date.UTC(1899, 11, 30) + Math.round(n) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** "10/01/2026", "10/1/2026", "2026-10-01" or a serial number → "2026-10-01". Anything else → null. */
export function parseSheetDate(v) {
  if (isBlank(v)) return null;
  if (typeof v === "number") return v > 20000 && v < 80000 ? serialDay(v) : null;
  const s = String(v).trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return s;
  return null;
}

/* ---------------- month tabs ---------------- */

/**
 * Column headers → field keys. Matched on the normalised header text, so a moved or renamed
 * column ("Adspend Google" vs "Ad spend") still maps; an unknown header is ignored.
 */
const HEADER_RULES = [
  ["cog_eur", /^cogs? \(eur\)$|^cogs? eur$/],
  ["cog_usd", /^cogs?$|^cogs? \(usd\)$/],
  ["revenue", /^revenue$/],
  ["adspend", /^ad ?spend/],
  ["services", /^services/],
  ["employee", /^employee/],
  ["fee", /^transaction fees?$/],
  ["profit", /^profit$/],
  ["roas", /^roas$/],
  ["profit_pct", /^profit %$/],
  ["cog_pct", /^cogs? %$/],
  ["cvr", /^cvr %?$/],
  ["cpc", /^cpc$/],
  ["orders", /^orders$/],
  ["clicks", /^clicks$/],
  ["sessions", /^sessions$/],
];
export const MONEY_FIELDS = Object.freeze(["revenue", "cog_usd", "adspend", "services", "employee", "fee", "profit", "cog_eur"]);
export const COUNT_FIELDS = Object.freeze(["orders", "clicks", "sessions"]);
/** The only cells the brain may ever write into a store workbook (and only when blank). */
export const INPUT_FIELDS = Object.freeze(["revenue", "adspend", "services", "fee", "orders", "clicks", "sessions", "cog_eur"]);

const norm = (s) => String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");

/** Row 1 → { field: columnIndex }. Column A (index 0) is the date column whatever its header says. */
export function headerMap(row) {
  const cols = {};
  (row || []).forEach((h, i) => {
    if (i === 0) return;
    const t = norm(h);
    if (!t) return;
    for (const [field, re] of HEADER_RULES) {
      if (re.test(t) && cols[field] == null) { cols[field] = i; break; }
    }
  });
  return cols;
}

/** 0 → "A", 17 → "R", 26 → "AA". */
export function colLetter(i) {
  let n = i + 1, s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
/** "2026-10-14" → "OCT". */
export const monthAbbrev = (day) => MONTHS[Number(day.slice(5, 7)) - 1];

/** Which tab holds a month: "OCT", "Oct", "OCTOBER", "OCT 2026" all count. Null if none. */
export function tabForMonth(tabs, day) {
  const ab = monthAbbrev(day);
  const year = day.slice(0, 4);
  const cands = (tabs || []).filter((t) => {
    const u = String(t).trim().toUpperCase();
    return u.startsWith(ab) && !/SUMMARY|SETUP/.test(u) && (!/\d{4}/.test(u) || u.includes(year));
  });
  return cands[0] || null;
}

/** Month tabs only (not SUMMARY / SETUP / anything else). */
export const monthTabs = (tabs) => (tabs || []).filter((t) => MONTHS.some((m) => String(t).trim().toUpperCase().startsWith(m)));

/**
 * One month tab → its day rows. `formatted` and `formulas` are the two renders of the same
 * range starting at A1 (row arrays, trailing blanks dropped by Google).
 * Each day: { day, row_no, values: {field: number|null}, formulas: [fields], cells: {field: "B15"} }.
 * A row is a day row when column A is a date of the tab's month, Revenue is not a SUM (the OCT
 * totals row carries a date in A), and the date was not already seen.
 */
export function parseMonthTab(formatted, formulas) {
  const header = (formatted && formatted[0]) || [];
  const cols = headerMap(header);
  const missing = ["revenue"].filter((f) => cols[f] == null);
  const days = [];
  const seen = new Set();
  const rows = Math.max((formatted || []).length, (formulas || []).length);
  for (let r = 1; r < rows; r++) {
    const fr = (formatted && formatted[r]) || [];
    const fo = (formulas && formulas[r]) || [];
    const day = parseSheetDate(fr[0]) || parseSheetDate(fo[0]);
    if (!day || seen.has(day)) continue;
    const isFormula = (i) => typeof fo[i] === "string" && fo[i].trim().startsWith("=");
    if (cols.revenue != null && isFormula(cols.revenue) && /^=\s*SUM\(/i.test(String(fo[cols.revenue]).trim())) continue;
    seen.add(day);
    const values = {}, cells = {}, forms = [], raw = {};
    for (const [field, i] of Object.entries(cols)) {
      cells[field] = `${colLetter(i)}${r + 1}`;
      raw[field] = fo[i] == null ? (fr[i] == null ? null : fr[i]) : fo[i];
      if (isFormula(i)) forms.push(field);
      if (MONEY_FIELDS.includes(field)) values[field] = parseMoney(fr[i]);
      else if (COUNT_FIELDS.includes(field)) values[field] = parseCount(fr[i]);
    }
    days.push({ day, row_no: r + 1, values, formulas: forms, cells, raw });
  }
  // One month per tab: keep the month most rows belong to (a stray date elsewhere is not a day row).
  const count = {};
  for (const d of days) count[d.day.slice(0, 7)] = (count[d.day.slice(0, 7)] || 0) + 1;
  const month = Object.keys(count).sort((a, b) => count[b] - count[a])[0] || null;
  return { cols, missing, month, days: days.filter((d) => d.day.slice(0, 7) === month), lastCol: Math.max(0, ...Object.values(cols)) };
}

/** A cell the brain may write: an input field, blank in BOTH renders, not a formula. */
export function writableBlank(dayRow, field) {
  if (!INPUT_FIELDS.includes(field)) return false;
  if (!dayRow || !dayRow.cells || !dayRow.cells[field]) return false;
  if ((dayRow.formulas || []).includes(field)) return false;
  return dayRow.values[field] == null && !(dayRow.raw && dayRow.raw[field] != null && String(dayRow.raw[field]).trim() !== "");
}

/* ---------------- SETUP ---------------- */

const FULL_DATE = /\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g;
const SHORT_DATE = /\b(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g;

/** Every date named in a text: "2026-09-09" and "09-18" (year = `year`). Sorted, unique. */
export function datesIn(text, year) {
  const s = String(text || "");
  const out = new Set();
  for (const m of s.matchAll(FULL_DATE)) out.add(m[0]);
  for (const m of s.replace(FULL_DATE, " ").matchAll(SHORT_DATE)) out.add(`${year}-${m[1]}-${m[2]}`);
  return [...out].sort();
}

/** Which timezone a SETUP text names: CDT/CST/Central → Chicago, EDT/EST/Eastern → New York. */
export function tzHint(text) {
  const s = String(text || "");
  if (/\bC[DS]T\b|\bcentral\b/i.test(s)) return "America/Chicago";
  if (/\bE[DS]T\b|\beastern\b/i.test(s)) return "America/New_York";
  if (/\bP[DS]T\b|\bpacific\b/i.test(s)) return "America/Los_Angeles";
  return null;
}

const EST_WORDS = /estimat|\best\b|unbilled|not (?:yet )?(?:been )?(?:billed|invoiced)|partial day|had not closed/i;
const NOT_EST_WORDS = /fully invoiced|cleared|resolved|scorecard|came in at|reconciles exactly/i;

/**
 * The days SETUP says are estimates, per field: { cogs: [...], fees: [...], ads: [...] }.
 * Read sentence by sentence: a sentence counts when it names a day AND says estimated /
 * unbilled / partial, and does not say the estimate was cleared or resolved. The field comes
 * from its words (transaction fee → fees, ad spend / partial day → ads, COG / billed → cogs);
 * in the "ESTIMATED COGS" row every such sentence is about COGS. Errs towards "estimate":
 * a day wrongly marked only keeps the brain's own number, never a flattering one.
 */
export function estimatedDays(setupRows, year) {
  const out = { cogs: new Set(), fees: new Set(), ads: new Set() };
  for (const [label, text] of setupRows) {
    const lab = String(label || "");
    const cogsRow = /estimat/i.test(lab) && /cog/i.test(lab);
    const body = String(text || "");
    if (cogsRow && /^\W*cleared\b/i.test(body)) continue;
    const sentences = body.split(/(?<=[.!?])\s+(?=[A-Z*#(0-9])|\*\*|·/);
    for (const s of sentences) {
      if (!EST_WORDS.test(s) || NOT_EST_WORDS.test(s)) continue;
      const days = datesIn(s, year);
      if (!days.length) continue;
      let field = null;
      if (/transaction fee|\bfees?\b/i.test(s)) field = "fees";
      else if (/ad ?spend|partial day|google ads|had not closed/i.test(s)) field = "ads";
      else if (cogsRow || /\bcogs?\b|billed|invoiced|kungfubuy|supplier/i.test(s)) field = "cogs";
      if (!field && /services/i.test(lab)) continue;
      if (!field) field = "cogs";
      for (const d of days) out[field].add(d);
    }
  }
  return { cogs: [...out.cogs].sort(), fees: [...out.fees].sort(), ads: [...out.ads].sort() };
}

/**
 * SETUP rows ([label, text] from columns A and B) → the facts the brain uses.
 * Labels are matched loosely ("EUR → USD rate", "EUR->USD", "FX rate").
 */
export function parseSetup(rows, { year } = {}) {
  const pairs = (rows || []).map((r) => [String((r && r[0]) || "").trim(), (r && r[1]) == null ? "" : String(r[1])]);
  const find = (re) => { const p = pairs.find(([l]) => re.test(l)); return p ? p[1] : null; };
  const rateText = find(/eur.*usd|fx|exchange/i);
  const rate = parseMoney(rateText);
  const revenue = find(/^revenue/i);
  const services = find(/^services/i);
  const store = find(/^store$|^scope$/i);
  let servicesEnded = null;
  if (services && /\bENDED\b/.test(services)) {
    // "ENDED 2026-10-13/14 — ..." → 2026-10-13: the brain writes no SERVICES cell from that day on.
    const m = /\bENDED\b\D{0,12}(20\d{2}-\d{2}-\d{2})/.exec(services);
    servicesEnded = m ? m[1] : "all";
  }
  const y = year || String(new Date().getUTCFullYear());
  return {
    fx_rate: rate != null && rate > 0.5 && rate < 3 ? rate : null,
    store_text: store,
    revenue_text: revenue,
    revenue_tz: tzHint(revenue),
    services_text: services,
    services_ended: servicesEnded,
    estimated: estimatedDays(pairs.filter(([l, t]) => l || t), y),
  };
}
