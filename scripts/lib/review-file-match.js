'use strict';
/**
 * Which review-text file belongs to this outlet + critic? (BRO-3943)
 * Filenames are `<outlet>--<critic>[-suffix].json`. A match needs the outlet
 * AND the critic: a critic-name-only match let a roundup excerpt attach to a
 * different outlet's file for a same-named critic.
 *
 * findMatchingReviewFile tries, in order, and returns the first tier's hit:
 *   1. exact outlet segment            (timeout--x for outlet "timeout")
 *   2. segment that normalizes to the outlet (legacy spellings: guardian-uk)
 *   3. an edition of the outlet        (timeout-london--x for outlet "timeout";
 *      files renamed by URL edition). One direction only: a roundup for the
 *      London edition never merges into the New York outlet's file.
 * Exact first matters: readdir order must not let a sibling edition win.
 */
function split(file) {
  const i = file.indexOf('--');
  return i < 0 ? null : { segment: file.slice(0, i), rest: file.slice(i + 2) };
}

function criticMatches(rest, criticNorm) {
  return rest.startsWith(criticNorm + '.json') || rest.startsWith(criticNorm + '-');
}

function findMatchingReviewFile(files, outletNorm, criticNorm, normalizeOutlet) {
  const parts = files.map((file) => ({ file, p: split(file) })).filter((x) => x.p && criticMatches(x.p.rest, criticNorm));
  const hit = (pred) => { const m = parts.find((x) => pred(x.p.segment)); return m ? m.file : null; };
  return hit((s) => s === outletNorm)
    || (typeof normalizeOutlet === 'function' ? hit((s) => normalizeOutlet(s) === outletNorm) : null)
    || hit((s) => s.startsWith(outletNorm + '-'));
}

function matchesOutletCriticFile(file, outletNorm, criticNorm, normalizeOutlet) {
  return findMatchingReviewFile([file], outletNorm, criticNorm, normalizeOutlet) === file;
}

/**
 * BRO-7293: may a url-less roundup excerpt attach to this file? Not when the file is
 * flagged wrongProduction/wrongShow or a duplicate pointer: those hold an earlier
 * production's review, and the excerpt (and the date it brings) would make the old text
 * look like the new review (Cititour/Lipton NYTW 2024 review shown for the Broadway run).
 * Unreadable file = not flagged (the caller's own read decides).
 */
function isFlaggedForRoundupMerge(filePath) {
  try {
    const d = JSON.parse(require('fs').readFileSync(filePath, 'utf8'));
    return !!(d.wrongProduction || d.wrongShow || d.duplicateOf);
  } catch (_) { return false; }
}

/** `<outlet>--<critic>.json` -> first free `<outlet>--<critic>-2.json`, `-3`, ... (the critic match accepts `-<n>`). */
function uniqueReviewFilename(showDir, filename) {
  const fs = require('fs'); const path = require('path');
  if (!fs.existsSync(path.join(showDir, filename))) return filename;
  const base = filename.replace(/\.json$/, '');
  for (let n = 2; n < 100; n++) {
    const cand = `${base}-${n}.json`;
    if (!fs.existsSync(path.join(showDir, cand))) return cand;
  }
  return filename;
}
module.exports = { findMatchingReviewFile, matchesOutletCriticFile, isFlaggedForRoundupMerge, uniqueReviewFilename };
