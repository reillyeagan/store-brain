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

### The KFB morning import (built 2026-10-14, live since go-live)
- **Reilly, each morning:** log in to KungFuBuy (he types the CAPTCHA), click the **KFB → Store Brain** bookmark, press **Import** on the page it opens (`#/import/kfb`). The bookmark is on that page: drag it to the bookmarks bar once.
- **Bookmark** (`public/kfb-bookmarklet.js`): runs only on the KFB origin, GETs KFB's own JSON with his session (never writes, never sees his password or cookies), opens the import page, waits for its "ready", hands the rows over by postMessage to the exact Store Brain origin. No key inside. A failed read names the endpoint; if the tab never answers it saves a JSON file for the page's **Paste JSON** box.
- **Server** (`POST /api/import/kfb`, key, ≤ 5 MB, `src/lib/kfbImport.js`): checks the envelope, maps every row to a store by KFB shop code only (unknown shop = refused), upserts kfb_quotes (raw status code kept), kfb_similar_offers, kfb_orders, kfb_bills + kfb_bill_lines (parent + every suborder), supplier_bills (paid / unpaid / unknown), keeps the raw payload in R2, marks `kfb.morning_sweep` fresh, logs one `kfb.imported` event. Re-importing the same rows changes nothing.
- **Endpoints** (`src/config/kfb.js`): quotations `/index/quotation/get.html` (vault, exact); orders `/index/order/get.html` (vault path, paging assumed); bills: guessed from the quotation pattern, tried in turn. KFB origin `https://www.kungfubuy.com` (from KFB's privacy-policy URL, not the vault).
- **Safety (review of 7ce2827):** only an allowlist of fields leaves the KFB tab (no customer names or addresses); raw payloads in R2 are kept 30 days. A bill is paid / unpaid only from the bill header or bill-named fields (a flag beats a time; unclear = unknown); a 0 header total falls back to the line sum, and bills with no amount are shown. The sweep feed is fresh only when orders were read. A read cut at the page limit never deletes lines, flags the bill at the cut (COGS waits on it) and raises no "not in KFB" flags. A read older than one already imported is refused (409); the import limit is 26 h, like the feed.
- **Reminders:** "KFB import not done today" leads Waiting on you (dashboard + brief) until an import lands; one phone reminder from 09:00 Eastern (`KFB_REMINDER_LIVE = "1"` since go-live, 2026-10-14; `"0"` = logged only).

---

## Workers

### 1. Quote Desk · CODE (+AI summary) · L1
- **Wakes:** morning sweep.
- **Does:** pulls all quotations per store, diffs against yesterday. Status map: 10 to-quote/priority · 25 awaiting *your* confirmation · 26 denied · 30 quoted · 40 waiting on Reilly's approval (Reilly 2026-10-13, his best guess: "FFG quote status 40 i think means i just havent approved it"; not an error). New quotes → Pricing proposals (Catalog, per-store rules). Keeps each store's "Quoted Products: Cost vs Price" sheet current via Sheets Writer.
- **Alerts:** a product **selling with no quote** (cost unknown) · status-25 and status-40 items waiting on Reilly · the quote queue size and age (H&C ~62 waiting).
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
- ~~Never send a customer a "similar" item without asking; offer it with a photo.~~ Replaced 2026-10-13: asked "does 'similar always fine' cover substitutions on customer orders?", Reilly: "yes". A similar substitute on a customer's order is fine; it is still recorded (verdict on the offer + one event per substitution + a digest line).
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

## Goal: fully automated supplier conversations (Reilly, 2026-10-11)

> "please see if we can add the business number to this chat. my goal is to have supplier conversations completely automated. you check my orders for which ones were express shipping, so the brain can automatically tell KFB which orders to add express shipping to. the brain should use info from my email like size complaints, exchanges, color chagnes, address changes, etc and should tell KFB that as well, evyerthing in this can be automated by the brain"

- **Express shipping:** read the shipping method the customer paid for on each Shopify order; express orders are sent to KFB automatically before that day's bill.
- **From email (CS → Supplier tickets):** size changes, exchanges/replacements, colour changes, address changes, cancellations → one message to KFB per order, tied to the order in the ledger.
- **Ramp (rule 11):** shadow (drafts only, compared with what Reilly sends) → approve each → automatic once a clean streak is reached; Reilly approves go-live.
- **DECIDED 2026-10-11 (Reilly): copy-paste, no WhatsApp API.** "honestly we could just use copy-paste messages instead, the brain gives me a notifaction with the supplier message ready to copy paste then i go and send it myeslf". The brain writes the KFB message, Pushover notifies Reilly with a link to a signed page showing the message and a **Copy** button; Reilly pastes it into the existing KFB group. No business number, no Meta setup. Brain cannot read KFB's replies (bills, "similar" notices) through this route.
- (Superseded) **WhatsApp channel:** Meta's Groups API needs an Official Business Account, max 8 participants, invite-link only, and documents only groups the business creates. Joining KFB's existing group is not documented as possible. Path: ask KFB to talk to the business number directly (1:1) or join a new group it creates.

## Size Checker — every order (Reilly, 2026-10-11)

> "it also should do the size chart checker thing for every single order. every time we get an order it should check either KFG for the supplier link to find the size chart or the database that gets built with size charts that have already been checked over time, and compares it to US sizing. we are hunting for products that run small, so we can send out sizes that will fit to avoid all the returns for small sized products"

**Flow, per order line with a size:**
1. Look up the product in the **size-chart library** (D1 `size_charts`: product + factory link → size → garment measurements in cm, source image, who checked it, when).
2. Not in the library → during the morning KFB session, open the product's supplier (factory) link, read the size chart image (AI, vision; Chinese/cm), store it as **unverified**.
3. Compare the ordered size's garment measurements with the **US standard** for that gender + garment type.
4. Runs small → recommend the size that fits (never above the factory's largest size; if nothing fits, flag for a customer message instead).
5. Recommendations go into the morning KFB message ("#1234 ordered L → please ship XL") and are logged per order, so returns can later confirm or correct the rule.

**Learning:** each product's verdict (true to size / runs small by N) is stored; size complaints and exchanges from email update it. Products Reilly already sized up by hand in the KFB chat seed the library (e.g. the shawl-collar cardigan "+2 sizes", the 3XL-max blazer).

**Fit rule (Reilly, 2026-10-11):** "idk if the sizing between US and chinese sizes seems accurate then its fine, but if the customer orders a M and the chinese M looks more like a S, we might want to send out a chinese L"
- So the rule is **size equivalence**, not a fixed amount of room: work out which US size each Chinese size actually corresponds to (using US garment reference charts for that gender + garment type), then ship the Chinese size that matches the US size ordered. Accurate → ship as ordered.
- **Measurements (Reilly, 2026-10-11): "check everything and make logical decisions".** Chest, length, shoulder and sleeve are all compared. A size is only "equivalent" if it matches the US size on the measurements that matter for that garment (e.g. chest + shoulder for a jacket, chest + length for a sweater). When measurements disagree (chest says M, length says S), the recommendation states the conflict and the reasoning.
- **Store listings are never changed (Reilly, 2026-10-11): "dont fix the store".** The Size Checker only changes what is shipped.

**Complaint log (Reilly, 2026-10-11):** "also keep track of email info from customers who have complained about sizing for certain products and make note of that." Every sizing complaint in email (too small / too big, order, product, size ordered, size that would have fit) is logged against the product. A product with complaints is treated as running small even if its chart looks fine, and the shift is learned from what customers say fit.

**References by garment (Reilly, 2026-10-14):** "we should have different size charts for different products right? like a womens sweater might have different size measurements than a womens coat or even a womens fitted blouse, etc"
- `src/agents/supplier/sizeReferences.js`: US references by audience → garment → fit (fitted / regular / relaxed), sizes XS–4XL, in cm. Men's: shirt, knit, cardigan, hoodie, blazer/jacket, coat/outerwear. Women's: blouse/top, knit, cardigan, blazer/jacket, coat/outerwear, dress. Every table is a **labelled inference** (US body chest/bust + garment ease); Core facts `sizing.us_reference:<audience>:<garment>[:<fit>]` override them (the old `sizing.us_reference:<garment>` still means men's).
- Measurements compared: coat/blazer chest + shoulder · women's knit/cardigan chest · men's knit chest + length · blouse chest + shoulder · dress chest + waist · any relaxed fit chest only. **The chest decides the size** (review of 1e5fd64: a wrong size-up is the costly error): shoulder, length, sleeve and waist shortfalls are notes with conflict=1, never a size-up on their own. A women's blouse with no fit word uses the fitted-blouse ease (+6.5); only relaxed/oversized/boxy titles get the relaxed allowance (+10).
- **KFB asks only from a confirmed chart** (or from complaints). An unconfirmed chart's size-up is "pending your chart confirm". Saving, replacing or confirming a chart re-decides the product's recent lines (all verdicts); a pending ask that no longer holds is marked withdrawn, never deleted.
- A chart whose chests are under 75cm is refused as "unclear: inches or a flat (half) measurement? say which" unless the unit is given and flat is ticked; the image route never assumes a unit.
- Oversized/relaxed garments are compared only against the relaxed reference and are never sized up just for being oversized (a size-up is capped at what the regular-fit chest needs).
- **Chart intake** (`sizeIntake.js`): `POST /api/size-charts` (paste) and `POST /api/size-charts/image` (Claude reads the image; always unchecked), both key-protected and validated the same way; `POST /api/size-charts/:id/confirm` marks a chart checked by Reilly. The Supplier page lists "charts needed" (sized orders in 30 days with no chart).
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
   - **Extended 2026-10-13 (Reilly):** asked "does 'similar always fine' cover substitutions on customer orders?": "yes". Similar substitutes on customer orders are fine, still recorded. Offers judged "ask Reilly" under the old rule are re-judged as accepted (verdict only, "was ask_reilly" in the reason, one summary event; they are not counted as new substitutions).
5. **WhatsApp:** what do you usually message KFB about, and how fast do they reply?
6. **Returns:** do returned items go to your Charlotte address or back to KFB? For exchanges, does KFB ship the new size from China?
   - **Answered 2026-10-11 (Reilly):** "i never return things to KFB." Returns come to Reilly; replacements/exchanges are new shipments from KFB.
7. **New sourcing:** can you send KFB a link to a new factory/product and get it quoted? Is that how a category fix would work?
   - **Answered 2026-10-11 (Reilly):** "i havent tried this and havent needed to". Not in scope for v1; the brain only flags quality/margin problems.
