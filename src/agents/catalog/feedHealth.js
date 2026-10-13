/**
 * cat.feed_health — Merchant Center Health (SHADOW, L0: reports only).
 *
 * Does: once a day per live store, reads the store's Merchant Center products through the
 *   Merchant API (products v1 `accounts/{id}/products`, scope "content" on Reilly's Google
 *   connection) and reports products that are DISAPPROVED or DEMOTED (limited), with Google's
 *   own issue descriptions and the countries affected. The old Content API for Shopping v2.1
 *   was retired by Google in 2026, so the Merchant API is used.
 * Inputs: Google connection (slot "google"), each store's Merchant Center id from env
 *   `GMC_MERCHANT_ID_<STORE>` (e.g. GMC_MERCHANT_ID_HC, a plain variable, not a secret) or the
 *   Core fact `merchant_center.merchant_id` for that store. No id → "not wired", never guessed.
 * Outputs: a `cat_runs` row (issues per product, worst first) and one digest event per store
 *   per day. Never edits the feed or Merchant Center.
 * Not built yet: account-level issues (spec: "account-level issues") and proposed fixes.
 */
import { getGoogleAccessToken } from "../../lib/google.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { STORES } from "../../config/stores.js";
import { saveRun } from "./common.js";

export const AGENT = "cat.feed_health";
export const MERCHANT_API = "https://merchantapi.googleapis.com/products/v1";
export const PAGE_SIZE = 500;
export const MAX_PAGES = 2; // ≤ 1,000 products per store per day keeps the tick's subrequests bounded

/** The store's Merchant Center id, or null. Digits only; anything else is ignored, not guessed. */
export async function merchantIdFor(env, storeId) {
  const fromEnv = env[`GMC_MERCHANT_ID_${String(storeId).toUpperCase()}`];
  const clean = (x) => { const d = String(x ?? "").replace(/[^0-9]/g, ""); return d.length >= 5 ? d : null; };
  if (clean(fromEnv)) return { id: clean(fromEnv), source: `env GMC_MERCHANT_ID_${storeId.toUpperCase()}` };
  const f = await env.DB.prepare(
    `SELECT value FROM core_facts WHERE live = 1 AND store = ? AND key = 'merchant_center.merchant_id' ORDER BY observed_at DESC, id DESC LIMIT 1`
  ).bind(storeId).first().catch(() => null);
  if (f) {
    let v = f.value; try { v = JSON.parse(v); } catch { /* text */ }
    const id = clean(v && typeof v === "object" ? v.id : v);
    if (id) return { id, source: "core:merchant_center.merchant_id" };
  }
  return null;
}

class NotWired extends Error { constructor(m) { super(m); this.code = "NOT_WIRED"; } }

/** Explain a Google error in words Reilly can act on; "not wired" when it's an access/setup gap. */
function googleError(status, body, merchantId) {
  const e = (body && body.error) || {};
  const reasons = JSON.stringify(e.details || []);
  if (status === 403 && /SERVICE_DISABLED|has not been used|is disabled/i.test(`${e.message} ${reasons}`)) {
    return new NotWired("Merchant API is not enabled on the Store Brain Google Cloud project");
  }
  if (status === 403 || status === 401) return new NotWired(`the connected Google account has no access to Merchant Center ${merchantId} (HTTP ${status})`);
  if (status === 404) return new NotWired(`Merchant Center account ${merchantId} not found (check the id)`);
  return new Error(`Merchant API HTTP ${status}${e.status ? ` ${e.status}` : ""}`);
}

