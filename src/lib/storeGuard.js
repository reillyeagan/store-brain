/**
 * Store Guard — every Shopify call goes through here.
 *
 * Why: the old setup used one Shopify connection that held one store at a time,
 * switched stores silently, and was revoked 6+ times by `switch-shop`. Writes
 * nearly landed in the wrong store more than once. Here, each store has its OWN
 * app credentials, and before any write we ask Shopify which shop the token
 * belongs to and compare it with our config. A mismatch is a hard stop.
 *
 * Credentials: each store has a Shopify Dev Dashboard app (same org as the store),
 * and the worker mints a short-lived token with the client-credentials grant.
 * The client id/secret are Cloudflare secrets that Reilly pastes in himself.
 */
import { getStore } from "../config/stores.js";

export const SHOPIFY_API_VERSION = "2026-07";

export class StoreGuardError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "StoreGuardError";
    this.code = code;
  }
}

/** In-memory token cache per Worker isolate. Tokens are never written anywhere. */
const tokenCache = new Map(); // storeId -> { token, expiresAtMs }

export function _resetTokenCacheForTests() {
  tokenCache.clear();
}

/** Look up a live store and its credentials, or throw a clear error. */
export function storeCredentials(env, storeId) {
  const store = getStore(storeId);
  if (!store) throw new StoreGuardError(`Unknown store "${storeId}"`, "UNKNOWN_STORE");
  if (!store.live) throw new StoreGuardError(`${store.name} is not live yet`, "STORE_NOT_LIVE");
  if (!store.domain) throw new StoreGuardError(`${store.name} has no domain configured`, "NO_DOMAIN");
  const clientId = env[store.secrets.clientId];
  const clientSecret = env[store.secrets.clientSecret];
  if (!clientId || !clientSecret) {
    const missing = [!clientId && store.secrets.clientId, !clientSecret && store.secrets.clientSecret].filter(Boolean);
    throw new StoreGuardError(`${store.name} is not wired: ${missing.join(" and ")} missing`, "NOT_WIRED");
  }
  return { store, clientId, clientSecret };
}

