#!/usr/bin/env node
/**
 * exclusion-rule-census.js
 *
 * BRO-176: explainExclusion() (scripts/lib/review-guards.js) is the single
 * implementation of the includability rule chain and names a stable rule for
 * every excluded review, but nothing consumed those names. This walks
 * data/review-texts, calls explainExclusion(data, show, filePath) on every
 * review file, and aggregates the returned rule names into a census: counts
 * per rule, and per rule the shows contributing most to that count.
 *
 * The census snapshots to data/audit/exclusion-rule-census.json. Each run
 * reads whatever snapshot is already there (the PRIOR run's result) as the
 * diff baseline BEFORE overwriting it with the new one, and prints which
 * RULE — and which shows under that rule — explain any change in
 * excluded-review volume, instead of leaving corpus drift as an
 * undifferentiated "N fewer reviews" count (the gap check-review-count-drift.js
 * and check-corpus-drift.js both leave open).
 *
 * Usage:
 *   node scripts/exclusion-rule-census.js                 # scan, report, snapshot
 *   node scripts/exclusion-rule-census.js --show=ID        # single show, no snapshot/diff
 *   node scripts/exclusion-rule-census.js --json-only      # JSON to stdout, no console report
 *   node scripts/exclusion-rule-census.js --no-diff        # skip baseline diff/rotation
 *   node scripts/exclusion-rule-census.js --limit=N        # top-N shows per rule (default 5)
 *
 * Exit codes: 0 on a completed scan (report-only monitor, not a gate) / 1 on
 * a setup error (missing review-texts dir, or a full-corpus scan that found
 * zero files — the latter fails loud instead of reporting a vacuous "0
 * excluded", see scripts/lib/corpus-scan-guard.js).
 */

const fs = require('fs');
const path = require('path');

const { explainExclusion } = require('./lib/review-guards');
const { listShowDirs } = require('./lib/list-show-dirs');
const { assertCorpusScanned } = require('./lib/corpus-scan-guard');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { buildCensus, diffCensus, formatCensusReport, formatDriftReport } = require('./lib/exclusion-rule-census');

const REPO_ROOT = path.resolve(__dirname, '..');
// resolveReviewTextsDir() picks the real checkout: explicit REVIEW_TEXTS_DIR ->
// <repoRoot>/data/review-texts -> the main worktree's clone -> the legacy
// ~/broadway-review-texts. A naive path.join(__dirname, '../data/review-texts')
// finds nothing inside a worktree, where data/review-texts is gitignored and
// lives only in the main checkout (scripts/lib/review-texts-dir.js docblock).
const REVIEW_TEXTS_DIR = resolveReviewTextsDir();
const SHOWS_JSON = process.env.SHOWS_JSON || path.join(REPO_ROOT, 'data', 'shows.json');
const AUDIT_DIR = process.env.EXCLUSION_CENSUS_AUDIT_DIR || path.join(REPO_ROOT, 'data', 'audit');
const SNAPSHOT_PATH = path.join(AUDIT_DIR, 'exclusion-rule-census.json');

function loadShowsById(showsJsonPath) {
  const byId = {};
  try {
    const raw = JSON.parse(fs.readFileSync(showsJsonPath, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.shows || []);
    for (const s of arr) if (s && s.id) byId[s.id] = s;
  } catch {
    // shows.json missing/unreadable — explainExclusion tolerates show===undefined
    // for most rules; only the show-context guards (pre-opening date,
    // cross-market) degrade, same tradeoff check-review-count-drift.js makes.
  }
  return byId;
}

/**
 * Walk one or all review-texts show dirs and call explainExclusion() on every
 * review file, returning one {showId, file, rule} record per file.
 */
function scanCorpus({ reviewTextsDir, showById, showFilter }) {
  const showDirs = showFilter ? [showFilter] : listShowDirs(reviewTextsDir);
  const records = [];
  for (const showId of showDirs) {
    const dirPath = path.join(reviewTextsDir, showId);
    let files;
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json');
    } catch {
      continue;
    }
    const show = showById[showId];
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        continue;
      }
      const rule = explainExclusion(data, show, filePath);
      records.push({ showId, file, rule });
    }
  }
  return records;
}

function main() {
  const argv = process.argv.slice(2);
  const showFilter = (argv.find((a) => a.startsWith('--show=')) || '').split('=')[1] || null;
  const jsonOnly = argv.includes('--json-only');
  const noDiff = argv.includes('--no-diff');
  const limit = parseInt((argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1], 10) || 5;

  console.error(`review-texts dir: ${REVIEW_TEXTS_DIR}`);
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error(`ERROR: review-texts dir not found at ${REVIEW_TEXTS_DIR}`);
    process.exit(1);
  }

  const showById = loadShowsById(SHOWS_JSON);
  const records = scanCorpus({ reviewTextsDir: REVIEW_TEXTS_DIR, showById, showFilter });
  // Full-corpus runs must fail loud on a vacuous 0-scanned rather than report
  // a clean census (task #1063 pattern, scripts/lib/corpus-scan-guard.js).
  // --show scans a single dir and can legitimately be empty (new show, no
  // reviews collected yet) — gated off there.
  assertCorpusScanned(records.length, { gate: !showFilter, label: REVIEW_TEXTS_DIR });

  const census = buildCensus(records);
  const snapshot = { generatedAt: new Date().toISOString(), showFilter, ...census };

  if (!jsonOnly) {
    console.log('');
    console.log(`=== Exclusion rule census: ${showFilter || 'full corpus'} ===`);
    console.log(formatCensusReport(census, { limit }));
  }

  // Read the PRIOR run's snapshot as the diff baseline before it gets
  // overwritten below — reading it any later (or rotating to a separate
  // "previous" file first) leaves the diff permanently one generation stale.
  let diff = null;
  if (!noDiff && !showFilter && fs.existsSync(SNAPSHOT_PATH)) {
    try {
      const baseline = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
      diff = diffCensus(baseline, census);
      if (!jsonOnly) {
        console.log('');
        console.log('=== Drift attribution vs previous snapshot ===');
        console.log(formatDriftReport(diff, { limit }));
      }
    } catch (e) {
      console.error(`WARN: could not read prior snapshot: ${e.message}`);
    }
  }

  if (!showFilter) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n');
    if (!jsonOnly) console.log(`\nWrote ${path.relative(REPO_ROOT, SNAPSHOT_PATH)}`);
  }

  if (jsonOnly) console.log(JSON.stringify({ census: snapshot, diff }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { scanCorpus, loadShowsById };