/** Merchant API product → our finding (null when it has no disapproval or demotion). */
export function findingFromProduct(p) {
  const st = p.productStatus || {};
  const issues = (st.itemLevelIssues || []).filter((i) => i.severity === "DISAPPROVED" || i.severity === "DEMOTED");
  const disapprovedIn = [...new Set((st.destinationStatuses || []).flatMap((d) => d.disapprovedCountries || []))];
  if (!issues.length && !disapprovedIn.length) return null;
  const attrs = p.productAttributes || p.attributes || {};
  return {
    offer_id: p.offerId || null, name: p.name || null, title: attrs.title || null, link: attrs.link || null,
    severity: issues.some((i) => i.severity === "DISAPPROVED") || disapprovedIn.length ? "high" : "medium",
    status: issues.some((i) => i.severity === "DISAPPROVED") || disapprovedIn.length ? "disapproved" : "limited",
    disapproved_countries: disapprovedIn,
    issues: issues.slice(0, 5).map((i) => ({
      code: i.code || null, severity: i.severity, attribute: i.attribute || null, context: i.reportingContext || null,
      description: i.description || null, detail: i.detail || null, resolution: i.resolution || null,
      countries: i.applicableCountries || [],
    })),
  };
}

export async function runFeedHealthStore(env, storeId, { nowMs, day, fetchImpl = fetch }) {
  const db = env.DB;
  const name = STORES[storeId].name;
  const notWired = async (reason) => {
    await saveRun(db, { agent: AGENT, store: storeId, day, nowMs, status: "not_wired", note: reason });
    await logEvent(db, { actor: AGENT, kind: "catalog.mc_not_wired", store: storeId, target: "sys.gmc", at: nowIso(nowMs),
      summary: `${name}: Merchant Center health not wired (${reason}).` });
    return { status: "not_wired", reason };
  };

  const mid = await merchantIdFor(env, storeId);
  if (!mid) return notWired(`needs the Merchant Center id for ${name}: set GMC_MERCHANT_ID_${storeId.toUpperCase()}`);
  let token;
  try { token = await getGoogleAccessToken(env, { fetchImpl, nowMs, slot: "google" }); }
  catch (err) {
    if (err && (err.code === "NOT_WIRED" || err.code === "GOOGLE_REVOKED")) return notWired(`Google is not connected (${err.message})`);
    throw err;
  }

  const findings = [];
  let total = 0, pageToken = null, pages = 0, truncated = false;
  try {
    do {
      const qs = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
      if (pageToken) qs.set("pageToken", pageToken);
      const res = await fetchImpl(`${MERCHANT_API}/accounts/${mid.id}/products?${qs}`, { headers: { authorization: `Bearer ${token}` } });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) throw googleError(res.status, body, mid.id);
      for (const p of body.products || []) {
        total++;
        const f = findingFromProduct(p);
        if (f) findings.push(f);
      }
      pageToken = body.nextPageToken || null;
      pages++;
    } while (pageToken && pages < MAX_PAGES);
    truncated = !!pageToken;
  } catch (err) {
    if (err && err.code === "NOT_WIRED") return notWired(err.message);
    throw err;
  }

  findings.sort((a, b) => (b.severity === "high") - (a.severity === "high"));
  const disapproved = findings.filter((f) => f.status === "disapproved").length;
  const limited = findings.length - disapproved;
  const topIssues = {};
  for (const f of findings) for (const i of f.issues) { const k = i.description || i.code; topIssues[k] = (topIssues[k] || 0) + 1; }
  const summary = { merchant_id: mid.id, merchant_id_source: mid.source, products_read: total, truncated, disapproved, limited,
    top_issues: Object.entries(topIssues).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([issue, n]) => ({ issue, n })),
    not_built: "account-level issues and proposed fixes" };
  await saveRun(db, { agent: AGENT, store: storeId, day, nowMs, status: "ok", summary, findings });
  await logEvent(db, {
    actor: AGENT, kind: "catalog.mc_digest", store: storeId, target: "sys.gmc", at: nowIso(nowMs),
    summary: `${name}: Merchant Center ${total}${truncated ? "+" : ""} products read; ${disapproved} disapproved, ${limited} limited.${summary.top_issues[0] ? ` Top issue: ${summary.top_issues[0].issue} (${summary.top_issues[0].n}).` : ""}`,
    data: { products_read: total, disapproved, limited, truncated },
  });
  return { status: "ok", products: total, disapproved, limited };
}
