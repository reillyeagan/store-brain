/**
 * Live or shadow, per area — the one place that reads the go-live switches.
 *
 * Why one place: before go-live, every department page hardcoded "shadow". Reilly made the brain
 * live on 2026-10-14 ("i want to move EVERYTHING in the brain to live so its all working - can
 * we do that", decision core.go_live). A label that says "shadow" while the brain acts is a lie
 * in the flattering direction (rule 5), so every label now comes from the switch that really
 * controls the behaviour.
 *
 * Each switch is a plain variable: "1" = live, anything else = shadow. They are set to "1" in
 * wrangler.toml [vars]; Reilly turns one off by setting it to "0" in the Cloudflare dashboard.
 * keep_vars = true keeps only dashboard variables wrangler.toml does NOT list, so a deploy writes
 * these back to "1": to keep one off across deploys it must be "0" in wrangler.toml too.
 *
 * What "live" never means, whatever the switches say (Reilly's standing decisions):
 *   - Shopify stays read-only (no write access is granted; that is a separate project);
 *   - customer emails are Gmail DRAFTS he reviews and sends (decision cs.sending);
 *   - supplier messages are copy-paste he sends himself (decision sup.kfb_channel);
 *   - ads stay watch-only: Guy runs the accounts (decision media.role).
 */

/** Every switch, in the order the dashboard lists them. `live` / `shadow` say what each state does. */
export const LIVE_SWITCHES = Object.freeze([
  {
    area: "reports", env: "GO_LIVE", name: "Go-live (watching and reporting agents)",
    live: "Agents that watch and report run for real: findings, questions for you and the brief. Shopify stays read-only, ads stay watch-only.",
    shadow: "Agents still run, but their pages are labelled shadow (a rehearsal).",
  },
  {
    area: "cs", env: "CS_DRAFTS_LIVE", name: "Customer replies as Gmail drafts",
    live: "Replies are saved as DRAFTS in the store Gmail; you review and click send. Nothing is ever sent to a customer.",
    shadow: "Replies stay on the CS page only; nothing goes to Gmail.",
  },
  {
    area: "brief", env: "BRIEF_PHONE_LIVE", name: "8:00 brief to your phone",
    live: "The morning brief also goes to your phone at 8:00.",
    shadow: "The brief is on Mission Control only.",
  },
  {
    area: "supplier", env: "SUPPLIER_MESSAGES_LIVE", name: "KFB messages to your phone",
    live: "The evening KFB message reaches your phone ready to copy and paste; you send it yourself.",
    shadow: "The KFB message is drafted on Mission Control only.",
  },
  {
    area: "kfb_reminder", env: "KFB_REMINDER_LIVE", name: "9:00 KFB import reminder",
    live: "If no KFB import landed by 9:00, one reminder goes to your phone.",
    shadow: "The missing import is logged only.",
  },
  {
    area: "alerts", env: "PHONE_ALERTS_LIVE", name: "Urgent phone alerts",
    live: "Urgent problems only go to your phone: at most 6 a day, each one once.",
    shadow: "Urgent problems are logged only, not sent.",
  },
]);

/** Department page → the switch that governs it. Everything that only reports follows GO_LIVE. */
const AREA_ALIAS = Object.freeze({
  core: "reports", media: "reports", catalog: "reports", risk: "reports", pnl: "reports", fulfillment: "reports",
});

/** How to turn any switch off, in one line (shown on the dashboard). */
export const HOW_TO_TURN_OFF = "To turn one off: Cloudflare dashboard → Workers & Pages → store-brain → Settings → Variables and Secrets → set it to 0 → Deploy. It takes effect on the next run. The next code deploy sets it back to 1 unless wrangler.toml says 0 too, so also ask Claude to change it there.";

function switchFor(area) {
  const a = AREA_ALIAS[area] || area;
  return LIVE_SWITCHES.find((s) => s.area === a) || null;
}

const on = (env, name) => !!env && String(env[name] ?? "").trim() === "1";

/** "live" or "shadow" for an area (cs, brief, supplier, kfb_reminder, alerts, reports, or a department id). */
export function modeFor(env, area) {
  const s = switchFor(area);
  if (!s) return "shadow"; // an unknown area is never reported live
  return on(env, s.env) ? "live" : "shadow";
}

/** One line: what this area does in its current mode. */
export function liveMeans(env, area) {
  const s = switchFor(area);
  if (!s) return "Unknown area: shadow.";
  return on(env, s.env) ? s.live : s.shadow;
}

/** True when any live switch is on. */
export function isLive(env) {
  return LIVE_SWITCHES.some((s) => on(env, s.env));
}

/** Read-only view of every switch for the dashboard. Values only: none of these is a secret. */
export function liveSwitches(env) {
  return {
    switches: LIVE_SWITCHES.map((s) => {
      const raw = env && env[s.env] != null ? String(env[s.env]) : null;
      return { area: s.area, env: s.env, name: s.name, value: raw, mode: on(env, s.env) ? "live" : "shadow", means: on(env, s.env) ? s.live : s.shadow };
    }),
    howToTurnOff: HOW_TO_TURN_OFF,
  };
}

/**
 * Which switch decides whether an agent is live. Agents whose output leaves the ledger have
 * their own switch; every other built agent only watches and reports (GO_LIVE).
 */
export const AGENT_AREA = Object.freeze({
  "core.briefer": "brief",
  "cs.reply_writer": "cs",
  "sup.relay": "supplier",
  "svc.kfb_session": "kfb_reminder",
});
export const areaForAgent = (id) => AGENT_AREA[id] || "reports";

/**
 * An agent's status for the dashboard. The build status stays as `build` (planned, built, ...);
 * a built agent is "live" when its switch is on. Planned and switched-off agents never are.
 */
export function agentStatus(agent, env) {
  if (!agent) return null;
  if (agent.status === "live") return "live"; // already live on Reilly's own words (e.g. pnl.sheets)
  if (agent.status !== "built" && agent.status !== "shadow") return agent.status;
  return modeFor(env, areaForAgent(agent.id)) === "live" ? "live" : agent.status;
}
