/**
 * Google connection — one consent from Reilly gives the brain Gmail, Google Ads,
 * Merchant Center and Sheets through his own account (reillyworking26@gmail.com).
 *
 * Flow:
 *   1. Mission Control → Setup → "Connect Google" asks POST /api/admin/google/start
 *      (key required). We record a one-time random `state` and return Google's consent URL.
 *   2. Reilly approves on Google. Google sends him back to GET /oauth/google/callback.
 *   3. We check the state (unused, < 15 min old), swap the code for tokens, confirm WHICH
 *      account consented (wrong account = hard stop, nothing stored), encrypt the refresh
 *      token, then prove it works with a real Gmail call before saying "connected" (rule 3).
 *
 * Why encrypted: the refresh token is a standing credential. It is stored only as AES-GCM
 * ciphertext; the key is derived from the APPROVAL_SIGNING_KEY secret, so the database alone
 * is useless. (If that secret is ever replaced, Reilly simply clicks Connect Google again.)
 *
 * Secrets (Reilly adds them; never in this repo): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
 * Variable: GOOGLE_ACCOUNT — the only account allowed to connect.
 */
import { logEvent } from "./eventlog.js";
import { nowIso } from "./time.js";
import { page, esc } from "./approvalPage.js";

export const GOOGLE_SCOPES = Object.freeze([
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",   // read mail, create drafts, labels (never permanent delete)
  "https://www.googleapis.com/auth/adwords",        // Google Ads (Media is watch-only by decision)
  "https://www.googleapis.com/auth/content",        // Merchant Center
  "https://www.googleapis.com/auth/spreadsheets",   // P&L workbooks (Sheets Writer)
]);

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const STATE_TTL_MS = 15 * 60 * 1000;

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function redirectUri(env) {
  return `${String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "")}/oauth/google/callback`;
}

export function expectedAccount(env) {
  return String(env.GOOGLE_ACCOUNT || "").trim().toLowerCase();
}

async function tokenKey(env) {
  if (!env.APPROVAL_SIGNING_KEY) throw new Error("APPROVAL_SIGNING_KEY missing");
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`${env.APPROVAL_SIGNING_KEY}:google-refresh-token:v1`));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptToken(env, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await tokenKey(env), enc.encode(plain));
  return { enc_token: b64(ct), iv: b64(iv) };
}

export async function decryptToken(env, row) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(row.iv) }, await tokenKey(env), unb64(row.enc_token));
  return new TextDecoder().decode(pt);
}

/** Step 1: a one-time consent URL. */
export async function startGoogleConnect(env, { nowMs = Date.now() } = {}) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return { ok: false, error: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not in Cloudflare yet (run 8 ADD GOOGLE APP KEYS.bat)" };
  }
  if (!env.PUBLIC_BASE_URL) return { ok: false, error: "PUBLIC_BASE_URL is not set" };
  // Housekeeping: forget sign-in attempts older than a day.
  await env.DB.prepare(`DELETE FROM oauth_states WHERE created_at < ?`).bind(new Date(nowMs - 24 * 3600 * 1000).toISOString()).run();
  const state = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare(`INSERT INTO oauth_states (state, created_at) VALUES (?, ?)`).bind(state, new Date(nowMs).toISOString()).run();
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(env),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",   // we need a refresh token for 24/7 work
    prompt: "consent",        // always return a refresh token, even on a reconnect
    include_granted_scopes: "true",
    state,
  });
  const hint = expectedAccount(env);
  if (hint) params.set("login_hint", hint);
  return { ok: true, url: `${AUTH_URL}?${params}` };
}

function resultPage(title, body, status = 200) {
  return page(title, `<h1>${esc(title)}</h1>${body}<div class="meta" style="margin-top:18px">You can close this tab and go back to Mission Control.</div>`, status);
}

