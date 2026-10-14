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

/** True when a --file verdict must be printed only, never written. */
function holdFileModeVerdict({ fileMode, clean, allowNewExclusion }) {
  return Boolean(fileMode && !clean && !allowNewExclusion);
}

module.exports = { parseFileSpecs, holdFileModeVerdict };
