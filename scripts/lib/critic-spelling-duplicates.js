/**
 * Same-show, same-outlet critic-name near-duplicate detector (BRO-4156).
 *
 * INCIDENT: london-theatre--cheryl-markoski.json and
 * london-theatre--cheryl-markosky.json were two FILES for the SAME critic
 * covering the SAME review (how-the-other-half-loves-west-end-2026) — one
 * spelling was a typo (the outlet's own byline reads "Cheryl Markosky"). The
 * misspelled filename/criticName carried real content (url, aggregator
 * cross-validation, an anchored-v6 score) that a plain "same file already
 * exists" dedup check never catches, because the two spellings produce two
 * different filenames and never collide — so the show's composite score
 * double-counted that one critic's verdict.
 *
 * Scope is deliberately SAME SHOW + SAME OUTLET, not outlet-wide: a
 * corpus-wide byline-typo scan (any two spellings ever seen at an outlet)
 * returns ~170 hits across the whole corpus, almost all of them a one-off
 * OCR/scrape typo on a DIFFERENT article by the same critic (no duplicate
 * file, no double-count — just a cosmetic misspelling already smoothed over
 * by data/auto-critic-aliases.json at score-canonicalization time). The
 * actual defect this ticket fixes — two files fighting over one show's one
 * critic slot — only shows up when the near-duplicate spelling collides on
 * the SAME (showId, outletId) pair, which is what findSpellingDuplicates()
 * groups on.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { levenshteinDistance } = require('./deduplication');
const { listShowDirs } = require('./list-show-dirs');

/** Lowercase, strip accents/punctuation, collapse whitespace. */
function foldName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when two criticName spellings look like the same person typo'd two
 * ways (Markoski/Markosky), not two different critics.
 *
 * Guards against false positives on genuinely different critics:
 *  - identical (folded) names are not a "duplicate spelling" finding at all
 *  - names under 6 folded chars are too short for edit distance to be
 *    meaningful ("Al"/"Ed"-length names)
 *  - a different word count ("Cheryl Markosky" vs "Cheryl Markosky Jones")
 *    means a structural difference, not a spelling variant
 *  - the edit distance must be small BOTH absolutely (<=2) and relative to
 *    length (<=20%) — "Markos Papadatos" vs "Cheryl Markosky" shares a
 *    substring but is nowhere near either bound
 */
function isNearDuplicateCriticName(nameA, nameB) {
  const a = foldName(nameA);
  const b = foldName(nameB);
  if (!a || !b || a === b) return false;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen < 6) return false;
  if (a.split(' ').length !== b.split(' ').length) return false;
  const distance = levenshteinDistance(a, b);
  if (distance === 0) return false;
  return distance <= 2 && distance / maxLen <= 0.2;
}

/**
 * Group critic-name records by (showId, outletId) and find near-duplicate
 * spelling pairs WITHIN each group — i.e. two files that both claim to be
 * the same outlet's coverage of the same show, under two spellings of what
 * is almost certainly one critic.
 *
 * @param {{outletId:string, criticName:string, showId:string, file?:string}[]} records
 * @param {{allow?: Set<string>}} [opts] - allow: set of
 *   "showId::outletId::nameA::nameB" keys (either name order) known-good and
 *   never flagged — e.g. two genuinely different critics who both covered
 *   the same show for the same outlet under close-but-real names.
 * @returns {{showId:string, outletId:string, nameA:string, nameB:string, examplesA:string[], examplesB:string[]}[]}
 */
function findSpellingDuplicates(records, opts = {}) {
  const allow = opts.allow || new Set();
  const byGroup = new Map(); // "showId::outletId" -> Map(criticName -> file[])
  for (const r of records) {
    if (!r.outletId || !r.criticName || !r.showId) continue;
    const groupKey = `${r.showId}::${r.outletId}`;
    if (!byGroup.has(groupKey)) byGroup.set(groupKey, new Map());
    const names = byGroup.get(groupKey);
    if (!names.has(r.criticName)) names.set(r.criticName, []);
    names.get(r.criticName).push(r.file || r.criticName);
  }
  const findings = [];
  for (const [groupKey, names] of byGroup) {
    if (names.size < 2) continue;
    const [showId, outletId] = groupKey.split('::');
    const uniqueNames = [...names.keys()];
    for (let i = 0; i < uniqueNames.length; i++) {
      for (let j = i + 1; j < uniqueNames.length; j++) {
        const a = uniqueNames[i];
        const b = uniqueNames[j];
        const allowKeyAB = `${showId}::${outletId}::${a}::${b}`;
        const allowKeyBA = `${showId}::${outletId}::${b}::${a}`;
        if (allow.has(allowKeyAB) || allow.has(allowKeyBA)) continue;
        if (!isNearDuplicateCriticName(a, b)) continue;
        findings.push({
          showId,
          outletId,
          nameA: a,
          nameB: b,
          examplesA: names.get(a),
          examplesB: names.get(b),
        });
      }
    }
  }
  return findings;
}

/**
 * Scan a review-texts corpus directory for same-show, same-outlet
 * critic-name near-duplicates. Tolerates a missing/partial checkout via
 * listShowDirs() (dangling symlinks etc. are skipped, not fatal — see
 * list-show-dirs.js).
 *
 * @param {string} reviewTextsDir
 * @param {{allow?: Set<string>}} [opts]
 */
function scanReviewTextsForCriticDuplicates(reviewTextsDir, opts = {}) {
  const records = [];
  let scanned = 0;
  for (const showId of listShowDirs(reviewTextsDir, { silent: true })) {
    const showDir = path.join(reviewTextsDir, showId);
    let files;
    try {
      files = fs.readdirSync(showDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'failed-fetches.json') continue;
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      } catch {
        continue;
      }
      if (!data.outletId || !data.criticName) continue;
      scanned++;
      records.push({ outletId: data.outletId, criticName: data.criticName, showId, file });
    }
  }
  return { findings: findSpellingDuplicates(records, opts), scanned };
}

module.exports = {
  foldName,
  isNearDuplicateCriticName,
  findSpellingDuplicates,
  scanReviewTextsForCriticDuplicates,
};
