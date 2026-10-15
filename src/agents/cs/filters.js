/**
 * Is this email a customer writing to one of the stores? Plain code, no AI: a right answer
 * exists for most mail (a Judge.me notification is never a customer).
 *
 * Ignored (spec + task): Judge.me review notifications (Reilly: "dont follow up on reviews"),
 * marketing / bulk mail, automated senders, Shopify's own notifications, the brain's own
 * notifications, mail from the stores themselves. In Reilly's main inbox only mail addressed to
 * a store (or a Shopify contact form naming one) counts: that inbox also holds his personal and
 * business mail, which is none of CS's business.
 */
import { STORES } from "../../config/stores.js";
import { STORE_MAIL_DOMAINS, STORE_ALIASES } from "./config.js";
import { parseAddress, allAddresses } from "./gmail.js";

const SKIP_LABELS = ["SENT", "DRAFT", "SPAM", "TRASH", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"];
const AUTOMATED_LOCAL = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|alerts?|bounce[s]?|news(letter)?|marketing|updates?)([+.-].*)?$/i;
// Services that write to Reilly's inbox but are never customers.
const SERVICE_DOMAINS = /(^|\.)(judge\.me|google\.com|googlemail\.com|pushover\.net|cloudflare\.com|anthropic\.com|facebookmail\.com|paypal\.com|stripe\.com|klaviyo\.com|17track\.net)$/i;

const domainOf = (email) => String(email || "").split("@")[1] || "";