/** Step 2/3: Google sends Reilly back here. */
export async function handleGoogleCallback(request, env, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code");
  const gErr = url.searchParams.get("error");
  const at = new Date(nowMs).toISOString();

  // The state must exist, be fresh, and be used exactly once.
  const st = state ? await env.DB.prepare(`SELECT * FROM oauth_states WHERE state = ?`).bind(state).first() : null;
  if (!st || st.used_at || nowMs - Date.parse(st.created_at) > STATE_TTL_MS) {
    return resultPage("Link expired", `<div class="done warn">This sign-in link is no longer valid. Click <b>Connect Google</b> in Mission Control again.</div>`, 400);
  }
  const claim = await env.DB.prepare(`UPDATE oauth_states SET used_at = ? WHERE state = ? AND used_at IS NULL`).bind(at, state).run();
  if (!claim.meta || claim.meta.changes !== 1) {
    return resultPage("Link already used", `<div class="done warn">Click <b>Connect Google</b> again.</div>`, 400);
  }
  if (gErr || !code) {
    await logEvent(env.DB, { actor: "svc.store_guard", kind: "google.connect_cancelled", target: "sys.gmail", summary: `Google connection not completed (${String(gErr || "no code").slice(0, 60)})`, at });
    return resultPage("Not connected", `<div class="done warn">Google didn't complete the sign-in (${esc(gErr || "no code")}). Nothing was saved.</div>`, 400);
  }

  // Swap the one-time code for tokens.
  const tokRes = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(env), grant_type: "authorization_code",
    }).toString(),
  }).catch(() => null);
  const tok = tokRes ? await tokRes.json().catch(() => null) : null;
  if (!tokRes || !tokRes.ok || !tok || !tok.access_token) {
    // Never echo Google's body: it can contain token material.
    await logEvent(env.DB, { actor: "svc.store_guard", kind: "google.connect_failed", target: "sys.gmail", summary: `Google connection failed at the token step (HTTP ${tokRes ? tokRes.status : "no response"})`, at });
    return resultPage("Not connected", `<div class="done bad">Google refused the sign-in (HTTP ${tokRes ? tokRes.status : "no response"}). Check the client ID/secret and the redirect URI, then try again.</div>`, 502);
  }
  if (!tok.refresh_token) {
    return resultPage("Not connected", `<div class="done bad">Google didn't give a long-term token. Go to myaccount.google.com → Security → Third-party connections, remove "Store Brain", then click Connect Google again.</div>`, 502);
  }

  // Which account actually consented? Wrong account = hard stop (Store Guard thinking).
  const who = await fetchImpl(USERINFO_URL, { headers: { authorization: `Bearer ${tok.access_token}` } }).catch(() => null);
  const info = who && who.ok ? await who.json().catch(() => null) : null;
  const account = String((info && info.email) || "").toLowerCase();
  const expected = expectedAccount(env);
  if (!account || (expected && account !== expected)) {
    await logEvent(env.DB, { actor: "svc.store_guard", kind: "google.wrong_account", target: "sys.gmail", summary: `Google connection REFUSED: signed in as ${account || "unknown"}, expected ${expected}. Nothing saved.`, at });
    return resultPage("Wrong Google account", `<div class="done bad">You signed in as <b>${esc(account || "unknown")}</b>. The brain only connects <b>${esc(expected)}</b>. Nothing was saved — click Connect Google again and pick that account.</div>`, 403);
  }

  const granted = String(tok.scope || "").split(/\s+/).filter(Boolean);

  // Prove the NEW token works (refresh grant + real Gmail read) BEFORE replacing anything,
  // so a bad reconnect can never overwrite a working connection (rule 3).
  const check = await checkRefreshToken(env, tok.refresh_token, account, { fetchImpl });
  if (check.ok) {
    const { enc_token, iv } = await encryptToken(env, tok.refresh_token);
    await env.DB.prepare(
      `INSERT INTO oauth_tokens (provider, account, scopes, enc_token, iv, created_at, verified_at) VALUES ('google', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET account = excluded.account, scopes = excluded.scopes, enc_token = excluded.enc_token,
         iv = excluded.iv, created_at = excluded.created_at, verified_at = excluded.verified_at`
    ).bind(account, granted.join(" "), enc_token, iv, at, at).run();
    _resetGoogleCacheForTests();
  }
  const missing = GOOGLE_SCOPES.filter((s) => !["openid", "email"].includes(s) && !granted.includes(s));
  await logEvent(env.DB, {
    actor: "svc.store_guard", kind: check.ok ? "google.connected" : "google.verify_failed", target: "sys.gmail",
    summary: check.ok
      ? `Google connected and verified (${account})${missing.length ? `; NOT granted: ${missing.map(shortScope).join(", ")}` : "; Gmail, Ads, Merchant Center, Sheets granted"}`
      : `Google sign-in worked but the Gmail check failed (${check.error}); nothing was changed`,
    data: { account, missing: missing.map(shortScope) }, at,
  });
  if (!check.ok) {
    return resultPage("Not connected", `<div class="done warn">Google signed you in, but a test Gmail read with the new connection failed (${esc(check.error)}). Nothing was changed. Tell Claude.</div>`, 502);
  }
  const rows = GOOGLE_SCOPES.filter((s) => !["openid", "email"].includes(s))
    .map((s) => `<div>${granted.includes(s) ? '<span class="good">✓</span>' : '<span class="bad">✗</span>'} ${esc(shortScope(s))}</div>`).join("");
  return resultPage("Google connected", `<div class="done good">Connected as <b>${esc(account)}</b> and checked with a real Gmail read.</div><div class="opt" style="margin-top:12px">${rows}</div>${missing.length ? `<div class="done warn" style="margin-top:12px">Some boxes were unticked on Google's screen. Click Connect Google again and tick all of them.</div>` : ""}`);
}

