# Department spec — P&L & Finance (deep-dive draft v2, 2026-10-10)

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

### 4b. P&L Sheets (`pnl.sheets`) · CODE · L1 — BUILT 2026-10-14
Reilly, 2026-10-14: "make sure things like the google drive P&L sheets are all updated by the brain automatically" and "use the spreadsheets to fill in accurate data for every single day we have". This is the first, narrower version of the Ledger Keeper's sheet writing above:
- **When:** ONCE A DAY in the morning (Reilly, 2026-10-14, decision `pnl.sheets_schedule`: "P&L sheets only have to update once per day, in the monring, it should fill in yesterdays P&L. does not need to be hourly for the google sheets"). From 07:00 New York, at the first P&L department slot (about 07:36): after the 05:00 UTC day close, before the 08:00 brief. If yesterday isn't closed in the brain yet, it writes what is closed and retries at each slot until noon. A morning missed entirely still gets one run later that day. Each attempt is one atomic claim (`job_runs` pnl.sheets.morning), so two runs can't both go ahead. The day is recorded "filled" only when every workbook's yesterday cells were written AND verified, or there was provably nothing writable (reasons recorded); the Ecom row follows at the next slot once the store sheets are filled. Failed writes, call budget, kill switch, an unclosed yesterday: retried until noon, then "not filled: <reason>". Yesterday is planned first, outside the per-run caps. State: `sheets.schedule` (last run, result, next run).
- **Reads** the 3 store workbooks + Ecom P&L in that morning run, every month tab (header names, not positions); a read stays fresh until the next morning (26 h). Fills the brain only where it has nothing (ad spend days, fees, COG from the KFB ledger at the SETUP FX rate, marked as such) and only when the sheet's day provably is the brain's day. Differences → `pnl.sheet_mismatch`, once per store/day/field. Never overwrites system-of-record data.
- **Writes** only BLANK, non-formula input cells of days the brain has CLOSED, first of all YESTERDAY's row; older blank days within the per-run caps. Reilly's typed numbers always win. No refunds (no per-day cell), **no tab creation** (one event a day asks Reilly), no SETUP notes.
- **Corrections:** the same run re-checks the cells the BRAIN wrote for the last 3 days. If the brain's value changed (Google restated the ads) and the cell still holds exactly what the brain wrote, it is updated (backup first, re-read after) and logged as `pnl.sheet_corrected`. A cell Reilly changed is never touched. R2 backup before every batch, re-read after. Kill switch `SHEETS_WRITE = "0"`.
- Mode: LIVE on Reilly's words (decision `pnl.sheets_write`); `SHEETS_WRITE` = 0 / false / off stops it.
- Day-based numbers (revenue, orders, fees, COG, sessions) are written only when (a) Shopify's own timezone (`shop { ianaTimezone }`, read daily through Store Guard, the authority) equals stores.js, else an alarm, and (b) the sheet's hand-filled days prove the same day basis: at least 8 of the last 10 closed days with revenue and orders on both sides match (orders exact, revenue within $1), re-evaluated daily. A SETUP timezone label never decides this by itself: on 2026-10-14 Shopify confirmed all three stores run on Eastern, so the "store timezone (CDT)" labels are stale; the state shows one "SETUP says CDT but Shopify says Eastern" note per workbook and the brain never edits SETUP. Ad spend, services and clicks: yesterday is filled the next morning (its restatements are put right by the corrections); other days only once 3 days old. No SERVICES before Guy's start (2026-09-07).
- Sheet COG counts as ESTIMATED (EUR exact, FX estimated) and is refused under 85% of the brain's own estimate (probably an unbilled order).
- Refund history moves back only with `read_all_orders` (scope re-checked daily); without it those days stay open: "refunds unprovable".
- Writes are recorded as `pending` before the write call, then `verified` / `unverified`. The P&L slot shares one outbound-call budget (45).

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

