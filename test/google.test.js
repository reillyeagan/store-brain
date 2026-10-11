import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";
import {
  startGoogleConnect, handleGoogleCallback, getGoogleAccessToken, googleStatus, secretPresence,
  encryptToken, decryptToken, _resetGoogleCacheForTests,
} from "../src/lib/google.js";

const ENV = (DB) => ({
  DB, GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "GOCSPX-secret",
  APPROVAL_SIGNING_KEY: "k".repeat(48), PUBLIC_BASE_URL: "https://brain.example", GOOGLE_ACCOUNT: "reillyworking26@gmail.com",
});

/** Fake Google: token exchange, refresh, userinfo, gmail profile. */
function fakeGoogle({ email = "reillyworking26@gmail.com", refresh = "1//refresh-xyz", scope, tokenStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const j = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const p = new URLSearchParams(init.body);
      if (tokenStatus !== 200) return j({ error: "invalid_client", error_description: "secret GOCSPX-secret wrong" }, tokenStatus);
      if (p.get("grant_type") === "authorization_code") {
        return j({ access_token: "ya29.first", refresh_token: refresh, expires_in: 3600,
          scope: scope ?? "openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/content https://www.googleapis.com/auth/spreadsheets" });
      }
      assert.equal(p.get("refresh_token"), refresh, "refresh grant uses the decrypted token");
      return j({ access_token: "ya29.refreshed", expires_in: 3600 });
    }
    if (url.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) return j({ email });
    if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/profile")) return j({ emailAddress: email });
    throw new Error("unexpected " + url);
  };
  return { fetchImpl, calls };
}

async function startAndGetState(env) {
  const r = await startGoogleConnect(env);
  assert.equal(r.ok, true);
  const u = new URL(r.url);
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("redirect_uri"), "https://brain.example/oauth/google/callback");
  assert.match(u.searchParams.get("scope"), /gmail\.modify/);
  return u.searchParams.get("state");
}

test("google: not configured → clear error, no URL", async () => {
  const r = await startGoogleConnect({ DB: makeD1() });
  assert.equal(r.ok, false);
  assert.match(r.error, /8 ADD GOOGLE APP KEYS/);
});

test("google: full connect stores an ENCRYPTED token and proves it with a Gmail read", async () => {
  _resetGoogleCacheForTests();
  const DB = makeD1(); const env = ENV(DB);
  const state = await startAndGetState(env);
  const g = fakeGoogle();
  const res = await handleGoogleCallback(new Request(`https://brain.example/oauth/google/callback?code=c1&state=${state}`), env, { fetchImpl: g.fetchImpl });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Google connected/);
  const row = await DB.prepare(`SELECT * FROM oauth_tokens WHERE provider='google'`).first();
  assert.ok(!row.enc_token.includes("refresh-xyz"), "token is not stored in plain text");
  assert.equal(await decryptToken(env, row), "1//refresh-xyz");
  assert.ok(row.verified_at, "verified with a real call");
  assert.ok(g.calls.some((c) => c.url.includes("gmail/v1/users/me/profile")));
  const st = await googleStatus(DB);
  assert.deepEqual(st.missing, []);
  // events never contain token material
  const ev = (await DB.prepare(`SELECT summary, data FROM events`).all()).results.map((e) => e.summary + (e.data || "")).join(" ");
  assert.ok(!/ya29|refresh-xyz|GOCSPX/.test(ev));
});

test("google: a state works once and expires", async () => {
  _resetGoogleCacheForTests();
  const DB = makeD1(); const env = ENV(DB);
  const state = await startAndGetState(env);
  const g = fakeGoogle();
  await handleGoogleCallback(new Request(`https://b/oauth/google/callback?code=c&state=${state}`), env, { fetchImpl: g.fetchImpl });
  const again = await handleGoogleCallback(new Request(`https://b/oauth/google/callback?code=c&state=${state}`), env, { fetchImpl: g.fetchImpl });
  assert.equal(again.status, 400);
  const forged = await handleGoogleCallback(new Request(`https://b/oauth/google/callback?code=c&state=nope`), env, { fetchImpl: g.fetchImpl });
  assert.equal(forged.status, 400);
  const s2 = await startAndGetState(env);
  const late = await handleGoogleCallback(new Request(`https://b/oauth/google/callback?code=c&state=${s2}`), env, { fetchImpl: g.fetchImpl, nowMs: Date.now() + 16 * 60 * 1000 });
  assert.equal(late.status, 400);
});

test("google: wrong account is a hard stop — nothing stored", async () => {
  _resetGoogleCacheForTests();
  const DB = makeD1(); const env = ENV(DB);
  const state = await startAndGetState(env);
  const g = fakeGoogle({ email: "reilly.eagan@gmail.com" });
  const res = await handleGoogleCallback(new Request(`https://b/oauth/google/callback?code=c&state=${state}`), env, { fetchImpl: g.fetchImpl });
  assert.equal(res.status, 403);
  assert.equal(await DB.prepare(`SELECT COUNT(*) AS n FROM oauth_tokens`).first().then((r) => r.n), 0);
});

