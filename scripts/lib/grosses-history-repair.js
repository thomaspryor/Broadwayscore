/**
 * Shape rules for data/grosses-history.json, and the repair every history
 * writer runs before it saves (BRO-4985).
 *
 *   - Week keys are Sundays. A Broadway week ends on Sunday; the BWW-era
 *     writer stored 2026-06-22, 06-29 and 07-06 (Mondays), which made every
 *     reader that walks weeks by 7-day steps miss them. weekKeyFor() snaps a
 *     date to the nearest Sunday (within 3 days); repair renames any other
 *     key, keeping an existing Sunday entry's values on a shared slug.
 *   - seatsOffered is filled only where the published figures fix it: the
 *     one whole number of seats per performance whose attendance ÷ seats
 *     rounds back to the published capacity at its own precision (Wicked
 *     2026-08-09: 13,428 at 92.89% over 8 = 14,456). A coarse capacity (a
 *     flat 100, which Playbill rounds and caps) allows dozens of answers; it
 *     is filled only when two nearby pinned weeks agree on the house size.
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

/** Half the rounding step of a published capacity (92.89 → 0.005, 93.1 → 0.05, 100 → 0.5). */
function capacityHalfStep(capacity) {
  const frac = String(capacity).split('.')[1] || '';
  return 0.5 * 10 ** -Math.min(frac.length, 2);
}

function hasCountData(entry) {
  return Number.isFinite(entry?.attendance) && entry.attendance > 0
    && Number.isFinite(entry?.capacity) && entry.capacity > 0;
}

/**
 * Every whole seat count (a multiple of performances when known) that
 * rounds back to the published capacity at its own precision.
 */
function seatsOfferedCandidates(entry) {
  if (!hasCountData(entry)) return [];
  const { attendance, capacity } = entry;
  const step = Number.isInteger(entry.performances) && entry.performances > 0 ? entry.performances : 1;
  const half = capacityHalfStep(capacity) + 1e-9;
  const lo = (attendance * 100) / (capacity + half);
  const hi = (attendance * 100) / (capacity - half);
  const out = [];
  for (let s = Math.ceil(lo / step) * step; s <= hi && out.length <= 50; s += step) out.push(s);
  return out;
}

/**
 * Seats offered implied by a row's attendance and capacity, or null.
 * Only an answer the published figures pin down to one whole seat count
 * (per performance when performances is known) is returned; a coarse
 * capacity such as a flat 100 allows dozens and returns null, unless
 * `seatsPerPerfHint` (the same house's seats per performance, from weeks
 * that were pinned down) is one of them.
 * @param {{ attendance?: number|null, capacity?: number|null, performances?: number|null }} entry
 * @param {{ seatsPerPerfHint?: number|null }} [opts]
 */
function deriveSeatsOffered(entry, { seatsPerPerfHint = null } = {}) {
  const candidates = seatsOfferedCandidates(entry);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1 && seatsPerPerfHint && Number.isInteger(entry.performances) && entry.performances > 0) {
    const hinted = seatsPerPerfHint * entry.performances;
    if (candidates.includes(hinted)) return hinted;
  }
  return null;
}

/**
 * Seats per performance the two nearest regular weeks agree on (relative
 * tolerance `tol`; 0 = exactly), from their stored or pinned-down seats
 * offered, or null. An opening week the old backfill undercounted (4
 * previews + 4 performances stored as 4) doubles it and agrees with nothing.
 */
function houseSeatsPerPerf(neighbours, tol = 0) {
  const perPerfs = [];
  for (const nb of neighbours || []) {
    if (!(Number.isInteger(nb?.performances) && nb.performances > 0)) continue;
    const nbOffered = nb.seatsOffered || deriveSeatsOffered(nb);
    if (!nbOffered) continue;
    perPerfs.push(nbOffered / nb.performances);
    if (perPerfs.length === 2) break;
  }
  if (perPerfs.length < 2 || Math.abs(perPerfs[0] - perPerfs[1]) / perPerfs[0] > tol) return null;
  return perPerfs[0];
}

/**
 * Performances for a row stored with 0 despite a gross, from a nearby
 * regular week of the same production, or null when not provable.
 * @param {object} entry
 * @param {object[]} neighbours - same slug's entries from nearby weeks, nearest first
 */
