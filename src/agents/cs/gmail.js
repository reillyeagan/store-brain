/**
 * Gmail REST helpers for Customer Service.
 *
 * Reading: messages.list, messages.get, threads.get. Writing: ONLY users.drafts.create, and only
 * when the caller has checked CS_DRAFTS_LIVE === "1". Nothing here sends, labels, archives or
 * deletes mail (shadow; spec decision 2: every reply is a Gmail draft Reilly sends himself).
 */
const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

async function gget(token, path, { fetchImpl }) {
  const res = await fetchImpl(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) {
    const e = new Error(`Gmail ${path.split("?")[0]} failed (HTTP ${res.status})`);
    e.status = res.status;
    throw e;
  }
  return body;
}

/**
 * The Gmail search for one inbox. Not "in:inbox": mail Reilly already archived still counts.
 * Never his own sent mail or drafts (-from:me -in:sent -in:drafts), never the marketing tabs.
 * Reilly's main inbox is narrowed to mail sent to the store domains it serves, plus Shopify
 * (contact forms); the code filter (filters.js) still decides.
 * @param {string[]|null} domains null = a store's own inbox (no narrowing)
 */
export function inboxQuery(afterMs, domains = null) {
  const base = `-from:me -in:sent -in:drafts -in:chats -category:promotions -category:social -category:forums after:${Math.floor(afterMs / 1000)}`;
  if (!domains) return base;
  const who = [...domains.flatMap((d) => [`to:${d}`, `deliveredto:${d}`]), "from:shopify.com"];
  return `${base} {${who.join(" ")}}`;
}

/**
 * Message ids matching `q`, newest first, following nextPageToken up to `maxPages` pages.
 * Returns { ids, complete } — complete = false means older matches exist beyond what was listed.
 */
export async function listIds(token, { q, perPage = 500, maxPages = 5, fetchImpl = fetch }) {
  const ids = [];
  let pageToken = null, pages = 0;
  do {
    const body = await gget(token, `/messages?maxResults=${perPage}&q=${encodeURIComponent(q)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, { fetchImpl });
    for (const m of body.messages || []) ids.push({ id: m.id, threadId: m.threadId });
    pageToken = body.nextPageToken || null;
    pages++;
  } while (pageToken && pages < maxPages);
  return { ids, complete: !pageToken, pages };
}

export const getMessage = (token, id, { fetchImpl = fetch }) => gget(token, `/messages/${encodeURIComponent(id)}?format=full`, { fetchImpl });
export const getThread = (token, id, { fetchImpl = fetch }) => gget(token, `/threads/${encodeURIComponent(id)}?format=full`, { fetchImpl });
export const getDraft = (token, id, { fetchImpl = fetch }) => gget(token, `/drafts/${encodeURIComponent(id)}?format=metadata`, { fetchImpl });

/** Create a threaded reply DRAFT. Never sends. Returns { id, threadId }. */
export async function createReplyDraft(token, { threadId, to, subject, inReplyTo, body }, { fetchImpl = fetch }) {
  // Header values come from the customer's email: strip line breaks so nothing can be injected.
  const one = (s) => String(s || "").replace(/[\r\n]+/g, " ").trim();
  const subj = one(subject);
  const fullSubject = /^re:/i.test(subj) ? subj : `Re: ${subj}`;
  const lines = [
    `To: ${one(to)}`,
    `Subject: ${encodeHeader(fullSubject)}`,
    ...(inReplyTo ? [`In-Reply-To: ${one(inReplyTo)}`, `References: ${one(inReplyTo)}`] : []),
    "Content-Type: text/plain; charset=UTF-8",
    "MIME-Version: 1.0",
    "",
    body,
  ];
  const raw = b64urlEncode(lines.join("\r\n"));
  const res = await fetchImpl(`${BASE}/drafts`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ message: { raw, threadId } }),
  });
  const out = await res.json().catch(() => null);
  if (!res.ok || !out || !out.id) throw new Error(`Gmail draft create failed (HTTP ${res.status})`);
  return { id: out.id, threadId: out.message && out.message.threadId };
}

/** RFC 2047: a subject with non-ASCII characters must be encoded or it arrives garbled. */
function encodeHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64std(s)}?=`;
}

function b64std(text) {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/* ---------- parsing ---------- */

export function headerMap(msg) {
  const out = {};
  for (const h of (msg && msg.payload && msg.payload.headers) || []) {
    const k = String(h.name || "").toLowerCase();
    out[k] = out[k] ? `${out[k]}, ${h.value}` : String(h.value || "");
  }
  return out;
}

/** "Jane Doe <jane@x.com>" → { name, email } (first address only). */
export function parseAddress(s) {
  const str = String(s || "");
  const m = str.match(/<([^>]+)>/);
  const email = (m ? m[1] : (str.match(/[^\s,;<>"]+@[^\s,;<>"]+/) || [""])[0]).trim().toLowerCase();
  const name = m ? str.slice(0, m.index).replace(/["']/g, "").trim() : "";
  return { name, email };
}

export function allAddresses(s) {
  return (String(s || "").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map((x) => x.toLowerCase());
}

export function b64urlDecode(data) {
  const s = String(data || "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function b64urlEncode(text) {
  return b64std(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The plain-text body: text/plain if present, else text/html with tags stripped. */
export function bodyText(msg) {
  let plain = null, html = null;
  const walk = (p) => {
    if (!p) return;
    const type = String(p.mimeType || "").toLowerCase();
    if (p.body && p.body.data) {
      if (type === "text/plain" && plain == null) plain = b64urlDecode(p.body.data);
      else if (type === "text/html" && html == null) html = b64urlDecode(p.body.data);
    }
    for (const c of p.parts || []) walk(c);
  };
  walk(msg && msg.payload);
  if (plain != null) return plain;
  if (html != null) {
    return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n");
  }
  return (msg && msg.snippet) || "";
}

/** Drop the quoted history under a reply, so the AI reads only what the customer just wrote. */
export function stripQuoted(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (const line of lines) {
    if (/^On .{5,200} wrote:\s*$/.test(line.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (/^From: .+/.test(line.trim()) && out.length > 2) break;
    if (/^>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
