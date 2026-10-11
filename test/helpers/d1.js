/**
 * A tiny in-memory stand-in for Cloudflare D1, backed by Node's built-in SQLite.
 * Implements the subset the Store Brain uses: prepare().bind().run()/all()/first().
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export function makeD1() {
  const db = new DatabaseSync(":memory:");
  // Apply every migration in order, exactly as `wrangler d1 migrations apply` would.
  const dir = join(here, "../../migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, f), "utf8"));
  }
  const prepare = (sql) => {
    let params = [];
    const stmt = {
      bind(...p) { params = p.map((v) => (v === undefined ? null : v)); return stmt; },
      async run() {
        const r = db.prepare(sql).run(...params);
        return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      },
      async all() { return { success: true, results: db.prepare(sql).all(...params).map((r) => ({ ...r })) }; },
      async first() { const r = db.prepare(sql).get(...params); return r ? { ...r } : null; },
    };
    return stmt;
  };
  return { prepare, _raw: db };
}

/** In-memory stand-in for an R2 bucket. */
export function makeR2() {
  const store = new Map();
  return {
    async put(key, body) { store.set(key, typeof body === "string" ? body : String(body)); },
    async head(key) { return store.has(key) ? { key, size: new TextEncoder().encode(store.get(key)).length } : null; },
    async get(key) { return store.has(key) ? { text: async () => store.get(key) } : null; },
    _store: store,
  };
}