function derivePreviewPerformances(entry, neighbours) {
  if (!hasCountData(entry)) return null;
  const offered = (entry.attendance * 100) / entry.capacity;
  const perPerf = houseSeatsPerPerf(neighbours, WHOLE_COUNT_TOLERANCE);
  if (!perPerf) return null;
  const n = offered / perPerf;
  const count = Math.round(n);
  if (count < 1 || count > MAX_WEEKLY_PERFORMANCES || Math.abs(n - count) > WHOLE_COUNT_TOLERANCE) return null;
  return count;
}

/**
 * Repair a grosses-history object in place.
 * @returns {{ renamedKeys: Array<[string, string]>, seatsOfferedFilled: number, performancesFilled: number }}
 */
/**
 * Move every non-Sunday week key onto its Sunday in place (an existing
 * Sunday entry wins on a shared slug), keeping keys in date order.
 * @returns {Array<[string, string]>} the [from, to] renames
 */
function normalizeWeekKeys(history) {
  const renamed = [];
  if (!history || typeof history.weeks !== 'object' || history.weeks === null) return renamed;
  const weeks = history.weeks;
  for (const key of nonSundayWeekKeys(history)) {
    const target = weekKeyFor(key);
    if (target === key || !ISO_DATE_RE.test(target)) continue;
    weeks[target] = { ...weeks[key], ...(weeks[target] || {}) };
    delete weeks[key];
    renamed.push([key, target]);
  }
  if (renamed.length) {
    const sorted = {};
    for (const k of Object.keys(weeks).sort()) sorted[k] = weeks[k];
    history.weeks = sorted;
  }
  return renamed;
}

function repairGrossesHistory(history) {
  const stats = { renamedKeys: [], seatsOfferedFilled: 0, performancesFilled: 0 };
  if (!history || typeof history.weeks !== 'object' || history.weeks === null) return stats;
  stats.renamedKeys = normalizeWeekKeys(history);

  const keys = Object.keys(history.weeks).sort();
  const bySlug = new Map();
  keys.forEach((k, i) => {
    for (const [slug, entry] of Object.entries(history.weeks[k] || {})) {
      if (!bySlug.has(slug)) bySlug.set(slug, []);
      bySlug.get(slug).push({ i, entry });
    }
  });

  const isRow = (e) => e && typeof e === 'object';
  // Same slug's entries within NEIGHBOUR_WEEKS of row idx, nearest first.
  const neighboursOf = (rows, idx) => {
    const out = [];
    for (let d = 1; d <= NEIGHBOUR_WEEKS; d++) {
      for (const j of [idx + d, idx - d]) {
        const nb = rows[j];
        if (nb && Math.abs(nb.i - rows[idx].i) <= NEIGHBOUR_WEEKS) out.push(nb.entry);
      }
    }
    return out;
  };

  for (const rows of bySlug.values()) {
    rows.forEach(({ entry }, idx) => {
      if (!isRow(entry) || !(entry.performances === 0 && entry.gross > 0)) return;
      const perfs = derivePreviewPerformances(entry, neighboursOf(rows, idx));
      if (perfs) {
        entry.performances = perfs;
        stats.performancesFilled++;
      }
    });
    // Unknown perf count (0) has no whole-seat check: skip those rows.
    const open = (e) => isRow(e) && e.seatsOffered == null && e.performances !== 0;
    // Pass 1: rows the published figures pin to one seat count.
    for (const { entry } of rows) {
      if (!open(entry)) continue;
      const offered = deriveSeatsOffered(entry);
      if (offered) {
        entry.seatsOffered = offered;
        stats.seatsOfferedFilled++;
      }
    }
    // Pass 2: coarse rows (a flat 100%) take the house size two pinned
    // neighbours agree on exactly, when it is one of their candidates.
    // Collected first so a hinted row never lends its value onward.
    const hinted = [];
    rows.forEach(({ entry }, idx) => {
      if (!open(entry)) return;
      const hint = houseSeatsPerPerf(neighboursOf(rows, idx), 0);
      const offered = hint ? deriveSeatsOffered(entry, { seatsPerPerfHint: hint }) : null;
      if (offered) hinted.push([entry, offered]);
    });
    for (const [entry, offered] of hinted) {
      entry.seatsOffered = offered;
      stats.seatsOfferedFilled++;
    }
  }
  return stats;
}

module.exports = {
  isSundayKey,
  weekKeyFor,
  nonSundayWeekKeys,
  normalizeWeekKeys,
  deriveSeatsOffered,
  derivePreviewPerformances,
  repairGrossesHistory,
};
