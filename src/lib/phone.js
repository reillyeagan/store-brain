/**
 * Phone channel — Pushover.
 *
 * Why Pushover: ntfy.sh refused every connection from Cloudflare's servers (HTTP 522
 * on each try, while ntfy.sh itself was healthy). Reilly chose Pushover (2026-10-11).
 *
 * Pushover can attach one link per message, not buttons. So an approval arrives as a
 * notification whose link opens a small signed page (/approve/:id) with the choices.
 *
 * Secrets (Reilly pastes these into Cloudflare; never in this repo, never in chat):
 *   PUSHOVER_APP_TOKEN   the "Store Brain" application's API token
 *   PUSHOVER_USER_KEY    Reilly's user key
 */
import { signDecision, LINK_TTL_MS } from "./approvals.js";

const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";

export function phoneReady(env) {
  return !!(env.PUSHOVER_APP_TOKEN && env.PUSHOVER_USER_KEY);
}

/**
 * Send one message. Returns { sent, reason? }. Errors are reported in fixed words:
 * a raw error or response could echo the keys, and this result ends up on Mission Control.
 */
export async function sendPhone(env, { title, message, url = null, urlTitle = null, priority = 0 }, { fetchImpl = fetch } = {}) {
  if (!phoneReady(env)) return { sent: false, reason: "Pushover keys are not set in Cloudflare yet" };
  const form = new URLSearchParams({
    token: env.PUSHOVER_APP_TOKEN,
    user: env.PUSHOVER_USER_KEY,
    title: String(title).slice(0, 250),
    message: String(message).slice(0, 1024),
    priority: String(priority),
  });
  if (url) {
    form.set("url", url);
    form.set("url_title", String(urlTitle || "Open").slice(0, 100));
  }
  let res;
  try {
    res = await fetchImpl(PUSHOVER_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch {
    return { sent: false, reason: "couldn't reach Pushover" };
  }
  const body = await res.json().catch(() => null);
  // Pushover's own receipt: status 1 means it accepted the message for delivery.
  if (res.ok && body && body.status === 1) return { sent: true };
  if (res.status === 400) return { sent: false, reason: "Pushover rejected the keys (check PUSHOVER_APP_TOKEN and PUSHOVER_USER_KEY)" };
  if (res.status === 429) return { sent: false, reason: "Pushover monthly limit reached" };
  return { sent: false, reason: `Pushover answered HTTP ${res.status}` };
}

/** Setup tab: one plain message. Pushover accepting it is not proof; Reilly seeing it is. */
export function sendTestNotification(env, opts) {
  return sendPhone(env, {
    title: "Store Brain: test notification",
    message: "If you can read this on your phone, approvals and alerts will reach you.",
  }, opts);
}

/** Signed link to the phone approval page. The page itself carries a signed link per choice. */
export async function approvalPageUrl(env, approval, baseUrl, nowMs = Date.now()) {
  const exp = nowMs + LINK_TTL_MS;
  const sig = await signDecision(env.APPROVAL_SIGNING_KEY, approval, "view", exp);
  return `${baseUrl}/approve/${approval.id}?exp=${exp}&sig=${sig}`;
}

/** Push an approval to Reilly's phone. Returns {sent:false} (not an error) when the phone isn't set up. */
export async function notifyPhone(env, approval, { baseUrl, fetchImpl = fetch } = {}) {
  if (!phoneReady(env) || !env.APPROVAL_SIGNING_KEY || !baseUrl) return { sent: false, reason: "phone not set up" };
  return sendPhone(env, {
    title: `Store Brain: ${approval.title}`,
    message: approval.options.map((o) => `• ${o.label}${o.detail ? ` — ${o.detail}` : ""}`).join("\n"),
    url: await approvalPageUrl(env, approval, baseUrl),
    urlTitle: "Open to decide",
  }, { fetchImpl });
}
