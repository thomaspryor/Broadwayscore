#!/usr/bin/env node
/**
 * Aggregator-archive integrity audit.
 *
 * Walks every cached HTML archive under data/aggregator-archive/<src>/<showId>.html
 * and runs validateRoundupPageTitle() to confirm the page title matches the
 * showId in the filename. This is the standing gate that would have caught
 * the Stuart King contamination class (Notion 34e637c5) at PR time instead
 * of waiting for a critic to email us.
 *
 * Three modes:
 *   1. Default (informational): print summary, exit 0 unless internal error.
 *   2. --strict: exit 1 if any bad archives are found beyond the committed baseline.
 *   3. --update-baseline: write current state to baseline JSON (manual only,
 *      after a deliberate cleanup).
 *
 * Output: data/audit/aggregator-archive-integrity.json — current state report.
 * Baseline: data/audit/aggregator-archive-integrity-baseline.json — frozen
 * known-bad list. CI's --strict mode fails on additions vs baseline.
 *
 * Usage:
 *   node scripts/audit-aggregator-archive-integrity.js              # report
 *   node scripts/audit-aggregator-archive-integrity.js --strict     # CI gate
 *   node scripts/audit-aggregator-archive-integrity.js --update-baseline
 *
 * Notion: 34e637c5-416f-812c (CI gate for cached archive validation, P2).
 */

const fs = require('fs');
const path = require('path');
const { validateRoundupPageTitle } = require('./lib/show-matching');

const STRICT = process.argv.includes('--strict');
const UPDATE_BASELINE = process.argv.includes('--update-baseline');

const ROOT = path.join(__dirname, '..');
const ARCHIVE_ROOT = path.join(ROOT, 'data', 'aggregator-archive');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const REPORT_PATH = path.join(ROOT, 'data', 'audit', 'aggregator-archive-integrity.json');
const BASELINE_PATH = path.join(ROOT, 'data', 'audit', 'aggregator-archive-integrity-baseline.json');

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

function loadShowMap() {
  const raw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const list = raw.shows || raw;
  const byId = {};
  for (const s of list) byId[s.id] = s;
  return byId;
}

function audit() {
  const showById = loadShowMap();
  const bad = [];
  let totalScanned = 0;
  let skippedNoShow = 0;

  for (const src of SOURCES) {
    const dir = path.join(ARCHIVE_ROOT, src);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.html') && !SKIP_FILENAMES.has(f));
    for (const f of files) {
      totalScanned++;
      const showId = f.replace(/\.html$/, '');
      const show = showById[showId];
      if (!show) { skippedNoShow++; continue; }
      const html = fs.readFileSync(path.join(dir, f), 'utf8');
      const v = validateRoundupPageTitle(html, show.title);
      if (v.ok) continue;

      // False-positive guard: HTML-encoded apostrophes / slash-titles where
      // the validator misfires. Decode entities and re-test informally.
      if (v.reason === 'page-title-mismatch') {
        const decoded = (v.pageTitle || '').toLowerCase()
          .replace(/&#039;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
        const titleWords = show.title.toLowerCase()
          .split(/[\s,'/]+/).filter(w => w.length > 2);
        const ownHits = titleWords.filter(w => decoded.includes(w)).length;
        if (titleWords.length > 0 && ownHits >= Math.min(2, titleWords.length)) {
          continue; // Punctuation false positive — accept.
        }
      }

      bad.push({
        source: src,
        showId,
        showTitle: show.title,
        pageTitle: (v.pageTitle || '').substring(0, 120),
        reason: v.reason,
      });
    }
  }

  return { totalScanned, skippedNoShow, bad };
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

const result = audit();
const report = {
  generatedAt: new Date().toISOString(),
  totalScanned: result.totalScanned,
  skippedNoShow: result.skippedNoShow,
  badCount: result.bad.length,
  bySource: result.bad.reduce((acc, b) => { acc[b.source] = (acc[b.source] || 0) + 1; return acc; }, {}),
  bad: result.bad.sort((a, b) => (a.source + a.showId).localeCompare(b.source + b.showId)),
};

fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');

console.log(`Aggregator-archive integrity:`);
console.log(`  Scanned: ${result.totalScanned} files`);
console.log(`  Skipped (no show in shows.json): ${result.skippedNoShow}`);
console.log(`  Bad: ${result.bad.length}`);
console.log();

if (UPDATE_BASELINE) {
  const baselineDoc = {
    description: 'Frozen list of known-bad cached archives. CI fails (--strict) on ANY addition vs this list. Updated manually after deliberate cleanup. See scripts/audit-aggregator-archive-integrity.js. Notion 34e637c5-416f-812c.',
    updatedAt: new Date().toISOString(),
    knownBad: result.bad.map(b => `${b.source}/${b.showId}`).sort(),
  };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baselineDoc, null, 2) + '\n');
  console.log(`✓ Baseline updated: ${BASELINE_PATH}`);
  process.exit(0);
}

if (STRICT) {
  const baseline = loadBaseline();
  const knownBad = new Set((baseline && baseline.knownBad) || []);
  const currentBad = new Set(result.bad.map(b => `${b.source}/${b.showId}`));
  const additions = [...currentBad].filter(k => !knownBad.has(k));
  const removals = [...knownBad].filter(k => !currentBad.has(k));

  if (additions.length > 0) {
    console.log(`❌ NEW bad archives (${additions.length}):`);
    for (const k of additions.slice(0, 20)) console.log(`   - ${k}`);
    console.log();
    console.log('Each represents a cached aggregator HTML file whose page title');
    console.log('does not match the showId in the filename — i.e., poisoned cache.');
    console.log();
    console.log('Remediate by re-fetching or quarantining the file, then re-running');
    console.log('the audit. To accept these intentionally, run --update-baseline.');
    process.exit(1);
  }

  if (removals.length > 0) {
    console.log(`✓ Cleared ${removals.length} previously-bad archives — run --update-baseline to shrink baseline.`);
  } else {
    console.log(`✓ No additions vs baseline (${knownBad.size} known-bad).`);
  }
}

console.log(`Report: ${REPORT_PATH}`);
