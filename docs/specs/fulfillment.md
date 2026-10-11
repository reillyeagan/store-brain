# Fulfillment — spec v1 (2026-10-11)

Watches every order from placement to delivery. Timings from the CS Playbook measurement (96 parcels, Aug–Sep): KFB processing median 3 business days (worst 8); order → delivered median 8 business days.

**Approved by Reilly, 2026-10-11:** "yeah i think that looks good" (thresholds, day-15 customer email, a tracking service, automatic proof-of-delivery capture).

| Check | Fires | Action |
|---|---|---|
| Order not in KFB | not in KFB by next morning | Morning brief flag. Re-check first: an absence in KFB is a timing statement, not a fact. |
| Paid, not shipped | 5 business days after bill paid | Line in the morning KFB copy-paste message |
| Shipped, no carrier pickup | 3 days after KFB ships | Line in the KFB message |
| Delivery failed ("not home") | when tracking shows it | Gmail draft to the customer: local carrier + how to reschedule |
| Running late | day 15, not delivered | Gmail draft to the customer with real tracking status |
| Not received | day 20 | Escalate to Reilly: reship or refund (CS Playbook) |

- **Tracking:** a tracking API (17TRACK or equivalent) for real carrier events; Shopify only holds the number. Pricing to confirm before signing up; the key is added by Reilly in Cloudflare.
- **Proof of delivery:** when a parcel shows delivered, store date, time, address/location text and any carrier photo against the order (R2), ready for a chargeback (e.g. #1053).
- Days counted from the Shopify order time (Eastern), never KFB's `order_time`.
- All customer emails are drafts (CS decision 2026-10-11); all KFB lines go into the copy-paste message (supplier decision 2026-10-11).
