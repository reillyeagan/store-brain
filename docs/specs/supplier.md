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

## Pricing rules (from the vault + quoting sheets, 2026-10-11)

> **Reilly 2026-10-11 on H&C's old $69.95 ceiling:** "We have products well over 69.96 on H&C btw" → **"max price 144.95 all 3 stores"**. The $69.95 H&C ceiling is retired. Then: **"min price 44.95 on H&C going forwards"**.

Every price change and every draft is ONE approval per batch, showing old → new for each product. Backup to R2 first, Store Guard, verify every variant against Shopify after.

| Store | COGS band | Rule shape | Floor | Ceiling | Source |
|---|---|---|---|---|---|
| H&C | 29–33% | Directional: above 33% → raise to the cheapest `.95` at ≤33%; below 29% → cut to the dearest `.95` at ≥29%; in band → leave | $44.95 | $144.95 | 09-06 split, 10-06 / 10-08 runs; ceiling 2026-10-11 |
| Auberlane | 25–29% | Single target (as Marlowe) | $44.95 | $144.95 | 09-06 split, 09-07 review; ceiling 2026-10-11 |
| Marlowe | 25–29% | `target = min(max(up95(cost/0.29), 49.95), 144.95)` | $49.95 | $144.95 | 09-23 |

- Prices end in `.95`. Cost = latest KFB quote (EUR billed → USD at the actual card rate).
- Standing holds: H&C outerwear held at $114.95 under band (Reilly 09-01). A held product is never re-proposed unless its cost changes.
- When the ceiling stops a product reaching band, the proposal says so and offers the waiver; it never waives on its own.
- Denied products (and "needs a different supplier") → proposed for **draft**, same approval.

**Compare-at tiers:** 20% none · 20% ~10% · 20% ~20% · 20% ~30% · 20% ~40% of active products, kept even after every batch. Compare-at is a clean `.95` (or `.50`); the badge must print the exact tier. H&C's `snippets/price.liquid` floors to a whole percent then rounds to the nearest 10, so ±5 points prints clean. Read each store's own badge snippet before computing — never assume. New products are assigned to whichever tier is short (seeded, reproducible). When a price changes, its compare-at is recomputed to keep the same tier.

## Questions for Reilly
1. **How do products reach KFB for quoting?** Does KFB pull everything from the store automatically, or do you submit products? Can you set priority?
   - **Answered 2026-10-11 (Reilly):** "KFB automatically pulls orders through there app, I have to manually pull products, so whenever i activate like 50 new products I just go into KFB and click "get products" and they go into the quotation section"
   - **Follow-up 2026-10-11 (Reilly):** "ill do the product publishing myself, and will do the get product thing in KFB. the store brain should never need to worry about it."
   - Means: orders need no forwarding. Publishing products and clicking **Get products** are Reilly's alone; the brain does not track or remind about them.
2. **Status 25 "confirm quotation":** what do you check before confirming? Should the agent prepare a confirm/decline recommendation with the margin?
   - **Answered 2026-10-11 (Reilly):** "when quotes come back, I just auto approve all them and then adjust the live store prices accordingly with what the quoted price is, and whatever products got denied i draft them on the live store."
   - Means: no confirm/decline recommendation needed. The follow-on work is (a) reprice live products from the quote, (b) draft denied products.
   - **Pricing rule, Reilly 2026-10-11:** "look at the product quoting sheets we have … we try and keep the COGs in a certain percentage band, with min and max prices as well. additionally, we have to be sure to keep the compare at prices consistent, so 20% of products should have no compare at, 20% should have a rough 10% compare at (doesnt need to be an exact 10% sale we prioritize clean numbers like 43.95, but the badge still displays clean 10%, 20%, etc), 20% at 20% compare at, and so on."
   - **Approval, Reilly 2026-10-11:** "yes i need to approve every price rewrite, as well as draft products, etc"
   - The rulebook is in **Pricing rules** below (pending Reilly's confirmation of the summary).
3. **Orders:** do all Shopify orders auto-forward to KFB (like #1174)? Do you pay bills every morning, or less often?
   - **Answered 2026-10-11 (Reilly):** orders auto-forward via KFB's app (see Q1). "i try to pay KFB bills every morning if i can, most of the time i do"
   - Means: the morning sweep reports unpaid bills (count, total, oldest) so a skipped day is visible. Paying stays Reilly's.
4. **"Similar ones":** your rule: when is similar OK, and when must the listing change or be drafted?
   - **Answered 2026-10-11 (Reilly):** "q4 always fine"
   - Means: a "similar" quote is treated exactly like an exact match: priced by the rules, never drafted for being similar.
5. **WhatsApp:** what do you usually message KFB about, and how fast do they reply?
6. **Returns:** do returned items go to your Charlotte address or back to KFB? For exchanges, does KFB ship the new size from China?
7. **New sourcing:** can you send KFB a link to a new factory/product and get it quoted? Is that how a category fix would work?