export function shortScope(s) {
  return { "https://www.googleapis.com/auth/gmail.modify": "Gmail", "https://www.googleapis.com/auth/adwords": "Google Ads",
    "https://www.googleapis.com/auth/content": "Merchant Center", "https://www.googleapis.com/auth/spreadsheets": "Sheets" }[s] || s;
}

/* ---------- using the connection ---------- */

let cached = null; // { token, expMs, gen } — per isolate, never stored; gen = the stored token's created_at

export function _resetGoogleCacheForTests() { cached = null; }

/** A short-lived access token for API calls by other workers. Throws NOT_WIRED if not connected. */
export async function getGoogleAccessToken(env, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const row = await env.DB.prepare(`SELECT * FROM oauth_tokens WHERE provider = 'google'`).first();
  if (!row) { cached = null; const e = new Error("Google is not connected"); e.code = "NOT_WIRED"; throw e; }
  // Reuse only if it was minted from the token stored now (a reconnect elsewhere invalidates it).
  if (cached && cached.gen === row.created_at && cached.expMs - 5 * 60 * 1000 > nowMs) return cached.token;
  const refresh = await decryptToken(env, row);
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: "refresh_token" }).toString(),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.access_token) {
    const e = new Error(`Google token refresh failed (HTTP ${res.status}${body && body.error ? `, ${body.error}` : ""})`);
    e.code = body && body.error === "invalid_grant" ? "GOOGLE_REVOKED" : "GOOGLE_REFRESH_FAILED";
    throw e;
  }
  cached = { token: body.access_token, expMs: nowMs + (Number(body.expires_in) || 3600) * 1000, gen: row.created_at };
  return cached.token;
}

/** Refresh grant + Gmail profile read for a refresh token that is not stored yet. */
async function checkRefreshToken(env, refresh, account, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: "refresh_token" }).toString(),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !body.access_token) return { ok: false, error: `token refresh failed (HTTP ${res.status})` };
    const prof = await fetchImpl(GMAIL_PROFILE_URL, { headers: { authorization: `Bearer ${body.access_token}` } });
    const p = await prof.json().catch(() => null);
    if (!prof.ok || !p || String(p.emailAddress || "").toLowerCase() !== account) return { ok: false, error: `Gmail profile check failed (HTTP ${prof.status})` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: "network error" };
  }
}

/** Real check: a Gmail profile read must come back as the connected account. */
export async function verifyGoogle(env, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  try {
    const token = await getGoogleAccessToken(env, { fetchImpl, nowMs });
    const res = await fetchImpl(GMAIL_PROFILE_URL, { headers: { authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => null);
    const row = await env.DB.prepare(`SELECT account FROM oauth_tokens WHERE provider = 'google'`).first();
    if (!res.ok || !body || String(body.emailAddress || "").toLowerCase() !== row.account) {
      return { ok: false, error: `Gmail profile check failed (HTTP ${res.status})` };
    }
    await env.DB.prepare(`UPDATE oauth_tokens SET verified_at = ? WHERE provider = 'google'`).bind(new Date(nowMs).toISOString()).run();
    return { ok: true, account: row.account };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** For the Setup tab: connected or not, which account, what was granted. No token material. */
export async function googleStatus(db) {
  const row = await db.prepare(`SELECT account, scopes, created_at, verified_at FROM oauth_tokens WHERE provider = 'google'`).first().catch(() => null);
  if (!row) return { connected: false };
  const granted = row.scopes.split(" ");
  return {
    connected: !!row.verified_at, // saved but never proven = not connected (rules 3 and 5)
    account: row.account, connected_at: row.created_at, verified_at: row.verified_at,
    granted: GOOGLE_SCOPES.filter((s) => granted.includes(s) && !["openid", "email"].includes(s)).map(shortScope),
    missing: GOOGLE_SCOPES.filter((s) => !granted.includes(s) && !["openid", "email"].includes(s)).map(shortScope),
  };
}

/** Which secrets are present — names and true/false only, never values. */
export const SECRET_NAMES = Object.freeze([
  "MC_KEY", "APPROVAL_SIGNING_KEY", "PUSHOVER_APP_TOKEN", "PUSHOVER_USER_KEY",
  "SB_HC_CLIENT_SECRET", "SB_AUB_CLIENT_SECRET", "SB_MAR_CLIENT_SECRET",
  "ANTHROPIC_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TRACKING_API_KEY",
]);
export function secretPresence(env) {
  return Object.fromEntries(SECRET_NAMES.map((n) => [n, !!env[n]]));
}
