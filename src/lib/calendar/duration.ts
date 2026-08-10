/**
 * Runtime parsing for calendar event length.
 *
 * Source data reality (checked 2026-08-09 against data/shows.json): `runtime`
 * is populated on 631 of 2,884 shows — 22% — as human strings like "2h 30m".
 * The other 78% fall through to DEFAULT_RUNTIME_MIN, so that default is the
 * COMMON path, not an edge case. It is deliberately a round, obviously-generic
 * 2h30 rather than a precise-looking number: an event blocked 2h45 reads as a
 * real measurement, and being confidently wrong about when someone gets out of
 * a theatre is worse than being roundly approximate.
 */

/** Typical full-length show, used whenever `runtime` is missing or unparseable. */
export const DEFAULT_RUNTIME_MIN = 150;

/** Padding for curtain-up delay and getting out of the building. */
export const CURTAIN_BUFFER_MIN = 15;

/**
 * Parse "2h 30m", "2h", "95m", "1 hr 50 min", "2:30" → minutes. Returns null
 * when nothing sensible can be read, so callers can distinguish "no data" from
 * "genuinely short show" and apply the default themselves.
 */
export function parseRuntimeMinutes(runtime: string | null | undefined): number | null {
  if (!runtime) return null;
  const s = String(runtime).trim().toLowerCase();
  if (!s) return null;

  // "2:30" — colon form.
  const colon = s.match(/^(\d{1,2}):([0-5]\d)$/);
  if (colon) return Number(colon[1]) * 60 + Number(colon[2]);

  let total = 0;
  let matched = false;

  const hours = s.match(/(\d+(?:\.\d+)?)\s*(?:h(?:rs?|ours?)?)\b/);
  if (hours) {
    total += Math.round(parseFloat(hours[1]) * 60);
    matched = true;
  }

  const mins = s.match(/(\d+)\s*(?:m(?:ins?|inutes?)?)\b/);
  if (mins) {
    total += Number(mins[1]);
    matched = true;
  }

  if (!matched) return null;
  // A "runtime" of zero or a full day is data corruption, not a short play.
  if (total <= 0 || total > 8 * 60) return null;
  return total;
}

/**
 * The number the calendar event actually uses: parsed runtime plus buffer, or
 * the default plus buffer when runtime is absent or junk.
 */
export function resolveDurationMin(runtime: string | null | undefined): number {
  return (parseRuntimeMinutes(runtime) ?? DEFAULT_RUNTIME_MIN) + CURTAIN_BUFFER_MIN;
}
