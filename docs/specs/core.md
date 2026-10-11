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