/** Mint (or reuse) an Admin API access token for one store. */
export async function getAccessToken(env, storeId, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const cached = tokenCache.get(storeId);
  if (cached && cached.expiresAtMs - 5 * 60 * 1000 > nowMs) return cached.token;

  const { store, clientId, clientSecret } = storeCredentials(env, storeId);
  const res = await fetchImpl(`https://${store.domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  if (!res.ok) {
    throw new StoreGuardError(`${store.name}: token mint failed (HTTP ${res.status})`, "MINT_FAILED");
  }
  const body = await res.json().catch(() => null);
  if (!body || !body.access_token) {
    throw new StoreGuardError(`${store.name}: token mint returned no token`, "MINT_EMPTY");
  }
  const ttlSec = Number(body.expires_in) > 0 ? Number(body.expires_in) : 23 * 3600;
  tokenCache.set(storeId, { token: body.access_token, expiresAtMs: nowMs + ttlSec * 1000 });
  return body.access_token;
}

/**
 * Shopify's query-cost report for one request (Admin GraphQL `extensions.cost`), or null when
 * Shopify didn't send one. Shape: { requestedQueryCost, actualQueryCost,
 * throttleStatus: { maximumAvailable, currentlyAvailable, restoreRate } } (numbers or null).
 * Why: a caller that reads many pages in a row can stop BEFORE it runs the bucket dry,
 * instead of finding out from a THROTTLED error.
 */
export function readQueryCost(body) {
  const c = body && body.extensions && body.extensions.cost;
  if (!c) return null;
  const n = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Number(x));
  const t = c.throttleStatus || {};
  return {
    requestedQueryCost: n(c.requestedQueryCost),
    actualQueryCost: n(c.actualQueryCost),
    throttleStatus: {
      maximumAvailable: n(t.maximumAvailable),
      currentlyAvailable: n(t.currentlyAvailable),
      restoreRate: n(t.restoreRate),
    },
  };
}

/** Shopify said "slow down": a GraphQL error with extensions.code THROTTLED, or HTTP 429. */
function isThrottled(res, body) {
  if (res.status === 429) return true;
  const errs = body && Array.isArray(body.errors) ? body.errors : [];
  return errs.some((e) => e && e.extensions && String(e.extensions.code || "").toUpperCase() === "THROTTLED");
}

/**
 * Run one Admin GraphQL request against one specific store; returns `data` only.
 * Behaviour for existing callers is unchanged, except a throttle now carries code "THROTTLED"
 * (it used to be GRAPHQL_ERRORS / GRAPHQL_HTTP; no caller matched throttles on those codes).
 */
export async function shopifyGraphQL(env, storeId, query, variables = {}, opts = {}) {
  return (await shopifyGraphQLWithCost(env, storeId, query, variables, opts)).data;
}

/**
 * Same request, returning { data, cost } where cost = readQueryCost(...) (null if not reported).
 * Throws StoreGuardError code "THROTTLED" (with err.cost) when Shopify throttles, so a paging
 * caller can treat it as a pause, not a failure.
 */
export async function shopifyGraphQLWithCost(env, storeId, query, variables = {}, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const { store } = storeCredentials(env, storeId);
  const token = await getAccessToken(env, storeId, opts);
  const res = await fetchImpl(`https://${store.domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-shopify-access-token": token },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 || res.status === 403) {
    tokenCache.delete(storeId); // force a fresh mint next time
  }
  const body = await res.json().catch(() => null);
  const cost = readQueryCost(body);
  if (isThrottled(res, body)) {
    const why = body && Array.isArray(body.errors) && body.errors.length
      ? body.errors.map((e) => e.message).join("; ")
      : `GraphQL HTTP ${res.status}`;
    const err = new StoreGuardError(`${store.name}: ${why}`, "THROTTLED");
    err.cost = cost;
    throw err;
  }
  if (!res.ok || !body) {
    throw new StoreGuardError(`${store.name}: GraphQL HTTP ${res.status}`, "GRAPHQL_HTTP");
  }
  if (body.errors && body.errors.length) {
    throw new StoreGuardError(`${store.name}: ${body.errors.map((e) => e.message).join("; ")}`, "GRAPHQL_ERRORS");
  }
  return { data: body.data, cost };
}

/**
 * Ask Shopify which shop this token really belongs to, and compare with config.
 * Called before EVERY write batch, not once per session.
 */
export async function assertShop(env, storeId, opts = {}) {
  const { store } = storeCredentials(env, storeId);
  const data = await shopifyGraphQL(env, storeId, `{ shop { myshopifyDomain name } }`, {}, opts);
  const reported = data && data.shop && String(data.shop.myshopifyDomain || "").toLowerCase();
  if (reported !== store.domain) {
    throw new StoreGuardError(
      `STORE MISMATCH: expected ${store.domain} (${store.name}) but the token belongs to ${reported || "unknown"}. Nothing was written.`,
      "STORE_MISMATCH"
    );
  }
  return { domain: reported, name: data.shop.name };
}

/** Wrap a write: guard first, then run it. The write itself must be verified by the caller. */
export async function guardedWrite(env, storeId, writeFn, opts = {}) {
  await assertShop(env, storeId, opts);
  return writeFn();
}

/* ---------------- Webhooks ---------------- */

const enc = new TextEncoder();

function base64FromBytes(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a Shopify webhook: HMAC-SHA256 of the RAW body with the app's client
 * secret, base64, compared with the X-Shopify-Hmac-Sha256 header.
 */
export async function verifyWebhookHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, typeof rawBody === "string" ? enc.encode(rawBody) : rawBody);
  return timingSafeEqual(base64FromBytes(sig), String(hmacHeader).trim());
}
