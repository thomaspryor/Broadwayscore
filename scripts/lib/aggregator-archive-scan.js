'use strict';

/**
 * aggregator-archive-scan.js (BRO-6141)
 *
 * The scan behind scripts/audit-aggregator-archive-integrity.js, extracted so the
 * audit (report + baseline) and scripts/quarantine-poisoned-aggregator-archive.js
 * (delete) walk exactly the same pages with exactly the same predicate.
 */

const fs = require('fs');
const path = require('path');
const { buildSiblingCategoriesByTitle } = require('./show-matching');
const { checkArchiveCategory } = require('./archive-cache-guard');

// Sources where filename-encoded showId should match page-title content.
// excluded: (1) those that aren't HTML archives keyed by showId — wet (.json
// API caches), stagedoor (.json), nysr (no archive yet); (2) bww-rr — empty
// dir; (3) front-page caches like bww-roundups/category-page-1.html (skipped
// individually below).
const SOURCES = [
  'bww-reviews', 'bww-roundups', 'dtli', 'show-score',
  'playbill-verdict', 'nyc-theatre', 'theatre-reviews',
  'thestage-roundups', 'lbo-roundups',
];

// Filenames that aren't show-keyed archives (category landing pages, etc.)
const SKIP_FILENAMES = new Set(['category-page-1.html']);

/**
 * @param {string} archiveRoot  directory holding one folder per source
 * @param {Object<string,Object>} showById
 * @returns {{totalScanned:number, skippedNoShow:number, bad:Array<{source,showId,file,showTitle,pageTitle,reason}>}}
 */
function scanArchiveIntegrity(archiveRoot, showById) {
  const siblingCategoriesById = buildSiblingCategoriesByTitle(showById);
  const bad = [];
  let totalScanned = 0;
  let skippedNoShow = 0;

  for (const src of SOURCES) {
    const dir = path.join(archiveRoot, src);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.html') && !SKIP_FILENAMES.has(f));
    for (const f of files) {
      totalScanned++;
      const showId = f.replace(/\.html$/, '');
      const show = showById[showId];
      if (!show) { skippedNoShow++; continue; }
      const html = fs.readFileSync(path.join(dir, f), 'utf8');
      // checkArchiveCategory = validateRoundupPageTitle + the punctuation
      // false-positive rescue + the sibling guards re-run on a rescued page.
      // Sharing the scrapers' predicate keeps audit and write/read guards identical (BRO-3607).
      const v = checkArchiveCategory(html, show, siblingCategoriesById[showId]);
      if (v.ok) continue;
      bad.push({
        source: src,
        showId,
        file: path.join(dir, f),
        showTitle: show.title,
        pageTitle: (v.pageTitle || '').substring(0, 120),
        reason: v.reason,
      });
    }
  }
  return { totalScanned, skippedNoShow, bad };
}

module.exports = { SOURCES, SKIP_FILENAMES, scanArchiveIntegrity };
