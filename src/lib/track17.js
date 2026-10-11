/**
 * 17TRACK API client — plain code, no AI.
 *
 * Facts this relies on (17TRACK API docs, v2.4 is current; v2.2 still online):
 *   - Base URL https://api.17track.net/track/v2.4, every call is POST with JSON.
 *   - The key goes in the `17token` header. It is never logged and never stored.
 *   - Up to 40 numbers per register / gettrackinfo call; 3 requests per second (HTTP 429 above).
 *   - Each REGISTERED number spends one unit of quota (Reilly's account: 200 free). Reading
 *     tracking info and the quota is free, so polling never touches the quota.
 *   - Carrier is optional on register: 17TRACK auto-detects it.
 *   - Push (webhook) authenticity: header `sign` = SHA-256 hex of `<raw body>/<key>`.
 *
 * Every function takes `fetchImpl` so tests never touch the network.
 */

export const API_BASE = "https://api.17track.net/track/v2.4";
export const MAX_PER_CALL = 40;
/** 3 requests/second is the documented limit; one call every 400 ms stays under it. */
export const CALL_GAP_MS = 400;
/** "Already registered" — the number is tracked, so it counts as registered (no quota spent). */
export const ERR_ALREADY_REGISTERED = -18019901;

export class Track17Error extends Error {
  constructor(message, code) {
    super(message);
    this.name = "Track17Error";
    this.code = code;
  }
}

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One API call. Errors carry only the HTTP status / 17TRACK code, never the key or the
 * request headers.
 */