test("google: token-step failure never echoes Google's body; unticked boxes are reported", async () => {
  _resetGoogleCacheForTests();
  const DB = makeD1(); const env = ENV(DB);
  let state = await startAndGetState(env);
  const bad = await handleGoogleCallback(new Request(`https://b/oauth/google/callback?code=c&state=${state}`), env, { fetchImpl: fakeGoogle({ tokenStatus: 401 }).fetchImpl });
  const html = await bad.text();
  assert.equal(bad.status, 502);
  assert.ok(!html.includes("GOCSPX"));
  state = await startAndGetState(env);
  const partial = await handleGoogleCallback(new Request(`https://b/oauth/google/callback?code=c&state=${state}`), env,
    { fetchImpl: fakeGoogle({ scope: "openid email https://www.googleapis.com/auth/gmail.modify" }).fetchImpl });
  assert.equal(partial.status, 200);
  const st = await googleStatus(DB);
  assert.deepEqual(st.missing, ["Google Ads", "Merchant Center", "Sheets"]);
});

test("google: access tokens are refreshed from the stored token and cached", async () => {
  _resetGoogleCacheForTests();
  const DB = makeD1(); const env = ENV(DB);
  await assert.rejects(getGoogleAccessToken(env), (e) => e.code === "NOT_WIRED");
  const { enc_token, iv } = await encryptToken(env, "1//refresh-xyz");
  await DB.prepare(`INSERT INTO oauth_tokens (provider, account, scopes, enc_token, iv, created_at) VALUES ('google','reillyworking26@gmail.com','x',?,?,'t')`).bind(enc_token, iv).run();
  const g = fakeGoogle();
  assert.equal(await getGoogleAccessToken(env, { fetchImpl: g.fetchImpl }), "ya29.refreshed");
  await getGoogleAccessToken(env, { fetchImpl: g.fetchImpl });
  assert.equal(g.calls.length, 1, "second call served from cache");
});

test("connections: names and true/false only", () => {
  const p = secretPresence({ MC_KEY: "secret-value", ANTHROPIC_API_KEY: "sk-ant-x" });
  assert.equal(p.MC_KEY, true);
  assert.equal(p.TRACKING_API_KEY, false);
  assert.ok(!JSON.stringify(p).includes("secret-value"));
});

test("review fixes: a failing reconnect never overwrites a working token; status needs verification", async () => {
  _resetGoogleCacheForTests();
  const DB = makeD1(); const env = ENV(DB);
  let state = await startAndGetState(env);
  await handleGoogleCallback(new Request(`https://b/oauth/google/callback?code=c&state=${state}`), env, { fetchImpl: fakeGoogle().fetchImpl });
  const before = await DB.prepare(`SELECT enc_token FROM oauth_tokens`).first();
  // Reconnect where the Gmail check fails.
  const g = fakeGoogle({ refresh: "1//new-bad" });
  const bad = async (url, init) => url.includes("gmail/v1") ? new Response("{}", { status: 403 }) : g.fetchImpl(url, init);
  state = await startAndGetState(env);
  const res = await handleGoogleCallback(new Request(`https://b/oauth/google/callback?code=c&state=${state}`), env, { fetchImpl: bad });
  assert.equal(res.status, 502);
  const after = await DB.prepare(`SELECT enc_token FROM oauth_tokens`).first();
  assert.equal(after.enc_token, before.enc_token, "working token kept");
  const st = await googleStatus(DB);
  assert.equal(st.connected, true);
  assert.equal(st.account, "reillyworking26@gmail.com");
  await DB.prepare(`UPDATE oauth_tokens SET verified_at = NULL`).run();
  assert.equal((await googleStatus(DB)).connected, false);
});

test("store inbox: H&C info@ connects to its own slot with Gmail-only scope; main account refused there", async () => {
  _resetGoogleCacheForTests();
  const { mailboxStatus } = await import("../src/lib/google.js");
  const DB = makeD1(); const env = ENV(DB);
  const r = await startGoogleConnect(env, { target: "hc" });
  assert.equal(r.ok, true);
  const u = new URL(r.url);
  assert.equal(u.searchParams.get("login_hint"), "info@holtandcrane.com");
  assert.ok(!u.searchParams.get("scope").includes("adwords"), "inbox asks for Gmail only");
  // Signing in with the main account on the H&C slot is refused.
  const wrong = await handleGoogleCallback(new Request(`https://b/oauth/google/callback?code=c&state=${u.searchParams.get("state")}`), env,
    { fetchImpl: fakeGoogle({ email: "reillyworking26@gmail.com", scope: "openid email https://www.googleapis.com/auth/gmail.modify" }).fetchImpl });
  assert.equal(wrong.status, 403);
  const r2 = await startGoogleConnect(env, { target: "hc" });
  const st2 = new URL(r2.url).searchParams.get("state");
  const ok = await handleGoogleCallback(new Request(`https://b/oauth/google/callback?code=c&state=${st2}`), env,
    { fetchImpl: fakeGoogle({ email: "info@holtandcrane.com", scope: "openid email https://www.googleapis.com/auth/gmail.modify" }).fetchImpl });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Holt &amp; Crane inbox connected/);
  const row = await DB.prepare(`SELECT provider, account FROM oauth_tokens`).first();
  assert.deepEqual({ ...row }, { provider: "google:hc", account: "info@holtandcrane.com" });
  const boxes = await mailboxStatus(env);
  assert.equal(boxes.find((b) => b.store === "hc").connected, true);
  assert.deepEqual(boxes.find((b) => b.store === "hc").missing, []);
  assert.equal(boxes.find((b) => b.store === "aub").mailbox, null);
  // main slot untouched
  assert.equal((await googleStatus(DB)).connected, false);
  // unknown target refused
  assert.equal((await startGoogleConnect(env, { target: "aub" })).ok, false);
});
