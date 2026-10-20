/**
 * Chart Fetcher (part of sup.size_charts) — the brain reads factory size charts itself.
 *
 * Reilly, 2026-10-20: "every quoted product in KFB has a 'supplier link' button on it ... if you
 * open that supplier link, you should be able to see the size chart." Asked how the brain should
 * get them, he chose: "Brain fetches 1688 itself".
 *
 * For each product with sized orders and no chart (sizeIntake.chartsNeeded), whose factory link
 * the KFB import recorded (supplier_links):
 *   1. GET the 1688 offer page and find its description address (`detailUrl`, on
 *      itemcdn.tmall.com). 1688 sometimes answers with a slider check or a login page instead:
 *      that is recorded as "blocked" and tried again later (a failed probe is evidence about the
 *      probe, rule 6). The brain never tries to get past a check.
 *   2. GET the description and the images in it (alicdn only), in page order.
 *   3. One Claude call looks at the images, picks the garment measurement chart (尺码信息:
 *      size → chest / length / shoulder / sleeve in cm), never the "which size for your height
 *      and weight" guide, and copies the numbers.
 *   4. The same checks as a pasted chart (sizeIntake.validateChart), saved NOT YET CHECKED.
 *      An unchecked chart decides nothing at KFB: only a chart Reilly confirms makes a size ask.
 * Only fixed hosts are ever fetched (detail.1688.com, itemcdn.tmall.com, *.alicdn.com).
 * Switch: CHART_FETCH_LIVE = "1".
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { askJson, AiError } from "../../lib/ai.js";
import { STORES } from "../../config/stores.js";
import { chartsNeeded, addChartFromListing, IMAGE_TYPES } from "./sizeIntake.js";

const ACTOR = "sup.size_charts";
export const FETCH_PER_RUN = 2;
export const MAX_IMAGES = 20;
export const MAX_IMAGE_BYTES = 3_700_000;   // the Claude API's per-image limit is ~5 MB of base64
export const MAX_TOTAL_BYTES = 14_000_000;
export const MAX_TRIES = 4;
const HOUR = 3600000, DAY = 24 * HOUR;
/** Next try after a result (attempt = tries so far, from 1). */
export function nextTryMs(status, attempt, nowMs) {
  if (status === "read") return null;
  if (attempt >= MAX_TRIES) return null; // given up: stays on the "charts needed" list for Reilly
  const gap = status === "failed" ? [HOUR, 6 * HOUR, DAY][Math.min(attempt - 1, 2)] : [DAY, 3 * DAY, 7 * DAY][Math.min(attempt - 1, 2)];
  return nowMs + gap;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const HEADERS = { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8", "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" };

/** The description address in a 1688 offer page, or null. Pure. Only itemcdn.tmall.com. */
export function descUrlFrom(html) {
  const m = String(html || "").match(/"detailUrl"\s*:\s*"([^"]+)"/);
  if (!m) return null;
  const u = m[1].replace(/\\u002F/gi, "/").replace(/\\\//g, "/").replace(/^\/\//, "https://").replace(/^http:/, "https:");
  try { return new URL(u).host === "itemcdn.tmall.com" ? u : null; } catch { return null; }
}

/** A slider check / login wall instead of the listing. Pure. */
export function looksBlocked(url, html) {
  return /punish|_____tmd_____|login\.1688\.com|login\.taobao\.com|captcha|nocaptcha/i.test(String(url || "")) ||
    /_____tmd_____|nc_1_wrapper|punish-component|"action"\s*:\s*"captcha"|滑动验证|请拖动下方滑块/i.test(String(html || "").slice(0, 20000));
}

/** Image addresses in a description, in page order, alicdn only, each once. Pure. */
export function imagesFrom(desc) {
  const seen = new Set(), out = [];
  for (const m of String(desc || "").matchAll(/(?:https?:)?\/\/([a-z0-9.-]*alicdn\.com)\/[^"'\\\s)<>]+?\.(?:jpe?g|png|webp|gif)/gi)) {
    let u = m[0].replace(/^\/\//, "https://").replace(/^http:/, "https:");
    if (seen.has(u)) continue;
    seen.add(u); out.push(u);
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

function base64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const SYSTEM = `You read clothing factory listings (1688, usually Chinese). You are shown the listing's description images, numbered from 0.
Find the GARMENT MEASUREMENT chart: a table of sizes (S, M, L, XL, 2XL ...) with measurements of the garment in cm, e.g. 尺码信息 / 尺码表 with 胸围 (chest/bust), 衣长 or 后中长 (length), 肩宽 (shoulder), 袖长 (sleeve), 腰围 (waist), 平铺 (measured flat).
It is NOT the size guide that recommends a size for a body height and weight (推荐尺码 / 建议体重 / 建议身高 / 斤 / kg): ignore that one.
Copy only numbers you can read; null for a measurement the chart doesn't give; never invent or estimate. A range (80-85) → its midpoint. Size labels as printed.
If no image is a readable garment measurement chart, return image_index null, rows [] and say why in "unreadable".`;
const USER = `Return {"image_index":5,"unit":"cm"|"in","flat":true|false|null,"rows":[{"size":"M","chest":104,"shoulder":54,"length":67,"sleeve":55,"waist":null}],"unreadable":null}.
"flat" is true only if the chart says chest/waist are measured laid flat (half the circumference), false if it says full circumference, null if it doesn't say.`;

async function getText(fetchImpl, url, headers = HEADERS) {
  const r = await fetchImpl(url, { headers, redirect: "follow" });
  const text = await r.text();
  return { status: r.status, url: r.url || url, text };
}

/** Read one product's chart from its listing. Returns {status, note, rows?, unit?, flat?, image?}. */
export async function readListing(env, link, { fetchImpl = fetch, nowMs = Date.now(), store } = {}) {
  let page;
  try { page = await getText(fetchImpl, link.offer_url); }
  catch (err) { return { status: "failed", note: `listing not reached (${String(err && err.message).slice(0, 80)})` }; }
  if (looksBlocked(page.url, page.text)) return { status: "blocked", note: "1688 asked for a slider check or a login instead of the listing" };
  if (page.status >= 400) return { status: page.status === 404 ? "not_found" : "failed", note: `listing answered HTTP ${page.status}` };
  const descUrl = descUrlFrom(page.text);
  if (!descUrl) return { status: looksBlocked("", page.text) ? "blocked" : "not_found", note: "no description address in the listing page" };
  let desc;
  try { desc = await getText(fetchImpl, descUrl, { ...HEADERS, referer: link.offer_url }); }
  catch (err) { return { status: "failed", note: `description not reached (${String(err && err.message).slice(0, 80)})` }; }
  const urls = imagesFrom(desc.text);
  if (!urls.length) return { status: "not_found", note: "the description has no images" };
  const images = [], used = [];
  let total = 0;
  for (const u of urls) {
    try {
      const r = await fetchImpl(u, { headers: { "user-agent": UA, referer: link.offer_url } });
      if (!r.ok) continue;
      const type = String(r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const mediaType = type === "image/jpg" ? "image/jpeg" : type;
      if (!IMAGE_TYPES.includes(mediaType)) continue;
      const buf = await r.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > MAX_IMAGE_BYTES || total + buf.byteLength > MAX_TOTAL_BYTES) continue;
      total += buf.byteLength;
      images.push({ media_type: mediaType, data: base64(buf) });
      used.push(u);
    } catch { /* one image missing is not the chart missing: carry on */ }
  }
  if (!images.length) return { status: "failed", note: "none of the description images could be downloaded" };
  let r;
  try {
    r = await askJson(env, { system: SYSTEM, user: USER, images, maxTokens: 1500, actor: ACTOR, label: "Size chart from 1688 listing", store }, { fetchImpl, nowMs });
  } catch (err) {
    return { status: "failed", note: `the brain couldn't read the images: ${String(err instanceof AiError ? err.message : "error").slice(0, 120)}` };
  }
  if (r.skipped) return { status: "skipped", note: `image reading is ${r.skipped}` };
  const j = r.json || {};
  const idx = Number.isInteger(j.image_index) && j.image_index >= 0 && j.image_index < used.length ? j.image_index : null;
  if (idx == null || !Array.isArray(j.rows) || !j.rows.length) return { status: "not_found", note: `no garment measurement chart in the ${used.length} description images${j.unreadable ? `: ${String(j.unreadable).slice(0, 120)}` : ""}` };
  return { status: "read", rows: j.rows, unit: j.unit, flat: j.flat, image: used[idx], imageIndex: idx, images: used.length };
}

/** The job: a couple of products per run, most-ordered first. */
export async function runChartFetch(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  if (String(env.CHART_FETCH_LIVE || "") !== "1") return { skipped: "CHART_FETCH_LIVE is not 1" };
  const db = env.DB;
  const needed = await chartsNeeded(db, { nowMs, limit: 20 });
  const out = [];
  for (const n of needed) {
    if (out.length >= FETCH_PER_RUN) break;
    if (!n.product_handle) continue;
    const link = await db.prepare(`SELECT * FROM supplier_links WHERE store = ? AND product_handle = ? ORDER BY last_seen_at DESC LIMIT 1`).bind(n.store, n.product_handle).first();
    if (!link) continue;
    const prev = await db.prepare(`SELECT * FROM chart_fetches WHERE store = ? AND product_handle = ?`).bind(n.store, n.product_handle).first();
    // A new factory link starts the tries again; otherwise wait for the next try (none = given up).
    const sameOffer = prev && prev.offer_id === link.offer_id;
    if (sameOffer && (!prev.next_try_at || Date.parse(prev.next_try_at) > nowMs)) continue;
    const attempt = (sameOffer ? prev.attempts : 0) + 1;
    const at = nowIso(nowMs);
    const res = await readListing(env, link, { fetchImpl, nowMs, store: n.store });
    if (res.status === "skipped") { out.push({ store: n.store, handle: n.product_handle, ...res }); break; } // AI paused: try again next run
    let status = res.status, note = res.note || null, intakeId = null;
    if (status === "read") {
      const saved = await addChartFromListing(env, {
        store: n.store, product_handle: n.product_handle, product_id: n.product_id, unit: res.unit, flat: res.flat, rows: res.rows,
        source: `read by the brain from the 1688 listing ${link.offer_url} (description image ${res.imageIndex + 1} of ${res.images}), not yet checked by Reilly`,
      }, { nowMs });
      if (saved.ok) { intakeId = saved.id; note = `chart #${saved.id} saved (${saved.rows.map((x) => x.size).join(", ")}), waiting for your check`; }
      else { status = "not_found"; note = String(saved.error || "not saved").slice(0, 200); }
    }
    const next = nextTryMs(status, attempt, nowMs);
    await db.prepare(
      `INSERT INTO chart_fetches (store, product_handle, offer_id, status, note, intake_id, attempts, last_try_at, next_try_at) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(store, product_handle) DO UPDATE SET offer_id = excluded.offer_id, status = excluded.status, note = excluded.note,
         intake_id = COALESCE(excluded.intake_id, chart_fetches.intake_id), attempts = excluded.attempts, last_try_at = excluded.last_try_at, next_try_at = excluded.next_try_at`
    ).bind(n.store, n.product_handle, link.offer_id, status, note, intakeId, attempt, at, next ? nowIso(next) : null).run();
    await logEvent(db, {
      actor: ACTOR, kind: `size_chart.fetch_${status}`, store: n.store, target: "sys.kfb", at,
      summary: `${STORES[n.store].name} ${n.title || n.product_handle}: ${status === "read" ? note : `no chart from the 1688 listing (${note})${next ? "; tries again later" : "; given up, on the charts-needed list"}`}`,
      data: { handle: n.product_handle, offer: link.offer_id, status, attempt, intake: intakeId },
    });
    out.push({ store: n.store, handle: n.product_handle, status, note });
  }
  return { fetched: out };
}
