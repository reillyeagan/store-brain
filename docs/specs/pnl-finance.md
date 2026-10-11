# Department spec — P&L & Finance (deep-dive draft v1, 2026-10-10)

**Mission:** a true number every morning, per store and for the group, and a clear answer to "where did the money go?"
**Why it's built first:** it's the most mature process today, and it's where past errors cost the most. Every one of those errors made profit look *better* than it was.
**Record of truth:** Reilly's Google Sheets P&L workbooks stay the official record. The brain writes them via the Sheets API, never by browser typing.

Legend: **CODE** = deterministic program (no AI) · **AI** = Claude, used only for judgement/language · L0/L1/L2 = permission level.

---

## Data flow (one day)

```
Shopify (per store) ─┐
Google Ads scripts ──┼─► Data Pullers ─► COGS Matcher ─► Ledger Keeper ─► Sheets (4 workbooks)
KFB morning sweep ───┘                    ▲                    │
Shopify refunds ──────► Refund Reconciler ┘                    ├─► Analyst ─► Morning brief / reviews
                                                               └─► Money Map / Tax & Triggers
```

---

## Workers

### 1. Data Pullers · CODE · L2
| | |
|---|---|
| **Wakes** | Hourly (today, partial) · 00:30 ET day close · after the KFB morning sweep · re-pulls the last 3 days on every close |
| **Reads** | **Shopify** (per-store key): orders by created time in store timezone, gross, discounts, net, order count, sessions (ShopifyQL), transaction fees (`OrderTransaction.fees`), payouts. **Google Ads**: existing spend-export scripts (hourly, 3-day backfill) — spend, clicks, conversion value. **KFB**: bills + bill details (incl. suborders), orders (`shopify_create_at`). **Guy fee**: 10% of spend from his start date, per store (config). |
| **Writes** | Raw rows to the ledger, each stamped with source + fetch time. Freshness Sentinel checks every feed. |
| **Rules** | Today is always partial — never quoted as closed. A null means "not wired", a zero is a claim. Day = Shopify order time in the store's timezone, never KFB `order_time`. `read_orders` only returns 60 days → append, never replace. |

### 2. COGS Matcher · CODE · L2
| | |
|---|---|
| **Wakes** | After each pull and after the KFB morning sweep |
| **Does** | For each Shopify order: find the KFB order by store code (`jmzjx1-it` H&C · `3as2ya-dw` AUB · `806080-g8` MAR · `mek6yu-91` TUND · C&C tbc) + order number. Cost = parent + **all** suborders (never filter `price>0`). Converts EUR → USD at the **correct rate automatically** (source: see decision 3). |
| **Estimates** | Not yet invoiced → SKU's last actual cost first, else the store's measured rate × revenue. Flagged as estimate, restated when the invoice lands. |
| **Rules** | Store attribution by `un_shop_url`/store code, never by order number (19 numbers are shared across stores). Absence in KFB means "not yet" until the day is closed. |

### 3. Refund Reconciler · CODE (+ AI explanation) · L2
| | |
|---|---|
| **Wakes** | Hourly + day close |
| **Does** | Reads refund **events** (`refunds{transactions{status}}`) including PENDING, booked on the **refund-processed date**. Diffs three views daily: worker feed vs Shopify events vs the books. Chargebacks go in their own line (C37), never in refunds. |
| **Flags** | Any disagreement → ticket with "what query would make each side right". PENDING older than 7 days → flag. Promised-but-unissued refunds come from CS's Obligations Tracker. |

### 4. Ledger Keeper · CODE · L2 (after shadow gate)
| | |
|---|---|
| **Wakes** | After Matcher + Reconciler finish |
| **Does** | Writes each store's daily row (revenue, COG, ads, services, fees, profit, orders, clicks, sessions) + refunds/chargebacks cells + SUMMARY, then the **Ecom** group sheet. Cross-foots group = Σ stores to the cent. Restates the last 2–3 days. Writes estimate notes into SETUP. **Creates next month's tab automatically** (31/30/28-day geometry) — no more missing OCT tab. |
| **Rules** | Every write goes through Sheets Writer + Write-Verifier (read back). Any day with COG% outside 28–50% = coverage gap until proven otherwise. Backup Vault snapshot before any restatement. |

### 5. Analyst · AI · L2 (reports)
| | |
|---|---|
| **Wakes** | Daily after close · Monday (weekly) · 1st of month (monthly) |
| **Writes** | **Daily:** 3–5 lines per store (profit, REAL, ROAS vs break-even, what moved it). **Weekly:** where money was lost (store / product / campaign / refunds / COGS drift) and room to improve. **Monthly:** full review + recalibrated COGS rate and FX. |
| **Rules** | Refund-adjusted break-even. Excludes contaminated windows. Never states a number it didn't recompute. Unflattering reads need a cited source. Good news gets more scrutiny, not less. |

### 6. Money Map · CODE (+ AI summary) · L2
| | |
|---|---|
| **Does** | Where all the money is: Shopify balances + upcoming payouts (API), ad billing status, KFB unpaid bills, cards owed. **Records only — never chases or pays.** |
| **Open** | Bank/PayPal/card balances have no easy API → see decision 6. |

### 7. Tax, Admin & Triggers · CODE (+ AI reminders) · L1
| | |
|---|---|
| **Does** | Calendar of sales-tax filings, LLC steps (EIN, entity switch), Guy invoices, card due dates, chargeback deadlines (#1053 Oct 31), and numeric decision triggers. Reminders go to the morning brief. |

---

## Shadow gate (before it takes over the sheets)
7 days running beside today's manual process. Must match to the cent, or every difference is explained and Reilly agrees. Then the Ledger Keeper goes live.

## Decisions for Reilly
1. **Stores with P&L rows:** H&C, Auberlane and Marlowe today. Colette & Claire and Tundrelle — start rows when they first take orders / spend?
2. **Sheets:** keep the 4 workbooks as the record (and add C&C / TUND workbooks when live)?
3. **The "correct" FX rate:** what currency does KFB bill in, and how do you pay it (card in USD, PayPal, Wise)? That decides where the true rate comes from.
4. **Day close:** midnight Eastern, re-pulling the last 3 days each night — OK?
5. **Morning brief time:** e.g. 7:30 AM?
6. **Money Map balances:** which accounts (Shopify, PayPal, bank, Amex)? Options: a 10-second weekly "type your balances" box on Mission Control, or skip non-API balances.
7. **Analyst depth:** daily short note + weekly + monthly — right amount?
