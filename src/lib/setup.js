/**
 * One-time setup actions, run from Mission Control's Setup panel.
 *
 * checkStores()      — for each live store: mint a token, confirm the shop domain
 *                      (Store Guard) and list the scopes Shopify actually granted.
 * registerWebhooks() — subscribe each store's app to orders/create, orders/updated
 *                      and refunds/create, pointing at this worker. Idempotent:
 *                      existing subscriptions are kept, and the result is verified
 *                      by listing subscriptions again afterwards.
 */
import { LIVE_STORE_IDS, STORES, SHOPIFY_SCOPES_READ } from "../config/stores.js";
import { assertShop, shopifyGraphQL } from "./storeGuard.js";
import { logEvent } from "./eventlog.js";

export const WEBHOOK_TOPICS = Object.freeze(["ORDERS_CREATE", "ORDERS_UPDATED", "REFUNDS_CREATE"]);

const LIST_SUBS = `{ webhookSubscriptions(first: 100) { nodes { id topic uri } } }`;

const CREATE_SUB = `mutation($topic: WebhookSubscriptionTopic!, $uri: String!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) {
    webhookSubscription { id topic uri }
    userErrors { field message }
  }
}`;

export async function checkStores(env, opts = {}) {
  const results = [];
  for (const id of LIVE_STORE_IDS) {
    const store = STORES[id];
    try {
      const shop = await assertShop(env, id, opts);
      const data = await shopifyGraphQL(env, id, `{ currentAppInstallation { accessScopes { handle } } }`, {}, opts);
      const granted = (data.currentAppInstallation?.accessScopes || []).map((s) => s.handle).sort();
      const missing = SHOPIFY_SCOPES_READ.filter((s) => !granted.includes(s));
      results.push({ store: id, name: store.name, ok: true, domain: shop.domain, shopName: shop.name, granted, missing });
      await logEvent(env.DB, {
        actor: "svc.store_guard", kind: "store.verified", store: id, target: "sys.shopify",
        summary: `${store.name}: connected and verified (${shop.domain})${missing.length ? `, missing scopes: ${missing.join(", ")}` : ""}`,
        data: { domain: shop.domain, missing },
      });
    } catch (err) {
      results.push({ store: id, name: store.name, ok: false, code: err.code || "ERROR", error: err.message });
      await logEvent(env.DB, {
        actor: "svc.store_guard", kind: "store.check_failed", store: id, target: "sys.shopify",
        summary: `${store.name}: connection check failed: ${err.message}`, data: { code: err.code || null },
      });
    }
  }
  return results;
}

export async function registerWebhooks(env, baseUrl, opts = {}) {
  const uri = `${baseUrl}/webhooks/shopify`;
  const results = [];
  for (const id of LIVE_STORE_IDS) {
    const store = STORES[id];
    const r = { store: id, name: store.name, created: [], existing: [], errors: [], verified: false };
    try {
      await assertShop(env, id, opts);
      const before = (await shopifyGraphQL(env, id, LIST_SUBS, {}, opts)).webhookSubscriptions.nodes;
      for (const topic of WEBHOOK_TOPICS) {
        if (before.some((s) => s.topic === topic && s.uri === uri)) {
          r.existing.push(topic);
          continue;
        }
        const out = (await shopifyGraphQL(env, id, CREATE_SUB, { topic, uri }, opts)).webhookSubscriptionCreate;
        if (out.userErrors && out.userErrors.length) r.errors.push(`${topic}: ${out.userErrors.map((e) => e.message).join("; ")}`);
        else r.created.push(topic);
      }
      // Verify against Shopify, not against our own create calls.
      const after = (await shopifyGraphQL(env, id, LIST_SUBS, {}, opts)).webhookSubscriptions.nodes;
      r.verified = WEBHOOK_TOPICS.every((t) => after.some((s) => s.topic === t && s.uri === uri));
    } catch (err) {
      r.errors.push(err.message);
    }
    results.push(r);
    await logEvent(env.DB, {
      actor: "svc.write_verifier", kind: r.verified ? "webhooks.verified" : "webhooks.failed", store: id, target: "sys.shopify",
      summary: r.verified
        ? `${store.name}: order + refund notifications connected and verified`
        : `${store.name}: notifications NOT verified${r.errors.length ? `: ${r.errors.join(" | ")}` : ""}`,
      data: { created: r.created, existing: r.existing, errors: r.errors },
    });
  }
  return results;
}
