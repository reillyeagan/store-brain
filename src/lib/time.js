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
