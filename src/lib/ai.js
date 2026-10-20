/**
 * Shared Claude call for every agent that needs judgement or language (CLAUDE.md: "Claude
 * agents run only where judgement or language is needed").
 *
 * - Same Messages API request as the brief (brief.js callClaude), with the caller's own
 *   system prompt and token cap.
 * - Every call's cost is logged as an `ai.call` event BEFORE the answer is checked, so a
 *   broken answer is still counted (the AI-cost tile can only over-state).
 * - No key → { skipped: "not wired" }, never a guess.
 * - The key never reaches an error, an event or the page (scrubKey).
 * - A per-day budget (AI_DAILY_BUDGET_USD, default $3) stops agents spending past it; the
 *   stop is logged once a day.
 *
 * askJson() asks for one JSON object and parses it; a bad answer throws (never invented).
 */
import { callClaude, aiCostUsd, scrubKey } from "./brief.js";
import { logEvent, costSince } from "./eventlog.js";
import { nowIso } from "./time.js";

export const DEFAULT_DAILY_BUDGET_USD = 3;

export class AiError extends Error {
  constructor(message) { super(message); this.name = "AiError"; }
}

function dayStartIso(nowMs) {
  // Budget day = UTC day: simple, and the cap is a safety net, not accounting.
  return new Date(Math.floor(nowMs / 86400000) * 86400000).toISOString();
}

export async function aiBudgetLeft(env, nowMs = Date.now()) {
  // A setting that isn't a positive number falls back to the default (NaN would mean "no cap").
  const raw = Number(env.AI_DAILY_BUDGET_USD);
  const cap = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_BUDGET_USD;
  const spent = await costSince(env.DB, dayStartIso(nowMs));
  return cap - Number(spent || 0);
}

/**
 * @param {object} env
 * @param {{system:string,user:string,image?:{media_type:string,data:string},maxTokens?:number,actor:string,label:string,store?:string}} req
 * @returns {{text:string,model:string,cost:number}|{skipped:string}}
 */
export async function askClaude(env, req, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  if (!env.ANTHROPIC_API_KEY) return { skipped: "not wired (no ANTHROPIC_API_KEY)" };
  if ((await aiBudgetLeft(env, nowMs)) <= 0) {
    const since = dayStartIso(nowMs);
    const told = await env.DB.prepare(`SELECT id FROM events WHERE kind = 'ai.budget_reached' AND at >= ? LIMIT 1`).bind(since).first().catch(() => null);
    if (!told) {
      await logEvent(env.DB, { actor: req.actor, kind: "ai.budget_reached", summary: `AI spend reached today's cap; agents skip AI work until tomorrow (UTC)`, at: nowIso(nowMs) }).catch(() => {});
    }
    return { skipped: "daily AI budget reached" };
  }
  const at = nowIso(nowMs);
  const prompt = { system: req.system, user: req.user };
  if (req.image) prompt.image = req.image; // optional {media_type, data}: one base64 image (size-chart intake)
  if (Array.isArray(req.images) && req.images.length) prompt.images = req.images; // several (1688 description images)
  const r = await callClaude({ ...env, BRIEF_MODEL: env.AGENT_MODEL || env.BRIEF_MODEL }, prompt, {
    fetchImpl,
    maxTokens: req.maxTokens,
    onUsage: async (m, u) => {
      const cost = aiCostUsd(m, u);
      await logEvent(env.DB, {
        actor: req.actor, kind: "ai.call", target: "sys.claude", costUsd: cost, store: req.store || undefined,
        summary: `${req.label}: Claude ${m}, ${u.input_tokens || 0} in / ${u.output_tokens || 0} out ($${cost.toFixed(4)})`,
        data: { model: m, usage_in: u.input_tokens || 0, usage_out: u.output_tokens || 0 }, at,
      });
    },
  }).catch((err) => { throw new AiError(scrubKey(err && err.message, env)); });
  return { text: r.text, model: r.model, cost: aiCostUsd(r.model, r.usage) };
}

/** Ask for one JSON object. Returns { json, model, cost } or { skipped }. Throws AiError on a bad answer. */
export async function askJson(env, req, opts = {}) {
  const r = await askClaude(env, { ...req, system: `${req.system}\n\nAnswer with ONE JSON object only, no prose, no code fences.` }, opts);
  if (r.skipped) return r;
  const m = r.text.match(/\{[\s\S]*\}/);
  if (!m) throw new AiError(`${req.label}: the answer was not JSON`);
  try {
    return { json: JSON.parse(m[0]), model: r.model, cost: r.cost };
  } catch {
    throw new AiError(`${req.label}: the answer was not valid JSON`);
  }
}
