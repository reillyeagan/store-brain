# Setup guide — first deploy of the Store Brain (Phase 1)

Do these in order. Each step says **who** does it. Reilly does every step that involves an account, a password, a key, or a deploy. Claude never sees a secret.

Nothing here touches a live store. Phase 1 is read-only.

---

## 1. Shopify: one app per live store (Reilly · ~5 min per store)

Same method as the Eagano dash's Marlowe app (see the vault note "WIRING A NEW STORE — Shopify app + token"), but **new apps**, so the Store Brain never shares credentials with the Eagano dash.

For each of **Holt & Crane, Auberlane, Marlowe Standard**:

1. Go to **dev.shopify.com** (Shopify Dev Dashboard), in the **same organization as the store**. Client credentials only work when the app and the store are in the same org.
2. **Apps → Create app.** Name it `Store Brain — Holt & Crane` (or the store's name).
3. Set the scopes to exactly these five (Phase 1 is read-only):
   ```
   read_orders
   read_products
   read_reports
   read_shopify_payments_payouts
   read_shopify_payments_accounts
   ```
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
| `APPROVAL_SIGNING_KEY` | Another long random password. Signs the Approve/Reject buttons on your phone. |
| `NTFY_TOPIC` | A long random name for your private phone channel (step 5). |

> If a secret is ever pasted into a chat, rotate it (make a new one) right away.

## 4. Deploy (Reilly runs one file)

```
npx wrangler deploy
```

Claude will provide `DEPLOY STORE BRAIN.bat`, so this becomes a double-click. Then open `https://store-brain.<your-subdomain>.workers.dev/health`. It should say `"ok": true`.

## 5. Phone notifications (Reilly · 2 min)

1. Install **ntfy** on your phone (App Store / Play Store; free).
2. Subscribe to the topic name you chose for `NTFY_TOPIC`.

## 6. Shopify webhooks (Claude prepares, Reilly approves)

So orders show up in seconds for every store, each store's app subscribes to `orders/create`, `orders/updated` and `refunds/create`, delivered to:

```
https://store-brain.<your-subdomain>.workers.dev/webhooks/shopify
```

Every webhook is checked with that store's own app secret before anything is saved; forged or cross-store calls are rejected.

## 7. Check it (together)

Open Mission Control at `https://store-brain.<your-subdomain>.workers.dev/` and enter your `MC_KEY`.
- **Feeds** tab: each store's orders feed turns **Fresh** after its first order or pull.
- **Activity** tab: every order appears within seconds, with the store's name.
- Nothing writes to any store in Phase 1.

**Gate to finish Phase 1:** real data from all three live stores, feeds green, and you confirm the numbers look right.