function storeForDomain(domain) {
  const d = String(domain || "").toLowerCase();
  for (const [id, dom] of Object.entries(STORE_MAIL_DOMAINS)) if (d === dom || d.endsWith(`.${dom}`)) return id;
  return null;
}

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "MS (Shopify)" → the store whose alias is exactly "MS" (case-insensitive), else null. */
export function storeForShopifySender(name) {
  const n = String(name || "").replace(/\(\s*shopify\s*\)/i, "").trim().toLowerCase();
  if (!n) return null;
  const hits = Object.entries(STORE_ALIASES).filter(([, names]) => names.some((x) => x.toLowerCase() === n)).map(([id]) => id);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Which store a customer was replying to, from the quoted mail under their reply (the whole body,
 * quotes included). Only markers a store's own mail leaves: a Judge.me request address
 * (requests+holtandcrane.com@judge.me), a store address (@auberlane.com), or a quoted header
 * line naming the store ("From: H&C <...>", "Marlowe Standard <...> wrote:"). Exactly one store
 * or nothing. Why: Marlowe's and Auberlane's customer mail, and replies to Judge.me requests,
 * arrive at Reilly's own address (live 2026-10-15: a return request was never read).
 */
export function storeFromQuoted(fullBody) {
  const t = String(fullBody || "");
  const found = new Set();
  for (const m of t.matchAll(/requests\+([a-z0-9.-]+)@judge\.me/gi)) { const s = storeForDomain(m[1]); if (s) found.add(s); }
  // Only the quoted header lines of mail the store SENT: "From: X <addr>" / "Reply-To: ..." at
  // the start of a line, and "On ..., X <addr> wrote:". A store address mentioned anywhere else
  // ("contact support@auberlane.com" in a supplier's mail) doesn't count.
  const lines = t.split(/\r?\n/);
  const headerLines = lines.filter((l) => /^\s*>*\s*(from|reply-to|de|von)\s*:/i.test(l));
  const wroteLines = lines.filter((l) => /\bwrote:\s*$/i.test(l));
  for (const l of [...headerLines, ...wroteLines]) for (const a of allAddresses(l)) { const s = storeForDomain(domainOf(a)); if (s) found.add(s); }
  for (const [id, names] of Object.entries(STORE_ALIASES)) {
    for (const nm of names) {
      const n = esc(nm);
      // The name must stand alone as the sender's name: "From: H&C <...>", "..., Marlowe Standard <...> wrote:".
      const header = new RegExp(`^\\s*>*\\s*(from|reply-to|de|von)\\s*:\\s*"?${n}"?\\s*<`, "i");
      const wrote = new RegExp(`(^|[\\s,])"?${n}"?\\s*<[^>]+>\\s*wrote:\\s*$`, "i");
      if (headerLines.some((l) => header.test(l)) || wroteLines.some((l) => wrote.test(l))) found.add(id);
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * @param {{headers:object, labelIds?:string[], body?:string, fullBody?:string}} mail headers = lower-cased map
 * @param {{slot:string, stores:string[], own:boolean}} inbox
 * @param {string|null} inboxAccount the Gmail account behind the slot
 * @returns {{keep:false, reason:string} | {keep:true, store:string|null, via:string, replyTo:string, fromName:string}}
 */
export function screenMail({ headers, labelIds = [], body = "", fullBody = null }, inbox, inboxAccount = null) {
  const h = headers || {};
  const no = (reason) => ({ keep: false, reason });
  if (labelIds.some((l) => SKIP_LABELS.includes(l))) return no("not inbox mail (sent/draft/spam/marketing tab)");

  const from = parseAddress(h.from);
  const fromDomain = domainOf(from.email);
  const subject = String(h.subject || "");
  if (!from.email) return no("no sender");
  if (inboxAccount && from.email === String(inboxAccount).toLowerCase()) return no("sent by this inbox");

  // Reviews: "dont follow up on reviews" (Reilly, 2026-10-11).
  if (/judge\.me/i.test(fromDomain) || /judge\.me/i.test(String(h["reply-to"] || "")) || (/review/i.test(subject) && /judge\.?me/i.test(body))) {
    return no("review notification (Judge.me)");
  }
  if (/store brain/i.test(subject) || /store brain/i.test(from.name)) return no("the brain's own notification");

  // Shopify contact form: comes from Shopify, the customer is in Reply-To.
  const isShopify = /(^|\.)shopify\.com$/i.test(fromDomain);
  const contactForm = isShopify && /(new customer message|contact form|customer message)/i.test(subject);
  if (isShopify && !contactForm) return no("Shopify notification");

  if (!contactForm) {
    if (h["list-unsubscribe"] || h["list-id"] || /^(bulk|list|junk)$/i.test(String(h.precedence || "").trim())) return no("marketing / mailing list");
    if (h["auto-submitted"] && !/^no$/i.test(String(h["auto-submitted"]).trim())) return no("automated message");
    if (AUTOMATED_LOCAL.test(from.email.split("@")[0])) return no("automated sender");
    if (SERVICE_DOMAINS.test(fromDomain)) return no("service notification");
    if (storeForDomain(fromDomain)) return no("sent from a store address");
  }

  const replyTo = contactForm ? parseAddress(h["reply-to"]).email : (parseAddress(h["reply-to"]).email || from.email);
  if (!replyTo) return no("contact form without a customer address");
  const fromName = contactForm ? (parseAddress(h["reply-to"]).name || "") : from.name;
  const via = contactForm ? "contact_form" : "email";

  // A store's own inbox: everything that survived the filters is that store's.
  if (inbox.own) return { keep: true, store: inbox.stores[0], via, replyTo, fromName };

  // Reilly's main inbox: which store was it written to?
  const rcpts = allAddresses([h.to, h.cc, h["delivered-to"], h["x-original-to"], h["x-forwarded-to"], h["x-forwarded-for"]].filter(Boolean).join(" "));
  let store = null;
  for (const a of rcpts) { const s = storeForDomain(domainOf(a)); if (s) { store = s; break; } }
  if (!store && contactForm) {
    // Shopify's contact-form mail comes from "<shop short name> (Shopify)"; older ones name the
    // shop in the text.
    store = storeForShopifySender(from.name);
    if (!store) {
      const hay = `${subject}\n${body}`.toLowerCase();
      const hits = Object.values(STORES).filter((s) => s.live && hay.includes(s.name.toLowerCase()));
      if (hits.length === 1) store = hits[0].id;
    }
  }
  // A customer replying (at Reilly's own address) to mail one store sent them. This mail only
  // exists in this inbox (it wasn't sent to the store's address), so it is read here even for a
  // store with its own inbox.
  let quoted = false;
  // Not for a forward ("Fwd:"): that is someone passing a store's mail on (a supplier, Guy), not a
  // customer replying to it.
  if (!store && !contactForm && !/^\s*(fwd?|fw)\s*:/i.test(subject)) { store = storeFromQuoted(fullBody != null ? fullBody : body); quoted = !!store; }
  if (!store) return no("not addressed to a store");
  if (!quoted && !inbox.stores.includes(store)) return no(`read in ${STORES[store].name}'s own inbox`);
  return { keep: true, store, via, replyTo, fromName };
}
