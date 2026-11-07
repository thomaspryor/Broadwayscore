#!/usr/bin/env node
/**
 * test-archive-writers-category-guard.js (BRO-2550)
 *
 * Every scraper that writes a showId-keyed HTML archive under
 * data/aggregator-archive/ must run checkArchiveCategory() (or
 * checkArchivePageIdentity(), which wraps it) with the show's sibling
 * categories before the write. Calling validateRoundupPageTitle() directly
 * without category/siblings leaves the cross-market-sibling check inert.
 *
 * 1. Static: each listed scraper requires the guard, passes a siblings
 *    argument, and does not call validateRoundupPageTitle directly.
 * 2. Behavioural: against real shows.json, a cached page for a same-title
 *    show in another category is refused by the exact call the scrapers make.
 *
 * Run: node scripts/test-archive-writers-category-guard.js   (exit 0 pass)
 */
const fs = require('fs');
const path = require('path');
const { loadShows, buildSiblingCategoriesFromShows } = require('./lib/show-matching');
const { checkArchiveCategory } = require('./lib/archive-cache-guard');

// WET archives a WordPress-API JSON (no page <title>) and matches only
// west-end-market shows, so it has no HTML title to validate.
const EXEMPT = {
  'scrape-stagedoor-critics.js': 'critic-page archive, not a per-show roundup title page', 'scrape-westendtheatre-roundups.js': 'JSON archive, market-scoped match' };
const GUARDED = [
  'scrape-bww-reviews.js', 'scrape-dtli.js', 'scrape-nyc-theatre-roundups.js',
  'scrape-playbill-verdict.js', 'scrape-london-box-office-roundups.js',
  'scrape-theatre-reviews.js', 'scrape-thestage-roundups.js',
];

let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.error('FAIL: ' + msg); } else console.log('ok: ' + msg); };

for (const f of GUARDED) {
  // Strip comments so a mention in prose cannot satisfy the check.
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check(/checkArchive(Category|PageIdentity)\(/.test(src), `${f} calls the shared guard`);
  check(/siblingCategoriesByShowId\(\)\[/.test(src), `${f} passes sibling categories`);
  check(!/validateRoundupPageTitle\(/.test(src), `${f} has no bare validateRoundupPageTitle call`);
}
// gather-reviews.js writes through archiveAggregatorPage(), which used to archive
// any page it was handed (BRO-6141: wrong-production BWW roundups, wrong-show Show
// Score/DTLI pages). The function itself must run the guard, and every call must
// pass the show so it can.
{
  const src = fs.readFileSync(path.join(__dirname, 'gather-reviews.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const start = src.indexOf('function archiveAggregatorPage(');
  const body = src.slice(start, src.indexOf('fs.writeFileSync(archivePath', start));
  check(start > -1 && /checkArchiveCategory\(html, show, siblingCategoriesByShowId\(\)\[showId\]\)/.test(body),
    'gather-reviews.js archiveAggregatorPage runs the guard before its write');
  const calls = src.match(/(?<!function )archiveAggregatorPage\([^;]*\);/g) || [];
  check(calls.length >= 3 && calls.every(c => /, show\);$/.test(c)), `all ${calls.length} archiveAggregatorPage calls pass the show`);
}
// A new archive-writing scraper must be added to GUARDED or EXEMPT.
for (const f of fs.readdirSync(__dirname).filter(n => /^scrape-.*\.js$/.test(n))) {
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
  if (/aggregator-archive['"/,\s]+(bww|dtli|nyc-theatre|playbill|theatre-reviews|thestage|lbo|westendtheatre|stagedoor)/.test(src)
      && /writeFileSync/.test(src)) {
    check(GUARDED.includes(f) || EXEMPT[f], `${f} is registered as guarded or exempt`);
  }
}

// Behavioural (Broadway/Off-Broadway coverage arrives with BRO-2551; today the
// sibling check keys on regional shows, and the London-only scrapers get the
// title, punctuation and containing-title checks from the same guard): real shows with a same-title sibling in another category.
const shows = loadShows();
const siblings = buildSiblingCategoriesFromShows(shows);
// The cross-market check currently fires for regional shows only (BRO-2551 widens it).
const cases = shows.filter(s => s.category === 'regional' && (siblings[s.id] || []).length);
let tested = 0;
for (const s of cases) {
  const other = (siblings[s.id] || []).find(c => c === 'broadway' || c === 'off-broadway');
  if (!other) continue;
  const html = `<html><head><title>${s.title} (${other === 'broadway' ? 'Broadway' : other}) Reviews</title></head><body></body></html>`;
  const withSib = checkArchiveCategory(html, s, siblings[s.id]);
  const noSib = checkArchiveCategory(html, s, undefined);
  if (!withSib.ok && noSib.ok) tested++;
  if (tested >= 3) break;
}
check(tested >= 3, `cross-market page refused only when siblings passed (${tested} real shows)`);
process.exit(fail ? 1 : 0);
