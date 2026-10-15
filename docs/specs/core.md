# Core — spec v1 (2026-10-11)

Router · Briefer · Approvals Desk (built) · Decision Keeper · Librarian · Auditor · Incident Desk.

## Morning brief — 8:00 Eastern
**Approved by Reilly, 2026-10-11:** "looks good". Pushover at 8:00 → opens the full brief in Mission Control.
1. **Yesterday's money:** revenue, ad spend, COGS, refunds, real profit — per store and combined.
2. **Waiting on you:** pricing approval, KFB copy-paste message, CS drafts in Gmail, escalations.
3. **Orders:** new orders, size-ups applied, anything late or failed.
4. **Risk:** only if something happened.
5. **Media:** what Guy changed and the brain's read on it.
6. **Feeds:** anything stale, so Reilly knows which numbers to trust.

**Voice (Reilly, 2026-10-11):** "similar to the eagano brain, short and concise while getting the info across and giving a lot of data and reasoning."

Manager name: still open.

## Knowledge: Store Brain ↔ Eagano
**Reilly, 2026-10-11:** "yes copy everything we have about the stores into the new store brain, and yes that split sounds good. but new information should go into both the store brain and eagano, because eagano is how i make changes and build things, and it is the TRUE ultimate data hub for EVERYTHING"

- **Seed (once):** copy everything about the stores from the vault into the Core (`core_facts` and friends): pricing rules, CS playbook, size/sizing history, problem products, policies, past decisions (verbatim), P&L conventions, KFB method locks. Each fact keeps its vault source path.
- **Split:** the Store Brain is the source of truth for *running* the stores; **Eagano is the ultimate hub for everything**, including all store information.
- **Both directions, always:**
  - **Store Brain → Eagano:** every brief, decision, new fact and notable event is published to a vault feed; Eagano files it into the vault (same RAW-FIRST rule as the Capture Protocol). Nothing the Store Brain learns lives only in the Store Brain.
  - **Eagano → Store Brain:** when Reilly changes a store rule or builds something through Eagano, Eagano posts it to the Core so the agents use it.
- Mechanism (feed endpoint + read-only sync key, and how Eagano posts back) is designed in the build plan; no secret is ever written to the vault.

## Go-live (2026-10-14)
**Reilly, 2026-10-14 20:46 New York (decision `core.go_live`):** "i want to move EVERYTHING in the brain to live so its all working - can we do that"

Live within his standing decisions, which go-live does not change:
- **Shopify stays read-only.** Write access is a separate project that needs Reilly.
- **Customer emails stay Gmail DRAFTS** he reviews and sends (`cs.sending`: "drafts that i review and click send", until he says "start sending").
- **Supplier messages stay copy-paste** he sends himself (`sup.kfb_channel`).
- **Ads stay watch-only:** Guy runs the accounts (`media.role`).

The switches (all `"1"` in `wrangler.toml`, read in one place: `src/config/live.js`):

| Switch | Live means | Off (`"0"`) means |
|---|---|---|
| `GO_LIVE` | watching/reporting agents (Core, Media, Catalog, Risk, P&L, Fulfillment) are labelled live | labelled shadow (they still run) |
| `CS_DRAFTS_LIVE` | replies saved as Gmail drafts in the store inbox | drafts stay on the CS page |
| `BRIEF_PHONE_LIVE` | the 8:00 brief also goes to the phone | Mission Control only |
| `SUPPLIER_MESSAGES_LIVE` | the evening KFB message goes to the phone to copy-paste | Mission Control only |
| `KFB_REMINDER_LIVE` | one 9:00 phone reminder when no KFB import landed | logged only |
| `PHONE_ALERTS_LIVE` | urgent phone alerts (below) | logged only (`phone.alert_shadow`) |

To turn one off: Cloudflare dashboard → Workers & Pages → store-brain → Settings → Variables and Secrets → `"0"` → Deploy. `keep_vars = true` keeps only dashboard variables that `wrangler.toml` does not list, so the next code deploy writes these back to `"1"` unless `wrangler.toml` says `"0"` too.

## Urgent phone alerts (`src/lib/phoneAlerts.js`)
One notifier on the 15-minute cron reads new events by kind from the Event Log (cursor `agent_cursors.phone_alerts`) and pushes only the urgent ones:
- a chargeback whose evidence is due within 48 h (`risk.dispute_reminder`, 2 days or fewer left);
- a spend alarm, once per type per store per day (`media.spend_alarm`; `stopped` is the Auberlane-style "money stopped going out");
- a HIGH fraud flag (`risk.order_high`);
- an incident the Incident Desk asks Reilly about (`approval.requested` from `core.incidents`);
- a Store Guard stop (`STORE_MISMATCH`), a Gmail account guard stop, or a store timezone mismatch.

At most **6 a day** in total and **1 per item** (`phone_alerts.item_key` is unique; migration 0023). Over the cap an item is recorded as `capped` and stays on Mission Control. A send Pushover refuses is retried (3 tries, same day). Each alert links to the signed approval page when there is a pending approval, otherwise to the right Mission Control page. Text is built from safe parts only (store, order number, amount, dates, agent ids) and scrubbed of email addresses: no names, no emails, no secrets.
