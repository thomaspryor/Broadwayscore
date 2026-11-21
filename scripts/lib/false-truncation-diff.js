/**
 * false-truncation-diff.js — READ-ONLY: which stored review-text files change
 * content tier because of the trailer fix, and in which direction (zero-gap
 * plan 1C).
 *
 * rebuild-all-reviews.js re-tiers every file through classifyTierWriteBack and
 * writes the result back. This module asks that same function the same
 * question twice, without writing: once with the fix (default) and once with
 * TRAILER_FIXES_DISABLED=true (the pre-fix classifier). A file's tier moves
 * "because of the fix" only when the two answers differ. That separates the fix
 * from classifier drift that already exists in the corpus (stale stored tiers),
 * which a plain stored-vs-new diff would blame on it.
 */

'use strict';

const { classifyTierWriteBack } = require('./content-tier-reason-sync');

const EXCLUDED_FLAGS = ['duplicateOf', 'wrongShow', 'wrongProduction', 'isRoundupArticle'];

function tierWith(review, fixesOn) {
  const prev = process.env.TRAILER_FIXES_DISABLED;
  if (fixesOn) delete process.env.TRAILER_FIXES_DISABLED; else process.env.TRAILER_FIXES_DISABLED = 'true';
  try {
    return classifyTierWriteBack(review).tierResult.contentTier;
  } finally {
    if (prev === undefined) delete process.env.TRAILER_FIXES_DISABLED; else process.env.TRAILER_FIXES_DISABLED = prev;
  }
}

/**
 * @param {object} review parsed review-text file
 * @returns {null | {outletId:string, stored:string, before:string, after:string, tail:string}}
 *   null when the fix does not change this file's tier, or the file is flagged
 *   out of scoring. `before` = tier without the fix, `after` = with it.
 */
function diffTier(review) {
  if (!review || typeof review !== 'object') return null;
  if (EXCLUDED_FLAGS.some((f) => review[f])) return null;
  let before;
  let after;
  try {
    before = tierWith(review, false);
    after = tierWith(review, true);
  } catch {
    return null;
  }
  if (before === after) return null;
  return {
    outletId: review.outletId || '?',
    stored: review.contentTier,
    before,
    after,
    tail: String(review.fullText || '').replace(/\s+$/, '').slice(-160),
  };
}

/**
 * @param {Array<{file:string} & NonNullable<ReturnType<typeof diffTier>>>} records
 * @param {number} [sampleN]
 */
function summarize(records, sampleN = 5) {
  const by = new Map();
  let upgrades = 0;
  let downgrades = 0;
  let willChangeStored = 0;
  for (const rec of records) {
    const up = rec.before !== 'complete' && rec.after === 'complete';
    const down = rec.before === 'complete' && rec.after !== 'complete';
    if (up) upgrades++;
    if (down) downgrades++;
    if (rec.stored !== rec.after) willChangeStored++;
    if (!by.has(rec.outletId)) by.set(rec.outletId, { outletId: rec.outletId, upgrades: 0, downgrades: 0, truncatedToComplete: 0, samples: [] });
    const row = by.get(rec.outletId);
    if (down) row.downgrades++;
    if (!up) continue;
    row.upgrades++;
    if (rec.before === 'truncated') row.truncatedToComplete++;
    if (row.samples.length < sampleN) row.samples.push({ file: rec.file, tail: rec.tail });
  }
  const byOutlet = [...by.values()].sort((a, b) => b.upgrades - a.upgrades || a.outletId.localeCompare(b.outletId));
  return { total: records.length, upgrades, downgrades, willChangeStored, byOutlet };
}

module.exports = { diffTier, summarize, tierWith, EXCLUDED_FLAGS };
