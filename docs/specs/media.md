# Media (Google Ads) — spec v1 (2026-10-11)

**Reilly, 2026-10-11:** "guy is still the mediabuyer, dont worry about the spend cieling, and for now, the media section is just watching more than anything. we are not going to make any changes ourselves, guy is doing all of that. but eventually I want to drop him as the mediabuyer and just use the store brain, but we need more data for it to work better"

## Mode: watch only
- **Read-only** on all three Google Ads accounts. No budgets, bids, negatives or pauses — ever, until Reilly says otherwise in his own words.
- No spend ceiling enforced.

## Workers
- **Performance (daily):** per store and per product, against true break-even ROAS `1 / [margin × (1 − 0.119 refund) − 0.0334]` from real COGS, not Google's numbers.
- **Product performance:** products spending without selling; products losing money even when they sell.
- **Search terms:** wasted searches noted (not acted on).
- **Conversion integrity:** Google-reported conversions vs real Shopify orders; mismatches flagged (errors have run in the flattering direction).
- **Guy Monitor:** reads the Google Ads change history daily — what Guy changed, when — and tracks what happened after each change (7/14 days).
- **Shadow recommendations:** every day the brain logs what it *would* have done (with reasons) and later scores those calls against what actually happened. This is the track record Reilly needs before replacing Guy.

## Later (not v1)
Acting on the accounts, once the shadow record is good enough and Reilly decides to move off Guy.
