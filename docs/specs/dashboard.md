# Dashboard spec: Eagano LLC

The dashboard was called "Mission Control"; Reilly renamed it **Eagano LLC** (2026-10-11).

## Look (Reilly, 2026-10-11)
> "lets do something more similar to the current eagano dash with pastel colors, minimal, etc and i like being able to see each individual agent and person like in the screenshot"

Eagano dash tokens (see CLAUDE.md) plus one soft pastel per department:
core `#c7d2db` · media `#c3b5e8` · cs `#efc0a8` · supplier `#a9dcc4` · P&L `#ecdc9f` · risk `#eab0bd` · fulfillment `#aecdef` · catalog `#d5c2ea`.
Every agent is its own dot on the map. A store switcher (All · H&C · Auberlane · Marlowe · + Add store) sits on every page.

## The four pages (Reilly's plan, 2026-10-11, verbatim)

**Home**
- Agent map with visuals showing which ones are currently working, information traveling to and from different agents, with things lighting up etc
- Activity log that shows every time something happens, something showing how many agents are currently working
- Top bar showing yesterday revenue, profit, roas, agents running
- Store selector at the top showing all stores
- Waiting on you section

**P&L**
- Basically eagano dash P&L but uber accurate with real numbers from the P&L spreadsheets, actual KFB data, etc, these numbers will be accurate for the previous few days but during the day itself it will have to be estimates like COGs, but once real COGs come through every previous day should show true numbers. Fees and refunds should be live etc, including the mediabuyer cost, etc
- Revenue and ad spend updating as frequently as possible

Also (2026-10-11): "im a big fan of the eagano P&L right now, with the funnel, the 8 P&L blocks with last day, 7 day, 28 day, all time, etc and the ability to choose and look at any day."

**Brief**
- What has happened, what needs me, constantly updating live with new emails being drafted, stuff being read, etc
- Approvals built into this page

**Agents**
- Everything else like all the different agents etc each can have its own page

## How the plan maps onto the build
- "Currently working" = an agent with a run in progress or an event in the last 2 minutes (from `events`). Traveling dots are drawn only from real hand-off events, never decoration.
- The "waiting on you" list reads the live approvals and KFB-message queues only. No sample data on the live dashboard.
- P&L "true" numbers: a day shows **est.** until every input is final (rules in `pnl-finance.md`). Real KFB costs replace the COGS estimate when they arrive, and every past day is recomputed.
- Revenue: Shopify webhooks (seconds). Ad spend: Google Ads pull every 15 minutes (Google's own data lags up to a few hours; the page shows how fresh it is).
- The funnel (sessions, add to cart, checkout) needs Shopify's read-only `read_reports` scope on each store app. Until then it shows "not wired".
- The old tabs (Supplier, Shipping, Money, Feeds, Setup, Activity) become pages inside **Agents**: each department and each agent has its own page.
