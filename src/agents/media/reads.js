/**
 * Claude-written words for the media page, at most ONE per store, agent and day.
 *
 * The cap is the media_reads primary key: the row is claimed (status 'pending') before
 * Claude is called, so two overlapping ticks can't both pay for the same read.
 * Claude only writes words around numbers that code already computed; its text is stored
 * as a read, never parsed back into a number.
 * No key / budget reached → status 'skipped' with the reason (the page says "waiting on AI").
 */
import { askClaude, askJson } from "../../lib/ai.js";
import { nowIso } from "../../lib/time.js";

export async function dailyRead(env, { store, agent, day, system, user, label, maxTokens = 220, json = false }, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const at = nowIso(nowMs);
  const claim = await env.DB.prepare(
    `INSERT INTO media_reads (store, agent, day, status, at) VALUES (?, ?, ?, 'pending', ?) ON CONFLICT(store, agent, day) DO NOTHING`
  ).bind(store, agent, day, at).run();
  if (!(claim.meta && claim.meta.changes > 0)) return { already: true };
  try {
    const req = { system, user, maxTokens, actor: agent, label, store: store === "all" ? undefined : store };
    // json: Claude classifies (e.g. search-term relevance); the caller checks every item it returns.
    const r = json ? await askJson(env, req, { fetchImpl, nowMs }) : await askClaude(env, req, { fetchImpl, nowMs });
    if (r.skipped) {
      await env.DB.prepare(`UPDATE media_reads SET status = 'skipped', note = ? WHERE store = ? AND agent = ? AND day = ?`).bind(r.skipped, store, agent, day).run();
      return { skipped: r.skipped };
    }
    const text = json ? JSON.stringify(r.json).slice(0, 4000) : String(r.text || "").trim().slice(0, 1200);
    await env.DB.prepare(`UPDATE media_reads SET status = 'done', text = ? WHERE store = ? AND agent = ? AND day = ?`).bind(text, store, agent, day).run();
    return json ? { json: r.json } : { text };
  } catch (err) {
    await env.DB.prepare(`UPDATE media_reads SET status = 'failed', note = ? WHERE store = ? AND agent = ? AND day = ?`)
      .bind(String(err && err.message).slice(0, 200), store, agent, day).run().catch(() => {});
    return { failed: String(err && err.message) };
  }
}

/** The latest read for a store/agent (for the page). */
export async function latestRead(db, store, agent) {
  return db.prepare(`SELECT day, status, text, note, at FROM media_reads WHERE store = ? AND agent = ? ORDER BY day DESC LIMIT 1`).bind(store, agent).first();
}
