/**
 * Shape rules for data/grosses-history.json, and the repair every history
 * writer runs before it saves (BRO-4985).
 *
 *   - Week keys are Sundays. A Broadway week ends on Sunday; the BWW-era
 *     writer stored 2026-06-22, 06-29 and 07-06 (Mondays), which made every
 *     reader that walks weeks by 7-day steps miss them. weekKeyFor() snaps a
 *     date to the nearest Sunday (within 3 days); repair renames any other
 *     key, keeping an existing Sunday entry's values on a shared slug.
 *   - seatsOffered is filled wherever the published figures fix it:
 *     attendance ÷ (capacity ÷ 100), snapped to a whole number of seats per
 *     performance when that still reproduces the published capacity within
 *     0.05 points (Wicked 2026-08-09: 13,428 at 92.89% over 8 = 14,456).
 *   - performances is 0 on preview-only weeks the old backfill wrote (it
 *     kept Playbill's "Perfs" and dropped "Previews": Sweeney Todd
 *     2023-03-12 is 0 + 7). It is recomputed only when the week's seats
 *     offered divide by the same production's seats per performance (two
 *     nearby regular weeks agreeing) to within 1% of a whole count;
 *     otherwise it stays.
 *
 * Pure: no I/O.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const CAPACITY_TOLERANCE = 0.05;
// A regular week this many weeks either side may lend its seats per performance.
const NEIGHBOUR_WEEKS = 5;
const WHOLE_COUNT_TOLERANCE = 0.01;
const MAX_WEEKLY_PERFORMANCES = 10;

const isoToMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
const msToIso = (ms) => new Date(ms).toISOString().slice(0, 10);

function isSundayKey(key) {
  return ISO_DATE_RE.test(key || '') && new Date(isoToMs(key)).getUTCDay() === 0;
}

/** The Sunday a YYYY-MM-DD date belongs to: itself, or the nearest Sunday. */
function weekKeyFor(iso) {
  if (!ISO_DATE_RE.test(iso || '')) return iso;
  const ms = isoToMs(iso);
  const dow = new Date(ms).getUTCDay();
  if (dow === 0) return iso;
  // Mon-Wed belong to the Sunday before, Thu-Sat to the Sunday after.
  return msToIso(ms + (dow <= 3 ? -dow : 7 - dow) * DAY_MS);
}

/** History week keys that are not Sundays. */
function nonSundayWeekKeys(history) {
  return Object.keys(history?.weeks || {}).filter((k) => !isSundayKey(k));
}

function reproducesCapacity(attendance, offered, capacity) {
  return offered > 0 && Math.abs((attendance / offered) * 100 - capacity) < CAPACITY_TOLERANCE;
}

/**
 * Seats offered implied by a row's attendance and capacity, or null.
 * @param {{ attendance?: number|null, capacity?: number|null, performances?: number|null }} entry
 */
function deriveSeatsOffered(entry) {
  const attendance = entry?.attendance;
  const capacity = entry?.capacity;
  if (!(Number.isFinite(attendance) && attendance > 0 && Number.isFinite(capacity) && capacity > 0)) return null;
  const raw = (attendance * 100) / capacity;
  const perfs = entry.performances;
  if (Number.isInteger(perfs) && perfs > 0) {
    const whole = Math.round(raw / perfs) * perfs;
    if (reproducesCapacity(attendance, whole, capacity)) return whole;
  }
  const rounded = Math.round(raw);
  return reproducesCapacity(attendance, rounded, capacity) ? rounded : null;
}

/**
 * Performances for a row stored with 0 despite a gross, from a nearby
 * regular week of the same production, or null when not provable.
 * @param {object} entry
 * @param {object[]} neighbours - same slug's entries from nearby weeks, nearest first
 */
function derivePreviewPerformances(entry, neighbours) {
  const offered = deriveSeatsOffered({ ...entry, performances: null });
  if (!offered) return null;
  // The two nearest regular weeks must agree on seats per performance: an
  // opening week the old backfill also undercounted (4 previews + 4
  // performances stored as 4) doubles it, and would agree with nothing.
  const perPerfs = [];
  for (const nb of neighbours) {
    if (!(Number.isInteger(nb?.performances) && nb.performances > 0)) continue;
    const nbOffered = nb.seatsOffered || deriveSeatsOffered(nb);
    if (!nbOffered) continue;
    perPerfs.push(nbOffered / nb.performances);
    if (perPerfs.length === 2) break;
  }
  if (perPerfs.length < 2 || Math.abs(perPerfs[0] - perPerfs[1]) / perPerfs[0] > WHOLE_COUNT_TOLERANCE) return null;
  const n = offered / perPerfs[0];
  const count = Math.round(n);
  if (count < 1 || count > MAX_WEEKLY_PERFORMANCES || Math.abs(n - count) > WHOLE_COUNT_TOLERANCE) return null;
  return count;
}

/**
 * Repair a grosses-history object in place.
 * @returns {{ renamedKeys: Array<[string, string]>, seatsOfferedFilled: number, performancesFilled: number }}
 */
function repairGrossesHistory(history) {
  const stats = { renamedKeys: [], seatsOfferedFilled: 0, performancesFilled: 0 };
  if (!history || typeof history.weeks !== 'object' || history.weeks === null) return stats;
  const weeks = history.weeks;

  for (const key of nonSundayWeekKeys(history)) {
    const target = weekKeyFor(key);
    if (target === key || !ISO_DATE_RE.test(target)) continue;
    weeks[target] = { ...weeks[key], ...(weeks[target] || {}) };
    delete weeks[key];
    stats.renamedKeys.push([key, target]);
  }

  // Keep the file's chronological key order after a rename.
  if (stats.renamedKeys.length) {
    const sorted = {};
    for (const k of Object.keys(weeks).sort()) sorted[k] = weeks[k];
    history.weeks = sorted;
  }

  const keys = Object.keys(history.weeks).sort();
  const bySlug = new Map();
  keys.forEach((k, i) => {
    for (const [slug, entry] of Object.entries(history.weeks[k] || {})) {
      if (!bySlug.has(slug)) bySlug.set(slug, []);
      bySlug.get(slug).push({ i, entry });
    }
  });

  for (const rows of bySlug.values()) {
    rows.forEach(({ i, entry }, idx) => {
      if (!entry || typeof entry !== 'object') return;
      if (entry.performances === 0 && entry.gross > 0) {
        const neighbours = [];
        for (let d = 1; d <= NEIGHBOUR_WEEKS; d++) {
          for (const j of [idx + d, idx - d]) {
            const nb = rows[j];
            if (nb && Math.abs(nb.i - i) <= NEIGHBOUR_WEEKS) neighbours.push(nb.entry);
          }
        }
        const perfs = derivePreviewPerformances(entry, neighbours);
        if (perfs) {
          entry.performances = perfs;
          stats.performancesFilled++;
        }
      }
    });
    for (const { entry } of rows) {
      if (!entry || typeof entry !== 'object' || entry.seatsOffered != null) continue;
      if (entry.performances === 0) continue; // unknown perf count: no whole-seat check
      const offered = deriveSeatsOffered(entry);
      if (offered) {
        entry.seatsOffered = offered;
        stats.seatsOfferedFilled++;
      }
    }
  }
  return stats;
}

module.exports = {
  isSundayKey,
  weekKeyFor,
  nonSundayWeekKeys,
  deriveSeatsOffered,
  derivePreviewPerformances,
  repairGrossesHistory,
};
