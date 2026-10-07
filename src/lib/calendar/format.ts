/**
 * Date/time formatting shared by the showtimes grid and the showtime picker.
 *
 * Extracted from ShowtimesCard.tsx, which had them as private module functions
 * (CLAUDE.md §15 extract → export → wire back). ShowtimesCard now imports these;
 * there is no second copy. The picker needs the exact same clock formatting as
 * the grid it reads its suggestions from, and two implementations would drift.
 */

/** "14:00" → "2:00 PM". */
export function formatTime(time24: string): string {
  const [h, m] = time24.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${m.toString().padStart(2, '0')} ${suffix}`;
}

/**
 * "20260914" → Date at local midnight.
 *
 * Built from components rather than `new Date(string)` on purpose: the string
 * form is parsed as UTC by every engine, which lands on the previous day for
 * anyone west of Greenwich.
 */
export function parseYyyymmdd(yyyymmdd: string): Date {
  return new Date(
    parseInt(yyyymmdd.slice(0, 4)),
    parseInt(yyyymmdd.slice(4, 6)) - 1,
    parseInt(yyyymmdd.slice(6, 8)),
  );
}

/** "20260914" + 3 → "2026-09-17". Day index 0 returns the base date itself. */
export function addDaysToYyyymmdd(yyyymmdd: string, dayIndex: number): string {
  const d = parseYyyymmdd(yyyymmdd);
  d.setDate(d.getDate() + dayIndex);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
