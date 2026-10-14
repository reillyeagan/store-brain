/**
 * Small read-only helpers about the KFB morning import, kept apart from kfbImport.js so the
 * brief, the digest and the dashboard state can use them without pulling in the importer.
 */
import { localDay } from "./time.js";

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/**
 * Has an import landed today (Eastern)? What did the last one read?
 * @returns {{doneToday:boolean, day:string, lastAt:string|null, lastFetchedAt:string|null, sections:object|null, counts:object|null}}
 */
export async function kfbImportStatus(db, nowMs = Date.now()) {
  const day = localDay(nowMs, "America/New_York");
  // The latest READ, not the latest import: a file read yesterday and pasted today is not
  // today's session.
  const last = await db.prepare(`SELECT * FROM kfb_imports ORDER BY fetched_at DESC, id DESC LIMIT 1`).first().catch(() => null);
  return {
    day,
    doneToday: !!(last && localDay(last.fetched_at, "America/New_York") === day),
    lastAt: last ? last.imported_at : null,
    lastFetchedAt: last ? last.fetched_at : null,
    sections: last ? parse(last.sections, null) : null,
    counts: last ? parse(last.counts, null) : null,
  };
}

/**
 * When KFB was last read successfully for one section (quotes | orders | bills), or null.
 * A re-import of unchanged rows writes nothing to the data tables, so their own
 * imported_at can't say how fresh the read is: this can.
 */
export async function lastSectionRead(db, section) {
  const { results } = await db.prepare(`SELECT fetched_at, sections FROM kfb_imports ORDER BY fetched_at DESC, id DESC LIMIT 30`).all()
    .catch(() => ({ results: [] }));
  for (const r of results || []) {
    const s = parse(r.sections, {});
    if (s && s[section] && s[section].ok) return r.fetched_at;
  }
  return null;
}

/** The latest import that read `section` OK: its fetched_at, section info and counts (or null). */
export async function lastSectionImport(db, section) {
  const { results } = await db.prepare(`SELECT fetched_at, sections, counts FROM kfb_imports ORDER BY fetched_at DESC, id DESC LIMIT 30`).all()
    .catch(() => ({ results: [] }));
  for (const r of results || []) {
    const s = parse(r.sections, {});
    if (s && s[section] && s[section].ok) return { fetched_at: r.fetched_at, info: s[section], counts: parse(r.counts, {}) };
  }
  return null;
}
