# Setup guide — first deploy of the Store Brain (Phase 1)

Do these in order. Each step says **who** does it. Reilly does every step that involves an account, a password, a key, or a deploy. Claude never sees a secret.

Nothing here touches a live store. Phase 1 is read-only.

---

## 1. Shopify: one app per live store (Reilly · ~5 min per store)

**Each store must have its own app** (the brain refuses two stores sharing one app secret, because a shared secret would let one store's webhook be accepted as another's). Same method as the Eagano dash's Marlowe app (see the vault note "WIRING A NEW STORE — Shopify app + token"), but **new apps**, so the Store Brain never shares credentials with the Eagano dash.

For each of **Holt & Crane, Auberlane, Marlowe Standard**:

1. Go to **dev.shopify.com** (Shopify Dev Dashboard), in the **same organization as the store**. Client credentials only work when the app and the store are in the same org.
2. **Apps → Create app.** Name it `Store Brain — Holt & Crane` (or the store's name).
3. Set the scopes. All read-only; the brain can look but not change anything. Write access is added later, one department at a time, each with your OK:
   ```
   read_orders
   read_all_orders
   read_products
   read_inventory
   read_reports
   read_shopify_payments_payouts
   read_shopify_payments_accounts
   read_shopify_payments_disputes
   read_customers
   read_fulfillments
   read_merchant_managed_fulfillment_orders
   read_returns
   read_discounts
   read_themes
   ```
   If Shopify refuses `read_all_orders` (it sometimes needs a request), leave it out. Everything else still works; history then goes back 60 days.
4. **Release a version**, then **install** it on that store.
5. Open **Client credentials**. Leave this tab open for step 3 below. **Don't paste these anywhere except Cloudflare.**

> ⛔ Don't use Settings → Apps → "App development" in the store admin. Shopify retired that route for this org; it only points back to the Dev Dashboard.

## 2. Cloudflare: create the database and backup bucket (Reilly runs, Claude prepares)

On your PC, in the `store-brain` folder (Claude will give you a one-click `.bat` for this, like the Eagano dash's deploy file):

```
npx wrangler d1 create store-brain-ledger
npx wrangler r2 bucket create store-brain-backups
```

The first command prints a `database_id`. Tell Claude the id (it isn't a secret) and Claude puts it in `wrangler.toml`.

Then create the ledger tables:

```
npx wrangler d1 migrations apply store-brain-ledger --remote
```

## 3. Cloudflare: add the secrets (Reilly · ~5 min)

Cloudflare dashboard → **Workers & Pages → store-brain → Settings → Variables and Secrets → Add**. Choose **Secret** (encrypted), not plain text.

| Secret | What it is |
|---|---|
| `SB_HC_CLIENT_ID` / `SB_HC_CLIENT_SECRET` | Holt & Crane app, from step 1 |
| `SB_AUB_CLIENT_ID` / `SB_AUB_CLIENT_SECRET` | Auberlane app |
| `SB_MAR_CLIENT_ID` / `SB_MAR_CLIENT_SECRET` | Marlowe Standard app |
| `MC_KEY` | Your Mission Control key. Make up a long random password (32+ characters) and keep it in your password manager. |
| `APPROVAL_SIGNING_KEY` | Another long random password. Signs the approval links sent to your phone. |
| `PUSHOVER_USER_KEY` / `PUSHOVER_APP_TOKEN` | Your Pushover keys (step 5), added with `5 ADD PUSHOVER KEYS.bat`. |

> If a secret is ever pasted into a chat, rotate it (make a new one) right away.

## 4. Deploy (Reilly runs one file)

```
npx wrangler deploy
```

Claude will provide `DEPLOY STORE BRAIN.bat`, so this becomes a double-click. Then open `https://store-brain.<your-subdomain>.workers.dev/health`. It should say `"ok": true`.

## 5. Phone notifications (Reilly · 2 min)

ntfy.sh refused every connection from Cloudflare (HTTP 522), so the phone channel is **Pushover** (decided 2026-10-11).

1. Install **Pushover** on your phone and create an account (30-day free trial, then $5 one-time).
2. On pushover.net, log in: your **User Key** is top right.
3. Under **Your Applications**, create one named "Store Brain" and copy its **API Token**.
4. Double-click `5 ADD PUSHOVER KEYS.bat` and paste both (hidden as you paste).
5. Mission Control → Setup → **Send test notification**.

Approvals arrive as a notification with an **Open to decide** link: a small signed page with one button per choice.

## 6. Shopify webhooks (Claude prepares, Reilly approves)

So orders show up in seconds for every store, each store's app subscribes to `orders/create`, `orders/updated` and `refunds/create`, delivered to:

```
https://store-brain.<your-subdomain>.workers.dev/webhooks/shopify
```

Every webhook is checked with that store's own app secret before anything is saved; forged or cross-store calls are rejected.

## 7. Check it (together)

Open Mission Control at `https://store-brain.<your-subdomain>.workers.dev/` and enter your `MC_KEY`. (Bookmark `…/#key=YOUR_KEY` to skip the prompt; the part after `#` never leaves your browser.)
- **Feeds** tab: each store's orders feed turns **Fresh** after its first order or pull.
- **Activity** tab: every order appears within seconds, with the store's name.
- Nothing writes to any store in Phase 1.

**Gate to finish Phase 1:** real data from all three live stores, feeds green, and you confirm the numbers look right.
