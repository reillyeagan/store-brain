/**
 * Reilly's supplier decisions, verbatim (rule 10: only Reilly's words make a decision).
 * Copied word for word from docs/specs/supplier.md, where he gave them on 2026-10-11.
 * Seeded once into `decisions` so every agent (and the Decision Keeper later) reads the same words.
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { seedDecision } from "../core/decisions.js";

export const SUPPLIER_DECISIONS = Object.freeze([
  { topic: "sup.similar_ones", at: "2026-10-11T00:00:00Z", scope: "all", words: "q4 always fine" },
  { topic: "sup.returns", at: "2026-10-11T00:00:00Z", scope: "all", words: "i never return things to KFB." },
  { topic: "pricing.approval", at: "2026-10-11T00:00:00Z", scope: "all", words: "yes i need to approve every price rewrite, as well as draft products, etc" },
  { topic: "sup.quotes_flow", at: "2026-10-11T00:00:00Z", scope: "all", words: "when quotes come back, I just auto approve all them and then adjust the live store prices accordingly with what the quoted price is, and whatever products got denied i draft them on the live store." },
  { topic: "sup.size_fit_rule", at: "2026-10-11T00:00:00Z", scope: "all", words: "idk if the sizing between US and chinese sizes seems accurate then its fine, but if the customer orders a M and the chinese M looks more like a S, we might want to send out a chinese L" },
  { topic: "sup.size_measurements", at: "2026-10-11T00:00:00Z", scope: "all", words: "check everything and make logical decisions" },
  { topic: "sup.dont_fix_store", at: "2026-10-11T00:00:00Z", scope: "all", words: "dont fix the store" },
  { topic: "sup.bills", at: "2026-10-11T00:00:00Z", scope: "all", words: "i try to pay KFB bills every morning if i can, most of the time i do" },
  { topic: "pricing.ceiling", at: "2026-10-11T00:00:00Z", scope: "all", words: "max price 144.95 all 3 stores" },
  { topic: "pricing.floor.hc", at: "2026-10-11T00:00:00Z", scope: "hc", words: "min price 44.95 on H&C going forwards" },
]);

/**
 * Insert any decision not yet recorded. Idempotent. Goes through the Decision Keeper's one
 * guard (seedDecision): one topic name per quote, and never a seed over Reilly's newer words.
 */
export async function ensureSupplierDecisions(db, { nowMs = Date.now() } = {}) {
  let added = 0;
  for (const d of SUPPLIER_DECISIONS) {
    if ((await seedDecision(db, d, { nowMs })).added) added++;
  }
  if (added) {
    await logEvent(db, {
      actor: "sup.digest", kind: "decisions.recorded", target: "core.decisions", at: nowIso(nowMs),
      summary: `Recorded ${added} of Reilly's supplier decisions word for word (from the supplier spec, 2026-10-11)`,
      data: { topics: SUPPLIER_DECISIONS.map((d) => d.topic) },
    });
  }
  return { added };
}
