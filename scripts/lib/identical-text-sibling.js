/**
 * BRO-5321: one article's text stored under two critics on the same show
 * (623 groups, 2026-10-14) double counts a review or credits the wrong critic.
 * collect-review-texts.js's fingerprint pass (1C) catches this only on its own
 * path; show-score, BWW, DTLI and the domain-redirect writers never ran it.
 *
 * findIdenticalTextSibling() is the write-time check safeWriteReview runs for
 * every writer: when a write introduces or changes a body that a same-show
 * sibling already holds word for word under a different named critic, it
 * names that sibling so the guard can set the existing duplicateTextOf
 * pointer. The text is kept (merge-then-delete flows need it), and the rebuild
 * re-admits the row if the sibling later goes away or is excluded.
 *
 * Same outlet only: one body under two OUTLETS is usually a contaminated
 * fetch (china-doll-2015: five outlets, one body), where pointing the newcomer
 * at the sibling would drop a real, distinct review. Those stay audit and
 * byline work (audit-identical-text-across-critics.js).
 *
 * Pure: the caller does the I/O.
 */
'use strict';

const { normalizeCritic, normalizeOutlet } = require('./review-normalization');
const { pointsAtFile } = require('./canonical-duplicate-pointers');
const { isExcludedRow } = require('./variety-promo-bleed');

/** Same threshold and normalisation as audit-identical-text-across-critics.js. */
const MIN_IDENTICAL_CHARS = 400;
const body = (t) => (typeof t === 'string' ? t.replace(/\s+/g, ' ').trim() : '');
const named = (c) => {
  const n = normalizeCritic(c || '');
  return n && n !== 'unknown' ? n : null;
};

const outletOf = (d, file) => normalizeOutlet(d.outletId || d.outlet || String(file || '').split('--')[0]);

/**
 * @param {object} args
 * @param {string} args.thisFile      basename being written
 * @param {object} args.newData       record about to be written
 * @param {object|null} args.existingData  the on-disk record, if any
 * @param {{file:string, data:object}[]} args.siblings  other records in the show dir
 * @returns {string|null} sibling file whose body this text duplicates, or null
 */
function findIdenticalTextSibling({ thisFile, newData, existingData, siblings }) {
  if (!newData) return null;
  if (newData.duplicateTextOf || newData.duplicateOf || newData.duplicateTextOfCleared) return null;
  const text = body(newData.fullText);
  if (text.length < MIN_IDENTICAL_CHARS) return null;
  // Only text this write introduces or changes: a legacy pair already on disk
  // is step-2 data work (byline verification), not something to flip silently
  // on an unrelated enrichment write.
  if (existingData && body(existingData.fullText) === text) return null;
  // Placeholder bylines (unknown) and same-critic copies are the merge and
  // rename flows (outlet-mismatch-heal, safeRenameReview); the rebuild's
  // same-outlet fingerprint dedup already handles those.
  const critic = named(newData.criticName);
  if (!critic) return null;
  const outlet = outletOf(newData, thisFile);
  for (const s of siblings || []) {
    if (!s || !s.data || s.file === thisFile) continue;
    const d = s.data;
    // Point at an includable canonical only: the rebuild inherits an excluded
    // target's exclusion, which would drop this row for the sibling's reason.
    if (d.duplicateTextOf || isExcludedRow(d)) continue;
    if (outletOf(d, s.file) !== outlet) continue;
    if (pointsAtFile(d, thisFile)) continue; // would close a cycle (BRO-3102)
    const other = named(d.criticName);
    if (!other || other === critic) continue;
    if (body(d.fullText) !== text) continue;
    return s.file;
  }
  return null;
}

module.exports = { findIdenticalTextSibling, MIN_IDENTICAL_CHARS };
