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
import { askJson, AiError, aiBudgetLeft } from "../../lib/ai.js";
import { STORES } from "../../config/stores.js";
import { chartsNeeded, addChartFromListing, IMAGE_TYPES } from "./sizeIntake.js";

const ACTOR = "sup.size_charts";
export const FETCH_PER_RUN = 2;
export const MAX_IMAGES = 18; // under 20 images, each may be up to 8000 px
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

/** Hosts the brain may fetch from, by step. The final address after redirects is checked too. */
export const isAlicdn = (host) => /^(?:[a-z0-9-]+\.)*alicdn\.com$/i.test(String(host || ""));
export function allowedHost(url, step) {
  let h; try { h = new URL(url).host.toLowerCase(); } catch { return false; }
  if (step === "listing") return h === "detail.1688.com";
  if (step === "desc") return h === "itemcdn.tmall.com";
  return isAlicdn(h);
}

/** Image addresses in a description, in page order, alicdn only, each once. Pure. */
export function imagesFrom(desc) {
  const seen = new Set(), out = [];
  for (const m of String(desc || "").matchAll(/(?:https?:)?\/\/([a-z0-9.-]+)\/[^"'\\\s)<>]+?\.(?:jpe?g|png|webp|gif)/gi)) {
    let u = m[0].replace(/^\/\//, "https://").replace(/^http:/, "https:");
    if (!isAlicdn(m[1]) || seen.has(u)) continue;
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

async function getText(fetchImpl, url, step, headers = HEADERS) {
  const r = await fetchImpl(url, { headers, redirect: "follow" });
  const finalUrl = r.url || url;
  // A redirect off the allowed host: the body is not read (a login or check page is "blocked").
  if (!allowedHost(finalUrl, step)) return { status: r.status, url: finalUrl, text: "", offHost: true };
  const text = await r.text();
  return { status: r.status, url: finalUrl, text };
}

/** Width and height from a PNG or JPEG header, or null. Pure. */
export function imageSize(buf) {
  const b = new Uint8Array(buf);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, h: (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0 };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1], len = b[i + 2] << 8 | b[i + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b[i + 5] << 8 | b[i + 6], w: b[i + 7] << 8 | b[i + 8] };
      i += 2 + len;
    }
  }
  return null;
}
/** The Claude API refuses an image over 8000 px on a side (2000 px when a request has many). */
export const MAX_SIDE_PX = 7900;

/** Read one product's chart from its listing. Returns {status, note, rows?, unit?, flat?, image?}. */
export async function readListing(env, link, { fetchImpl = fetch, nowMs = Date.now(), store } = {}) {
  // No downloads while image reading can't happen anyway (no key, or today's AI budget used).
  if (!env.ANTHROPIC_API_KEY) return { status: "skipped", note: "image reading is not wired (no ANTHROPIC_API_KEY)" };
  if ((await aiBudgetLeft(env, nowMs)) <= 0) return { status: "skipped", note: "image reading is paused (daily AI budget reached)" };
  let page;
  if (!allowedHost(link.offer_url, "listing")) return { status: "not_found", note: "the factory link is not a 1688 listing" };
  try { page = await getText(fetchImpl, link.offer_url, "listing"); }
  catch (err) { return { status: "failed", note: `listing not reached (${String(err && err.message).slice(0, 80)})` }; }
  if (page.offHost || looksBlocked(page.url, page.text)) return { status: "blocked", note: "1688 asked for a slider check or a login instead of the listing" };
  if (page.status >= 400) return { status: page.status === 404 ? "not_found" : "failed", note: `listing answered HTTP ${page.status}` };
  const descUrl = descUrlFrom(page.text);
  if (!descUrl) return { status: looksBlocked("", page.text) ? "blocked" : "not_found", note: "no description address in the listing page" };
  let desc;
  try { desc = await getText(fetchImpl, descUrl, "desc", { ...HEADERS, referer: link.offer_url }); }
  catch (err) { return { status: "failed", note: `description not reached (${String(err && err.message).slice(0, 80)})` }; }
  if (desc.offHost) return { status: "blocked", note: "the description address redirected off itemcdn.tmall.com" };
  const urls = imagesFrom(desc.text);
  if (!urls.length) return { status: "not_found", note: "the description has no images" };
  const images = [], used = [];
  let total = 0;
  for (const u of urls) {
    try {
      const r = await fetchImpl(u, { headers: { "user-agent": UA, referer: link.offer_url } });
      if (!r.ok || !allowedHost(r.url || u, "image")) continue;
      const type = String(r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const mediaType = type === "image/jpg" ? "image/jpeg" : type;
      if (!IMAGE_TYPES.includes(mediaType)) continue;
      const buf = await r.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > MAX_IMAGE_BYTES || total + buf.byteLength > MAX_TOTAL_BYTES) continue;
      const dim = imageSize(buf);
      if (dim && (dim.w > MAX_SIDE_PX || dim.h > MAX_SIDE_PX)) continue;
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
  // The whole list (not the top 20): products with no link or no tries left must not hide the rest.
  const needed = await chartsNeeded(db, { nowMs, limit: 200 });
  const out = [];
  for (const n of needed) {
    if (out.length >= FETCH_PER_RUN) break;
    if (!n.product_handle) continue;
    // Stable choice: the newest link KFB first showed for this product (ties by offer number), so
    // two offers on one product can't take turns resetting the tries.
    const link = await db.prepare(`SELECT * FROM supplier_links WHERE store = ? AND product_handle = ? ORDER BY first_seen_at DESC, offer_id DESC LIMIT 1`).bind(n.store, n.product_handle).first();
    if (!link) continue;
    const prev = await db.prepare(`SELECT * FROM chart_fetches WHERE store = ? AND product_handle = ?`).bind(n.store, n.product_handle).first();
    // Only a link KFB showed AFTER the last try starts the tries again; otherwise wait for the
    // next try (none = given up: it stays on the charts-needed list for Reilly).
    const fresh = !prev || (prev.offer_id !== link.offer_id && link.first_seen_at > prev.last_try_at);
    if (!fresh && (!prev.next_try_at || Date.parse(prev.next_try_at) > nowMs)) continue;
    const attempt = (fresh ? 0 : prev.attempts) + 1;
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