## Decisions (Reilly, 2026-10-10)
1. **Stores:** H&C, Auberlane, Marlowe only. Colette & Claire and Tundrelle are not live; they get rows and workbooks when they go live.
2. **Sheets:** keep the 4 workbooks as the record.
3. **FX:** KFB bills in EUR and Reilly pays by card in EUR. **Use the exact card transaction amounts** (USD actually charged per KFB payment) as the rate. Source of those amounts: to be confirmed (see open questions).
4. **Day close:** midnight Eastern; re-check the last 3 days every night.
5. **Morning brief:** contents proposed below; time to be confirmed.
6. **Balances must be exact.** Shopify via the Payments API (below); other accounts per open questions.
7. **Analyst:** daily + weekly + monthly, broken down by P&L and margins per store/product/campaign, with room to improve.
8. **NEW — live P&L dashboard:** separate from the Eagano dash, same aesthetic, intraday, exact numbers matching the sheets.

## Exact Shopify payouts (fixing the old tracker)
The old tracker estimated. The new one reads Shopify Payments directly with each store's own key (scope `read_shopify_payments_payouts`): **current balance, every payout (amount, status, date) and every balance transaction** (charge, refund, fee, adjustment, reserve). Rules: a payout must equal the sum of its balance transactions to the cent, otherwise flag. Pending vs paid are kept separate. Dedupe by payout id, never by amount (identical $67.62 payouts are normal).

## Live P&L dashboard (Phase 2 deliverable)
- Separate page from the Eagano dash; Eagano-dash aesthetic; phone + desktop.
- Today (partial, clearly marked, refreshed hourly) · yesterday (closed) · month-to-date · per store + group.
- Revenue, COGS (actual vs estimated share shown), ads, services, fees, refunds, chargebacks, profit, **REAL profit**, ROAS vs refund-adjusted break-even, margins.
- Freshness badge per feed; every number reads from the same ledger that writes the sheets, so the two can never disagree.
- Replaces the old `hc-pnl` lender page.

## Morning brief — proposed contents (short, one screen)
1. **Needs you** — approvals waiting, decisions, KFB login ping.
2. **FAILs / alerts** — stale feeds, PENDING refunds, deadlines (e.g. chargeback #1053, Oct 31).
3. **Yesterday** — profit and REAL per store + group, ROAS vs break-even, month-to-date.
4. **Supplier** — overnight quotes/denials, "similar ones", KFB bills to pay (you pay).
5. **Customers** — open tickets, promises due today, late shipments.
6. **Ads** — spend pacing per store.
7. **Today** — calendar items (tax, invoices, deadlines).

## Settled 2026-10-10 (later)
- **FX source:** Reilly pays KFB with his **Wells Fargo card** (billed in EUR). He will turn on WF purchase alerts by email; the brain reads each alert from Gmail and matches the USD actually charged to the KFB payment. That gives the exact rate per payment. Any separate WF foreign-transaction fee line is captured too, as a real cost.
- **PayPal / bank balances:** Reilly enters them himself (balance box on Mission Control). Money Map shows each balance with the date it was entered, so stale ones are obvious.
- **Subscription log:** Reilly will write a full subscription log (what, amount, billing day). It lives in the Core, and Money Map uses it to expect charges and flag surprises.
- **Morning brief:** 8:00 AM Eastern.

## Real-time orders (lesson from the Eagano dash, 2026-10-10)
On the current Eagano dash, H&C updates within about a minute but Auberlane and Marlowe lag 5–10 min. Cause, found in the worker code: the page's own pull calls `/shopify/pull` **without a store parameter**, which defaults to H&C, so only H&C is refreshed on page open or refresh; the other stores wait for the 15-minute cron.
**Store Brain design:** each store's app subscribes to Shopify **webhooks** (`orders/create`, `orders/updated`, `refunds/create`). An order lands in the ledger and on the P&L dashboard within seconds, for every store. The hourly/close pulls remain as the reconciliation backstop.

## Guy's fee (Reilly, 2026-10-11)
"10% is constant its been going on since the 7th" → 10% of ad spend per store from **2026-09-07**, every day since. (His September invoice also covered Sep 1–6; the books follow Reilly's start date.)
