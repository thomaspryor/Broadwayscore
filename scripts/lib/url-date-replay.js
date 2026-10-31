/**
 * URL-date replay for scoring-delta.js (BRO-6628, from the BRO-6585 postmortem).
 *
 * extractDateFromUrl lives in rebuild-helpers.js and feeds the date guards in
 * rebuild-all-reviews.js, but scoring-delta's guard replays use publishDate only
 * and Phase B's getBestScore replay never reads the URL date, so a change to
 * extractDateFromUrl reported 0/0/0 while it moved 2,339 files. This compares the
 * baseline and working-tree extractors directly, per review URL.
 */
'use strict';

function normalize(result) {
  if (!result) return null;
  return { date: result.date || null, source: result.source || null, yearOnly: result.yearOnly || null };
}

function same(a, b) {
  if (a === null || b === null) return a === b;
  return a.date === b.date && a.source === b.source && a.yearOnly === b.yearOnly;
}

/**
 * @param {(url: string) => (object|null)} baselineFn extractDateFromUrl from HEAD's rebuild-helpers
 * @param {(url: string) => (object|null)} workingFn  extractDateFromUrl from the working tree
 * @param {string} url
 * @returns {{baseline: object|null, working: object|null}|null} null when both agree
 */
function diffUrlDate(baselineFn, workingFn, url) {
  if (!url || typeof baselineFn !== 'function' || typeof workingFn !== 'function') return null;
  const baseline = normalize(baselineFn(url));
  const working = normalize(workingFn(url));
  return same(baseline, working) ? null : { baseline, working };
}

function describeUrlDate(r) {
  if (!r) return 'none';
  return `${r.date || r.yearOnly || '?'}(${r.source || '?'})`;
}

module.exports = { diffUrlDate, describeUrlDate };
