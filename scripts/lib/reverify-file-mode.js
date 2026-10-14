'use strict';
/**
 * reverify-file-mode — the --file selector of reverify-stale-cv-promoted.js
 * (BRO-5243). Rows named by hand carry no exclusion flag, so an unclean
 * verdict written onto one could newly exclude a live review (the rebuild
 * promotes high-confidence wrongArticle/wrongProduction). Such a verdict is
 * held unless the operator opts in with --allow-new-exclusion.
 */

/** "<show>/<file>.json[,...]" -> [{ showId, file }]; throws on anything else. */
function parseFileSpecs(value) {
  return String(value || '').split(',').filter(Boolean).map((spec) => {
    const parts = spec.split('/');
    const [showId, file] = parts;
    if (parts.length !== 2 || !showId || !file || !file.endsWith('.json')
      || showId.includes('..') || file.includes('..')) {
      throw new Error(`--file expects <show-id>/<file>.json, got "${spec}"`);
    }
    return { showId, file };
  });
}

const EXCLUSION_FLAGS = ['wrongShow', 'wrongProduction', 'isNonReview'];

/** The verdict would exclude the row if stored (the rebuild promotes these). */
function verdictExcludes(result) {
  return Boolean(!result || !result.isValid || result.wrongArticle || result.wrongProduction || result.isFilmTv);
}

/**
 * Why a --file verdict must be printed only, never written, or null to write.
 * A row that already carries an exclusion flag is held: its flag may be a
 * human's or another source's (not the verifier's), and storing a clean
 * hash-matching verdict next to a kept flag strands it out of every later
 * audit (BRO-5261). The selector sweeps own flagged rows. An unflagged row is
 * held only when the verdict would newly exclude it (BRO-5243); a valid
 * medium-confidence verdict is stored.
 */
function fileModeHoldReason({ fileMode, data, result, allowNewExclusion }) {
  if (!fileMode) return null;
  const flag = EXCLUSION_FLAGS.find((k) => data && data[k]);
  if (flag) return `row is ${flag}; flagged rows are re-verified by the selector sweeps`;
  if (verdictExcludes(result) && !allowNewExclusion) return 'verdict would newly exclude a hand-picked row (pass --allow-new-exclusion to store it)';
  return null;
}

module.exports = { parseFileSpecs, fileModeHoldReason, verdictExcludes };
