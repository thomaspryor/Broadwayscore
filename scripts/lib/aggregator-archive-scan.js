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

/** Unlink every scanned page; returns the count. */
function deletePages(hits) {
  for (const h of hits) fs.unlinkSync(h.file);
  return hits.length;
}

/**
 * The quarantine CLI's body (scripts/quarantine-poisoned-aggregator-archive.js), here so a lib test can drive it.
 * Report mode lists the poisoned pages (exit 1 if any); --delete needs --expect=N equal to the count found.
 * @returns {number} the process exit code
 */
function runQuarantine(args, { defaultArchiveRoot, showById, log = console.log, error = console.error }) {
  const archiveArg = args.find(a => a.startsWith('--archive='));
  const archiveRoot = archiveArg ? path.resolve(archiveArg.slice(10)) : defaultArchiveRoot;
  const deleting = args.includes('--delete');
  if (!fs.existsSync(archiveRoot)) {
    if (deleting) { error(`archive not present at ${archiveRoot}: refusing a no-op --delete`); return 2; }
    log(`archive not present at ${archiveRoot}, nothing to audit`);
    return 0;
  }
  const { bad } = scanArchiveIntegrity(archiveRoot, showById);
  for (const b of bad) log(`${b.source}\t${b.showId}\t${b.reason}`);
  log(`\n${bad.length} poisoned archive page(s)`);
  if (!deleting) return bad.length ? 1 : 0;
  const expectArg = args.find(a => a.startsWith('--expect='));
  if (!expectArg || !/^\d+$/.test(expectArg.slice(9))) {
    error('--delete requires --expect=N (the number of poisoned pages the plan author saw)');
    return 2;
  }
  if (bad.length !== Number(expectArg.slice(9))) {
    error(`expected ${expectArg.slice(9)} poisoned page(s), found ${bad.length}: nothing deleted`);
    return 2;
  }
  log(`deleted ${deletePages(bad)} file(s)`);
  return 0;
}

module.exports = { SOURCES, SKIP_FILENAMES, scanArchiveIntegrity, deletePages, runQuarantine };
