# Catalog — spec v1 (2026-10-11)

**Approved by Reilly, 2026-10-11:** "sure looks good" (Margin Guard, Merchant Center health, new-product check; drop content/size notes and the theme desk). Reilly publishes products himself; the brain never builds or imports products.

Pricing rules, compare-at tiers and drafting denied products live in the supplier spec (morning quote approval).

## Workers
- **Margin Guard (daily):** each live product's price vs its latest real cost (KFB re-bills, EUR→USD at the card rate). Out of band → added to the next pricing approval. Also flags discounts/bundles that push an order line's COGS above ~50% of what the customer paid (10-07 #1212 ran 55% after a 25% discount).
- **Merchant Center health (daily, all three stores):** disapproved products, warnings, account-level issues → morning brief + proposed fix for approval. Needs the Merchant API enabled on the "Store Brain" Google Cloud project and access to each store's Merchant Center account.
- **New-product check (morning after publish):** price in band and within $44.95–$144.95 (Marlowe $49.95 floor), compare-at tier assigned, size chart in the library, cost on file, no duplicate handle. Flags only; never edits.
- **Product status:** drafts from approved batches (denied / needs a different supplier), verified against Shopify after.

## Dropped
- Content & size notes ("dont fix the store", 2026-10-11).
- Theme release desk.
- Import builder (Reilly publishes himself).
