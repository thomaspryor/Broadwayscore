'use strict';

/**
 * cross-market-contamination.js
 *
 * Single source of truth for the STRICT Category-A cross-market /
 * cross-production contamination predicate. A review is class-A contaminated
 * when its publishDate clusters with a same-title SIBLING production's opening
 * (within NEAR_SIBLING_DAYS) yet is far (> FAR_OWN_SHOW_DAYS) from its OWN
 * show's opening — i.e. the review almost certainly belongs to the sibling run,
 * not the folder it is filed under.
 *
 * Extracted per CLAUDE.md rule 15 (test-extraction) so the two callers cannot
 * drift:
 *   - scripts/audit-review-contamination.js — the zero-tolerance CI gate (class A).
 *   - scripts/fix-circular-duplicate-pairs.js — canonical selection, which must
 *     NEVER clear the duplicateOf of a class-A member (doing so un-suppressed a
 *     cross-market review and reddened main on 2026-07-12).
 *
 * Pure — no I/O. Accepts Date objects, epoch numbers, or null/undefined.
 */

const MS_PER_DAY = 86400000;

// A review dated within this many days of a same-title sibling's opening...
const NEAR_SIBLING_DAYS = 30;
// ...but more than this many days from its OWN show's opening is class-A.
const FAR_OWN_SHOW_DAYS = 180;

/**
 * Normalize a show title for sibling grouping. Same-title shows (different ids)
 * are the sibling productions the predicate compares against. Shared so the
 * audit's sibling map and fix-circular's are grouped identically — a divergence
 * here would silently change which shows count as siblings.
 */
function normalizeShowTitle(t) {
  return String(t || '').toLowerCase().trim().replace(/[!?.,'"]/g, '');
}

/**
 * Build a Map<showId, epoch[]> of same-title siblings' opening epochs.
 * @param {Array<{id:string,title:string,openingDate:*}>} shows
 * @param {(v:*)=>*} parseDate  date parser (returns Date|number|null)
 */
function buildSiblingOpeningsMap(shows, parseDate) {
  const byTitle = new Map();
  for (const s of shows) {
    if (!s || !s.id) continue;
    const t = normalizeShowTitle(s.title);
    if (!t) continue;
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(s);
  }
  const out = new Map();
  for (const s of shows) {
    if (!s || !s.id) continue;
    const t = normalizeShowTitle(s.title);
    const group = (t && byTitle.get(t)) || [];
    const openings = [];
    for (const sib of group) {
      if (sib.id === s.id) continue;
      const e = toEpoch(parseDate(sib.openingDate));
      if (Number.isFinite(e)) openings.push(e);
    }
    out.set(s.id, openings);
  }
  return out;
}

/** Coerce a Date | number | date-string | null into an epoch (ms), or NaN. */
function toEpoch(v) {
  if (v == null || v === '') return NaN; // guard "" — +"" is 0 (epoch 1970), not "no date"
  const n = +v; // +Date -> epoch, +number -> number
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Classify a review against the strict Category-A predicate.
 *
 * @param {Date|number|null} pubDate          the review's publishDate
 * @param {Date|number|null} showOpening      the folder show's openingDate
 * @param {Array<Date|number|null>} siblingOpenings same-title siblings' opening dates
 * @returns {{ isClassA: boolean, thisDiff: number|null, sibDiff: number|null, sibIndex: number }}
 *   isClassA — trips the gate; thisDiff / sibDiff — days from own / nearest-sibling
 *   opening (null when not computable); sibIndex — position of the nearest sibling
 *   in siblingOpenings (-1 if none), so a caller can map it back to a sibling id
 *   for reporting parity with the audit.
 */
function classifyClassAContamination(pubDate, showOpening, siblingOpenings) {
  const pub = toEpoch(pubDate);
  const own = toEpoch(showOpening);
  if (!Number.isFinite(pub) || !Number.isFinite(own) || !Array.isArray(siblingOpenings)) {
    return { isClassA: false, thisDiff: null, sibDiff: null, sibIndex: -1 };
  }
  let best = Infinity, bestIndex = -1;
  for (let i = 0; i < siblingOpenings.length; i++) {
    const e = toEpoch(siblingOpenings[i]);
    if (!Number.isFinite(e)) continue;
    const diff = Math.abs(pub - e) / MS_PER_DAY;
    if (diff < best) { best = diff; bestIndex = i; }
  }
  if (!Number.isFinite(best)) return { isClassA: false, thisDiff: null, sibDiff: null, sibIndex: -1 };
  const thisDiff = Math.abs(pub - own) / MS_PER_DAY;
  const isClassA = best <= NEAR_SIBLING_DAYS && thisDiff > FAR_OWN_SHOW_DAYS;
  return { isClassA, thisDiff, sibDiff: best, sibIndex: bestIndex };
}

module.exports = {
  classifyClassAContamination,
  normalizeShowTitle,
  buildSiblingOpeningsMap,
  NEAR_SIBLING_DAYS,
  FAR_OWN_SHOW_DAYS,
};
