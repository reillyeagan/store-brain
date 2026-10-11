# Department spec — Supplier Relations (deep-dive draft v1, 2026-10-10)

**Mission:** nothing sells that can't be sourced, nothing gets lost between a customer and KungFuBuy, and Reilly always knows what changed and why.
**Why it matters:** supplier problems are where refunds start. 94% of H&C's refunded money was cancellations on unshipped orders (sourcing/speed), and Marlowe's denial rate is 23.7%.
**Channels:** (1) the **KFB morning session**: Reilly logs in and types the code, then agents read quotations, orders and bills, view only. (2) **WhatsApp** with the KFB agent, on a dedicated business number (Phase 3b). Bills are always paid by Reilly.

Legend: **CODE** = program, no AI · **AI** = Claude for judgement/language · L0 propose, L1 act + report, L2 quiet.

---

## The morning sweep (the department's heartbeat)
```
08:00 brief pings "KFB ready?" → Reilly logs in → one-click button reads KFB (view only)
   → Quote Desk (new quotes, status changes)        → Pricing proposals (Catalog)
   → Denial Sync (denied vs live products)          → draft proposals
   → "Similar ones" QC (quoted-with-remark)         → photo comparison for Reilly
   → Order-to-Supplier Watcher (Fulfillment)        → stuck / unpaid orders
   → COGS Matcher (P&L)                             → bills + suborders
   → Supplier Digest                                → one summary in the brief
```

---

## Workers

### 1. Quote Desk · CODE (+AI summary) · L1
- **Wakes:** morning sweep.
- **Does:** pulls all quotations per store, diffs against yesterday. Status map: 10 to-quote/priority · 25 awaiting *your* confirmation · 26 denied · 30 quoted · 40 unknown (flag). New quotes → Pricing proposals (Catalog, per-store rules). Keeps each store's "Quoted Products: Cost vs Price" sheet current via Sheets Writer.
- **Alerts:** a product **selling with no quote** (cost unknown) · status-25 items waiting on Reilly · status 40 · the quote queue size and age (H&C ~62 waiting).
- **Proposes:** quote priority by sales rank (best-sellers first).
- **Rules:** match by store link handle, never title or KFB SKU · KFB `un_good_price` is a stale snapshot, so store prices come from Shopify · cost = `manual_pricing…nameOne` (EUR).

### 2. Denial Sync · CODE · L0
- **Wakes:** after Quote Desk.
- **Does:** denied quote ids (status 26) vs live active products → "draft these N products" proposal, with KFB's reason (`order_remark`). Zeroing inventory does nothing on these stores, so drafting is the only stop.
- **Approval:** Reilly says "draft those" → Catalog's Product Status applies → Write-Verifier confirms (API status + storefront 404 + active count).

### 3. "Similar ones" QC · AI (vision) · L0
- **Wakes:** a quote arrives with an "only similar ones" remark.
- **Does:** puts KFB's/1688's photo beside the listing photos and gives a verdict draft: *close enough* / *update photos & copy* / *too different, draft it*. Reilly decides.

### 4. Supply Pre-flight · CODE · L0 gate
- **Wakes:** before any product is published (Catalog's Pre-Publish Gate calls it).
- **Does:** blocks products with no confirmed supply line (quoted, not denied). Flags the $179–189 tier that's largely unsourceable.

### 5. Relay · AI · L0 → L1
- **Wakes:** a ticket from CS (size, defect, swap, missing item) or Fulfillment (stuck order).
- **Does:** writes one clean WhatsApp message to the KFB agent: order #, SKU, photos, the exact ask. Tracks the reply and hands the answer back to the ticket that asked.
- **Approval:** every message approved by Reilly at first; categories go automatic after a clean run.

### 6. Supplier Digest · AI · L2
- **Wakes:** after the morning sweep + on urgent WhatsApp replies.
- **Writes:** what changed, **why**, and what Reilly must decide. Goes into the 8:00 brief.

### 7. Size-Chart Checker · CODE + AI (vision) · L0
- **Wakes:** first order of a product · a CS sizing question · new product before publish.
- **Does:** gets the chart from the 1688 listing (no login; description image #2) or asks via Relay. Converts per listing (house scale, ~5" ease), compares with the sizes the store lists (e.g. store S–5XL vs factory S–3XL), and proposes a size note or variant change. Saves every chart to the Core so it's asked once.

### 8. Sourcing Scout · AI · L0
- **Wakes:** a whole category fails (re-quotes come back higher, denials cluster, COGS > band), e.g. cardigans, jeans near 50% COGS.
- **Does:** proposes a new factory/listing to send KFB for quoting. Never re-quotes the same source.

### 9. Claims & Credits · CODE (+AI drafting) · L0
- **Does:** money KFB owes back: cancelled-but-billed orders (e.g. #1174, €18.15), defective items, wrong items. Drafts the claim message for Relay and tracks it until the credit appears on a bill.

---

## Rules every supplier agent inherits
- Absence in KFB means "not yet" until the day is closed. A failed probe (HTML instead of JSON) means retry and screenshot, never "logged out".
- KFB `refund_status` says nothing about the Shopify refund.
- Never send a customer a "similar" item without asking; offer it with a photo.
- Get the number before cancelling: KFB saying "too high" is not a cost.
- Never bypass a CAPTCHA; Reilly logs in.
- Data files hold only observations; inferences are labelled.

## Questions for Reilly
1. **How do products reach KFB for quoting?** Does KFB pull everything from the store automatically, or do you submit products? Can you set priority?
2. **Status 25 "confirm quotation":** what do you check before confirming? Should the agent prepare a confirm/decline recommendation with the margin?
3. **Orders:** do all Shopify orders auto-forward to KFB (like #1174)? Do you pay bills every morning, or less often?
4. **"Similar ones":** your rule: when is similar OK, and when must the listing change or be drafted?
5. **WhatsApp:** what do you usually message KFB about, and how fast do they reply?
6. **Returns:** do returned items go to your Charlotte address or back to KFB? For exchanges, does KFB ship the new size from China?
7. **New sourcing:** can you send KFB a link to a new factory/product and get it quoted? Is that how a category fix would work?
