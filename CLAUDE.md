# CLAUDE.md — Store Brain

This repo is the **Store Brain**: the 24/7 operations system for Reilly's Shopify stores. It is **separate from Eagano** (Reilly's personal AI brain in his Obsidian vault). Eagano's vault holds the history and the planning notes; this repo holds the system itself.

## Stores
| id | Store | Live | KFB shop code |
|---|---|---|---|
| hc | Holt & Crane | yes | jmzjx1-it |
| aub | Auberlane | yes | 3as2ya-dw |
| mar | Marlowe Standard | yes | 806080-g8 |
| cc | Colette & Claire | not yet | tbc |
| tund | Tundrelle | not yet | mek6yu-91 |

Config lives in `src/config/stores.js`. A store that is not live gets no P&L rows and no workers.

## Architecture
- **Backbone:** a Cloudflare Worker (`src/index.js`): HTTP routes, Shopify webhooks, crons, D1 ledger (`DB`), R2 backups (`BACKUPS`).
- **Thinking:** Claude agents run only where judgement or language is needed. Anything with a right answer is plain code.
- **The Core:** the store knowledge brain (`core_facts` and friends). Every agent reads Core State first.
- **Event Log:** every action by every worker is one row in `events`. Mission Control draws only from it.
- **Specs:** `docs/specs/*.md`, one per department. Read the relevant spec before building a worker.

## Non-negotiable rules (each one was learned the hard way)
1. **Never handle secrets.** API keys, client secrets and tokens are pasted into Cloudflare by Reilly. Never ask for them in chat, never write them to a file, never log them.
2. **Store Guard on every Shopify write.** Use the store's own credentials and assert the shop domain before writing. A mismatch is a hard stop.
3. **Verify every write against the system of record**, never the receipt. A 200 is not proof.
4. **Freshness before numbers.** A feed past its age limit is not used. Null means "not wired"; zero is a claim.
5. **Errors have always run in the flattering direction.** Good news gets more scrutiny, not less.
6. **A failed probe is evidence about the probe, not the world.** Retry and check before raising an alarm.
7. **Events, not aggregates.** Refunds come from refund transactions (including PENDING), by processed date.
8. **Backup before any bulk change**, durable (R2), checked before promising a rollback.
9. **The author never audits its own work.**
10. **Only Reilly's words make a decision.** Record them verbatim in `decisions`.
11. **Nothing goes live without Reilly.** New workers run in shadow mode first; Reilly approves the go-live. Reilly runs every deploy.
12. **Reilly publishes, deletes, pays, and handles credentials.** Agents never do.

## Design
Every screen uses the **Eagano dash aesthetic** ("Batman" minimal):
`--bg #0b0b0d · --panel #131316 · --panel2 #17171b · --border #26262b · --text #e8e8ea · --muted #8a8a93 · --faint #54545c · --accent #c7d2db · --good #6bbf8a · --warn #c9a36b · --bad #c97b7b`, Inter type. No colour noise.

## Working here
- `npm test` runs the unit tests (Node's built-in test runner, with an in-memory SQLite stand-in for D1).
- Commit messages end with the attribution lines from the session's instructions.
- Write code a non-developer can trust: small modules, clear names, comments that say **why**.
