/** Time helpers. All stored timestamps are UTC ISO strings. */

export const nowIso = (ms = Date.now()) => new Date(ms).toISOString();

/**
 * The calendar day (YYYY-MM-DD) of a moment, in a given IANA timezone.
 * P&L days are always the store's local day, never UTC and never KFB's China time.
 */
export function localDay(isoOrMs, timeZone = "America/New_York") {
  const d = typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) throw new Error(`localDay: not a date: ${isoOrMs}`);
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

export const minutesBetween = (aMs, bMs) => Math.abs(bMs - aMs) / 60000;

/**
 * The UTC instant (ms) a calendar day begins in a timezone. Searched in 15-minute steps
 * around UTC midnight, so DST days (23 or 25 hours) and half-hour offsets come out right.
 */
export function startOfLocalDayMs(day, timeZone = "America/New_York") {
  const base = Date.parse(`${day}T00:00:00Z`);
  const STEP = 15 * 60000;
  for (let t = base - 15 * 3600000; t <= base + 15 * 3600000; t += STEP) {
    if (localDay(t, timeZone) === day && localDay(t - STEP, timeZone) !== day) return t;
  }
  return base;
}

/** The UTC instant (ms) a calendar day ends (= the next day begins) in a timezone. */
export function endOfLocalDayMs(day, timeZone = "America/New_York") {
  const next = new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return startOfLocalDayMs(next, timeZone);
}