export async function call17(env, path, body, { fetchImpl = fetch } = {}) {
  const key = env && env.TRACKING_API_KEY;
  if (!key) throw new Track17Error("TRACKING_API_KEY is not set in Cloudflare", "NOT_WIRED");
  let res;
  try {
    res = await fetchImpl(`${API_BASE}/${path}`, {
      method: "POST",
      headers: { "17token": key, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Track17Error(`17TRACK ${path}: network error (${String(err && err.message).slice(0, 100)})`, "NETWORK");
  }
  if (res.status === 429) throw new Track17Error(`17TRACK ${path}: rate limited (HTTP 429)`, "RATE_LIMIT");
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Track17Error(`17TRACK ${path}: HTTP ${res.status}`, "HTTP");
  if (json.code !== 0) throw new Track17Error(`17TRACK ${path}: error code ${json.code}`, "API");
  return json.data || {};
}

/** Quota left on the account. Free to call. */
export async function getQuota(env, opts = {}) {
  const d = await call17(env, "getquota", [], opts);
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return { total: n(d.quota_total), used: n(d.quota_used), remain: n(d.quota_remain), todayUsed: n(d.today_used) };
}

/** Split into groups of 40, one call per group, spaced to respect the rate limit. */
async function batched(env, path, items, opts) {
  const sleep = opts.sleep || sleepDefault;
  const accepted = [], rejected = [];
  for (let i = 0; i < items.length; i += MAX_PER_CALL) {
    if (i > 0) await sleep(CALL_GAP_MS);
    const d = await call17(env, path, items.slice(i, i + MAX_PER_CALL), opts);
    accepted.push(...(Array.isArray(d.accepted) ? d.accepted : []));
    rejected.push(...(Array.isArray(d.rejected) ? d.rejected : []));
  }
  return { accepted, rejected };
}

/** Register numbers (spends quota for each one accepted). Carrier left to auto-detect. */
export function register(env, numbers, opts = {}) {
  return batched(env, "register", numbers.map((number) => ({ number })), opts);
}

/** Current tracking detail for registered numbers. Free. */
export function getTrackInfo(env, numbers, opts = {}) {
  return batched(env, "gettrackinfo", numbers.map((number) => ({ number })), opts);
}

/* ---------------- push (webhook) authenticity ---------------- */

const enc = new TextEncoder();

async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The signature 17TRACK sends: sha256hex(rawBody + "/" + key). */
export const pushSignature = (rawBody, key) => sha256Hex(`${rawBody}/${key}`);

export async function verifyPush(rawBody, signHeader, key) {
  if (!key || !signHeader || typeof rawBody !== "string") return false;
  const expected = await pushSignature(rawBody, key);
  const given = String(signHeader).trim().toLowerCase();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/* ---------------- statuses ---------------- */

/**
 * 17TRACK's nine main statuses → the small set the brain reasons with.
 *   awaiting_pickup  label made / number unknown to the carrier yet (no carrier scan)
 *   in_transit       moving (including customs)
 *   out_for_delivery on the truck today
 *   pickup_ready     waiting at a post office / locker for the customer
 *   failed_attempt   delivery tried and failed (not home, bad address, refused…)
 *   delivered
 *   exception        returned, lost, damaged, delayed…
 *   expired          17TRACK stopped seeing updates for a long time
 * Anything unrecognised is "unknown" — never guessed into a better state (rule 5).
 */
const STATUS_MAP = Object.freeze({
  NotFound: "awaiting_pickup",
  InfoReceived: "awaiting_pickup",
  InTransit: "in_transit",
  OutForDelivery: "out_for_delivery",
  AvailableForPickup: "pickup_ready",
  DeliveryFailure: "failed_attempt",
  Delivered: "delivered",
  Exception: "exception",
  Expired: "expired",
});

export function mapStatus(status) {
  return STATUS_MAP[status] || "unknown";
}

export const STATE_LABELS = Object.freeze({
  awaiting_pickup: "Awaiting carrier pickup",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  pickup_ready: "Waiting at pickup point",
  failed_attempt: "Delivery failed",
  delivered: "Delivered",
  exception: "Exception",
  expired: "Tracking expired",
  unknown: "Unknown",
});

const utc = (v) => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

function allEvents(ti) {
  const providers = ti && ti.tracking && Array.isArray(ti.tracking.providers) ? ti.tracking.providers : [];
  return providers.flatMap((p) => (Array.isArray(p.events) ? p.events.map((e) => ({ ...e, _provider: p.provider && p.provider.name })) : []));
}

const eventTime = (e) => utc(e && (e.time_utc || e.time_iso));

/**
 * Pull what the brain stores out of one gettrackinfo item (or a push's data).
 * Pickup = the "PickedUp" milestone, else the earliest carrier event that isn't just
 * "label created". Delivered = the "Delivered" milestone, else the latest event when the
 * status says Delivered.
 */
export function summarise(item) {
  const ti = (item && item.track_info) || {};
  const ls = ti.latest_status || {};
  const le = ti.latest_event || null;
  const milestones = Array.isArray(ti.milestone) ? ti.milestone : [];
  const ms = (k) => {
    const m = milestones.find((x) => x && x.key_stage === k);
    return m ? eventTime(m) : null;
  };
  const events = allEvents(ti);
  const status = ls.status || null;
  const state = status ? mapStatus(status) : null;

  let pickupAt = ms("PickedUp");
  if (!pickupAt && state && state !== "awaiting_pickup" && state !== "unknown") {
    const scanned = events
      .filter((e) => e.sub_status && !/^(InfoReceived|NotFound)/.test(e.sub_status))
      .map(eventTime).filter(Boolean).sort();
    pickupAt = scanned[0] || null;
  }

  let deliveredAt = null;
  let deliveredEvent = null;
  if (state === "delivered") {
    deliveredEvent = events.find((e) => /^Delivered/.test(e.sub_status || "")) || le;
    deliveredAt = ms("Delivered") || eventTime(deliveredEvent) || eventTime(le);
  }

  return {
    number: item && item.number,
    carrier: item && Number.isFinite(Number(item.carrier)) ? Number(item.carrier) : null,
    status,
    subStatus: ls.sub_status || null,
    state,
    lastEventAt: eventTime(le),
    lastEventText: le ? (le.description || null) : null,
    lastEventLocation: le ? (le.location || null) : null,
    pickupAt,
    deliveredAt,
    deliveredEvent,
    recipient: ti.shipping_info && ti.shipping_info.recipient_address ? ti.shipping_info.recipient_address : null,
    milestones,
    events,
    misc: ti.misc_info || null,
  };
}
