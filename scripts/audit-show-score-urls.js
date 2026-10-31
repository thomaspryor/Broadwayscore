#!/usr/bin/env node
const { maxPlausibleYear } = require('./lib/date-utils');
/**
 * audit-show-score-urls.js
 *
 * Audits show-score-urls.json for wrong-production matches by:
 * 1. Checking for duplicate URLs (multiple shows → same URL)
 * 2. Cross-referencing review dates in archived pages against production dates
 * 3. Extracting venue from meta description where available
 * 4. Flagging multi-production shows with generic URLs
 *
 * Usage:
 *   node scripts/audit-show-score-urls.js [--verbose]        report only
 *   node scripts/audit-show-score-urls.js --strict           exit 1 on a NEW duplicate URL, or a mapping to
 *                                                            another production's page (BRO-5866)
 *   node scripts/audit-show-score-urls.js --update-baseline  regenerate baseline from current scan
 *   node scripts/audit-show-score-urls.js --check-stale      exit 1 on baseline entries no longer duplicated (BRO-5315)
 *   node scripts/audit-show-score-urls.js --prune-stale      drop only those entries from the baseline
 *
 * Baseline-diff (BRO-3471), same posture as audit-duplicate-shows.js: which
 * side of a duplicate-URL pair is the page's real subject is a per-pair data
 * judgment call (BRO-3471's PARKED rationale) that this script cannot make
 * automatically, so --strict does not try to resolve existing collisions —
 * it only stops a NEW one from landing invisibly. Pre-existing collisions are
 * frozen in data/audit/show-score-urls-baseline.json; only a URL not already
 * in that baseline fails under --strict. See
 * scripts/lib/show-score-urls-baseline.js for why identity is the URL, not
 * the showId pair. Default mode (no flags) always exits 0 — report only,
 * matching the sibling gates' advisory-first convention. Only the
 * duplicate-URL check is wired into --strict: it's a structural fact (two
 * showIds literally point at the same URL), not a heuristic. The
 * confirmed_wrong/suspicious checks below are heuristics (page-year/venue/
 * review-date mismatches against an archived HTML snapshot) that can
 * false-positive on their own, so they stay report-only regardless of
 * whether data/aggregator-archive/show-score (private, gitignored, not
 * present without a data setup step) is available.
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { venuesMatch } = require('./lib/deduplication');
const { normalizeUrl, identityKey, baselineKeySet, computeNewViolators } = require('./lib/show-score-urls-baseline');
const { computeStaleBaselineKeys, reportStaleBaseline, pruneStaleEntries, runStaleModes } = require('./lib/stale-baseline');
const { findDuplicateUrls, isLapsedProductionMismatch } = require('./lib/show-score-url-map');
const { findWrongProductionMappings } = require('./lib/show-score-wrong-production');
const { countWrongProductionFiles, formatWrongProductionRatio } = require('./lib/show-score-url-wrongproduction-ratio');

const DATA_DIR = path.join(__dirname, '../data');
const URLS_PATH = path.join(DATA_DIR, 'show-score-urls.json');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const ARCHIVE_DIR = path.join(DATA_DIR, 'aggregator-archive/show-score');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const BASELINE_PATH = path.join(DATA_DIR, 'audit', 'show-score-urls-baseline.json');

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const STRICT = args.includes('--strict');
const UPDATE_BASELINE = args.includes('--update-baseline');
const STALE_MODE = args.includes('--check-stale') || args.includes('--prune-stale'); // BRO-5315

function loadBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return { urls: [] };
  }
}

const urlData = JSON.parse(fs.readFileSync(URLS_PATH, 'utf8'));
const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
const shows = showsData.shows || showsData;

// FAIL LOUD on an empty show-score-urls.json under --strict/--update-baseline
// (mirrors audit-duplicate-shows.js's corpusHealthCount guard, task #1063
// class): with zero entries, urlToIds is empty, duplicate_url is [], and
// --strict would exit 0 vacuously — passing not because nothing is wrong but
// because nothing was checked (e.g. a bad merge emptied the file).
if ((STRICT || UPDATE_BASELINE || STALE_MODE) && Object.keys(urlData.shows || {}).length === 0) {
  console.error(`\n❌ data/show-score-urls.json has 0 entries — cannot scan for duplicates. Refusing to pass vacuously.`);
  process.exit(1);
}

const showMap = {};
for (const s of shows) showMap[s.id] = s;

function extractYearFromId(id) {
  const m = id.match(/-(\d{4})$/);
  return m ? parseInt(m[1]) : null;
}

function extractVenueFromMeta(html) {
  try {
    const $ = cheerio.load(html);
    const desc = $('meta[name="description"]').attr('content') || '';
    const cleaned = desc.replace(/&nbsp;/g, ' ');
    const m = cleaned.match(/\bat\s+(.+?)\.?\s*$/i);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function extractPageProductionYear(html) {
  try {
    const $ = cheerio.load(html);
    const title = $('title').text() || '';
    const yearMatch = title.match(/\((?:Broadway|Off-Broadway|London)?\s*(\d{4})\)/i);
    if (yearMatch) return parseInt(yearMatch[1]);
    const ogTitle = $('meta[property="og:title"]').attr('content') || '';
    const ogMatch = ogTitle.match(/\((?:Broadway|Off-Broadway|London)?\s*(\d{4})\)/i);
    if (ogMatch) return parseInt(ogMatch[1]);
    return null;
  } catch { return null; }
}

function extractReviewDates(html) {
  try {
    const dates = [];
    const datePattern = /(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s*\d{4}/gi;
    const matches = html.match(datePattern) || [];
    for (const m of matches) {
      const d = new Date(m);
      if (!isNaN(d.getTime()) && d.getFullYear() >= 2000 && d.getFullYear() <= maxPlausibleYear({ atLeast: 2030 })) {
        dates.push(d);
      }
    }
    return dates.sort((a, b) => a - b);
  } catch { return []; }
}

// Build multi-production map
const productionsByBase = {};
for (const s of shows) {
  const base = s.id.replace(/-\d{4}$/, '');
  if (!productionsByBase[base]) productionsByBase[base] = [];
  productionsByBase[base].push(s);
}
const multiProductionBases = new Set(
  Object.entries(productionsByBase).filter(([_, p]) => p.length > 1).map(([b]) => b)
);

const results = { confirmed_wrong: [], duplicate_url: [], suspicious: [], ok: [], no_archive: [] };

// Check 1: Duplicate URLs. Group on the NORMALIZED url (lowercase, no
// trailing slash) — two entries that differ only by casing/trailing-slash
// are the same Show Score page and must collide here, not slip past as two
// singleton groups (adversarial review, BRO-3471). Report the raw url from
// whichever entry is seen first so the report still shows real data.
// Extracted to lib/show-score-url-map.js (CLAUDE.md rule 15) so this
// grouping logic has its own test instead of only being exercised via the
// baseline-diff tests, which cover what happens AFTER duplicates are found.
results.duplicate_url.push(...findDuplicateUrls(urlData.shows));

if (UPDATE_BASELINE) {
  const urls = results.duplicate_url.map(d => ({ url: d.url, showIds: d.showIds }));
  const baseline = { generatedAt: new Date().toISOString().slice(0, 10), urls };
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`✅ Baseline updated: ${urls.length} known duplicate-URL entr${urls.length === 1 ? 'y' : 'ies'} (${BASELINE_PATH})`);
  process.exit(0);
}

// BRO-5315: identity is url + exact showId set (identityKey), the same grain
// the baseline diff uses — a URL now shared by a different id set is stale.
const baselineDoc = loadBaseline();
const staleKeys = computeStaleBaselineKeys((baselineDoc.urls || []).map(identityKey), results.duplicate_url.map(identityKey));
const STALE_CMD = 'node scripts/audit-show-score-urls.js --prune-stale';
runStaleModes(args, {
  stale: staleKeys, label: 'show-score-urls', updateCmd: STALE_CMD,
  prune: (stale) => {
    baselineDoc.urls = pruneStaleEntries(baselineDoc.urls || [], identityKey, stale);
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baselineDoc, null, 2) + '\n');
  },
});

const baselineSet = baselineKeySet(baselineDoc.urls);
const newDuplicates = computeNewViolators(results.duplicate_url, baselineSet);

// Check 2: Per-show audit
for (const [showId, url] of Object.entries(urlData.shows)) {
  const show = showMap[showId];
  if (!show) continue;

  const archivePath = path.join(ARCHIVE_DIR, `${showId}.html`);
  if (!fs.existsSync(archivePath)) {
    const base = showId.replace(/-\d{4}$/, '');
    if (extractYearFromId(showId) && multiProductionBases.has(base)) {
      results.suspicious.push({
        showId, url,
        reason: `No archive to verify, multi-production show (${productionsByBase[base].length} productions)`,
        venue: show.venue, status: show.status,
      });
    } else {
      results.no_archive.push({ showId, url });
    }
    continue;
  }

  const html = fs.readFileSync(archivePath, 'utf8');
  const issues = [];

  // Check year mismatch
  const pageYear = extractPageProductionYear(html);
  const showYear = extractYearFromId(showId);
  if (pageYear && showYear && Math.abs(pageYear - showYear) > 1) {
    issues.push(`Page says ${pageYear}, show is ${showYear}`);
  }

  // Check review dates
  const reviewDates = extractReviewDates(html);
  if (reviewDates.length >= 3) {
    const earliest = reviewDates[0];
    const latest = reviewDates[reviewDates.length - 1];
    const startRef = show.previewsStartDate ? new Date(show.previewsStartDate) : show.openingDate ? new Date(show.openingDate) : null;
    const closingDate = show.closingDate ? new Date(show.closingDate) : null;

    if (startRef && earliest < new Date(startRef.getTime() - 365 * 86400000)) {
      issues.push(`Earliest review ${earliest.toISOString().split('T')[0]} is >1yr before previews ${startRef.toISOString().split('T')[0]}`);
    }
    if (closingDate && latest > new Date(closingDate.getTime() + 180 * 86400000)) {
      issues.push(`Latest review ${latest.toISOString().split('T')[0]} is >6mo after closing ${closingDate.toISOString().split('T')[0]}`);
    }
    const medianDate = reviewDates[Math.floor(reviewDates.length / 2)];
    if (showYear && Math.abs(medianDate.getFullYear() - showYear) > 2) {
      issues.push(`Median review year ${medianDate.getFullYear()} differs from show year ${showYear} by >2 years`);
    }
  }

  // Check venue (multi-production only)
  const pageVenue = extractVenueFromMeta(html);
  if (pageVenue && show.venue && !venuesMatch(pageVenue, show.venue)) {
    const base = showId.replace(/-\d{4}$/, '');
    if (multiProductionBases.has(base)) {
      issues.push(`Page venue "${pageVenue}" != show venue "${show.venue}"`);
    }
  }

  if (issues.length > 0) {
    results.confirmed_wrong.push({
      showId, url,
      show: { title: show.title, venue: show.venue, status: show.status, openingDate: show.openingDate, closingDate: show.closingDate },
      pageYear, pageVenue,
      reviewDateRange: reviewDates.length >= 3
        ? `${reviewDates[0].toISOString().split('T')[0]} — ${reviewDates[reviewDates.length - 1].toISOString().split('T')[0]} (${reviewDates.length} dates)`
        : `${reviewDates.length} dates found`,
      issues,
    });
  } else {
    const base = showId.replace(/-\d{4}$/, '');
    results.ok.push({ showId, url, note: multiProductionBases.has(base) ? `multi-production (${productionsByBase[base].length}), dates OK` : undefined });
  }
}

// Report
console.log('═══════════════════════════════════════════════════');
console.log('  Show Score URL Audit Report');
console.log('═══════════════════════════════════════════════════\n');

if (results.duplicate_url.length > 0) {
  console.log(`DUPLICATE URLs (${results.duplicate_url.length}, baselined: ${results.duplicate_url.length - newDuplicates.length}, new: ${newDuplicates.length}):`);
  results.duplicate_url.forEach(d => {
    const isNew = newDuplicates.some(n => n.url === d.url);
    console.log(`  ${d.url}${isNew ? '  [NEW — not in baseline]' : ''}`);
    d.showIds.forEach(id => {
      const s = showMap[id];
      const ratio = formatWrongProductionRatio(countWrongProductionFiles(REVIEW_TEXTS_DIR, id));
      console.log(`    → ${id} (${s?.status || '?'}, ${s?.venue || 'no venue'}, opens ${s?.openingDate || '?'}) | ${ratio}`);
    });
  });
  if (newDuplicates.length > 0) {
    console.log(`\n⚠️  NEW duplicate URL(s) not in the baseline (${BASELINE_PATH}):`);
    newDuplicates.forEach(d => console.log(`  ${d.url}: ${d.showIds.join(' <-> ')}`));
    console.log(`\nEach side needs hand verification of which production the Show Score page`);
    console.log(`actually describes (BRO-3471) before adding to the baseline:`);
    console.log(`  node scripts/audit-show-score-urls.js --update-baseline`);
  }
  console.log('');
}

if (results.confirmed_wrong.length > 0) {
  console.log(`CONFIRMED WRONG PRODUCTION (${results.confirmed_wrong.length}):`);
  results.confirmed_wrong.forEach(r => {
    console.log(`  ${r.showId}:`);
    console.log(`    URL: ${r.url}`);
    console.log(`    Show: ${r.show.title} @ ${r.show.venue} (${r.show.status}, opens ${r.show.openingDate})`);
    if (r.pageYear) console.log(`    Page year: ${r.pageYear}`);
    if (r.pageVenue) console.log(`    Page venue: ${r.pageVenue}`);
    console.log(`    Review dates: ${r.reviewDateRange}`);
    r.issues.forEach(i => console.log(`    ! ${i}`));
    console.log('');
  });
}

if (results.suspicious.length > 0) {
  console.log(`SUSPICIOUS — no archive to verify (${results.suspicious.length}):`);
  const shown = verbose ? results.suspicious : results.suspicious.slice(0, 10);
  shown.forEach(r => console.log(`  ${r.showId} (${r.status}, ${r.venue}): ${r.reason}`));
  if (!verbose && results.suspicious.length > 10) console.log(`  ... and ${results.suspicious.length - 10} more (use --verbose)`);
  console.log('');
}

// BRO-5866: a mapping whose page's review dates fall outside this
// production's run (same title, different production: Safe House 2026 on the
// 2025 St. Ann's page). Unlike the heuristics above this one is strict:
// show-score-production-window.js needs 3+ dates, 90% of them outside the
// run, and keeps a reviewed exemption list, and the evidence is public
// (show-score.json) so CI sees it without the archive.
const SHOW_SCORE_JSON = path.join(DATA_DIR, 'show-score.json');
let wrongProduction = [];
let awaitingRecheck = [];
try {
  const showScoreData = JSON.parse(fs.readFileSync(SHOW_SCORE_JSON, 'utf8'));
  const readArchive = (id) => {
    try { return fs.readFileSync(path.join(ARCHIVE_DIR, `${id}.html`), 'utf8'); } catch { return null; }
  };
  wrongProduction = findWrongProductionMappings({ urlMap: urlData.shows, showScoreData, showsById: showMap, readArchive });
  // A lapsed record mapped again by a listings pass: the evidence above is
  // the old page, and the weekly scrape re-judges it before any data is used.
  awaitingRecheck = wrongProduction.filter((w) => isLapsedProductionMismatch(urlData, w.showId, w.url));
  wrongProduction = wrongProduction.filter((w) => !awaitingRecheck.includes(w));
} catch (e) {
  console.error(`Wrong-production check could not run: ${e.message}`);
  if (STRICT) process.exit(1);
}
if (wrongProduction.length > 0) {
  console.log(`ANOTHER PRODUCTION'S PAGE (${wrongProduction.length}):`);
  wrongProduction.forEach(w => console.log(`  ${w.showId}: ${w.url}\n    ${w.reason} [${w.evidence}]`));
  console.log(`\nRemove with: node scripts/purge-wrong-production-show-score.js --apply`);
  console.log('');
}

console.log('Summary:');
console.log(`  Duplicate URLs:       ${results.duplicate_url.length}`);
console.log(`  Confirmed wrong:      ${results.confirmed_wrong.length}`);
console.log(`  Suspicious (no arch): ${results.suspicious.length}`);
console.log(`  Other production:     ${wrongProduction.length}`);
if (awaitingRecheck.length) console.log(`  Awaiting re-check:    ${awaitingRecheck.length} (lapsed mismatch mapped again: ${awaitingRecheck.map((w) => w.showId).join(', ')})`);
console.log(`  OK:                   ${results.ok.length}`);
console.log(`  No archive:           ${results.no_archive.length}`);
console.log(`  Total checked:        ${Object.keys(urlData.shows).length}`);

if (staleKeys.length) reportStaleBaseline(staleKeys, { label: 'show-score-urls', updateCmd: STALE_CMD });

if (STRICT && (newDuplicates.length > 0 || wrongProduction.length > 0)) process.exit(1);
process.exit(0);
