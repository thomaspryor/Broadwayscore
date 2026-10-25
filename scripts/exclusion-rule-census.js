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
 *   node scripts/exclusion-rule-census.js --compare-rebuild
 *       # BRO-2320: after a full rebuild in the same job, compare the mirror
 *       # against the rebuild's real per-show exclusion lists
 *       # (data/audit/rebuild-exclusions-*.json) and reviews.json, print the
 *       # disagreement rate, and write the committed counts-only summary
 *       # data/audit/exclusion-mirror-summary.json
 *   node scripts/exclusion-rule-census.js --check [--max-rule-delta=N] [--max-rate-rise=R]
 *       # BRO-2321: no rescan; read the committed summary and exit 1 when a
 *       # rule's count moved more than N, the disagreement rate rose more than
 *       # R (fraction), or the summary is stale (check-corpus-drift.js AUDITS)
 *
 * Exit codes: 0 on a completed scan (report-only monitor, not a gate) / 1 on
 * a setup error (missing review-texts dir, or a full-corpus scan that found
 * zero files — the latter fails loud instead of reporting a vacuous "0
 * excluded", see scripts/lib/corpus-scan-guard.js).
 */

const { isReviewTextFile } = require('./lib/review-text-sidecars');
const fs = require('fs');
const path = require('path');

const { explainExclusion, explainShowLevelExclusion } = require('./lib/review-guards');
const { listShowDirs } = require('./lib/list-show-dirs');
const { assertCorpusScanned } = require('./lib/corpus-scan-guard');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const {
  buildCensus,
  diffCensus,
  formatCensusReport,
  formatDriftReport,
  compareToRebuildExclusions,
  formatMirrorReport,
  buildMirrorSummary,
  checkMirrorSummary,
} = require('./lib/exclusion-rule-census');

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
const MIRROR_SUMMARY_PATH = path.join(AUDIT_DIR, 'exclusion-mirror-summary.json');
const REVIEWS_JSON = process.env.REVIEWS_JSON || path.join(REPO_ROOT, 'data', 'reviews.json');
const REBUILD_EXCLUSIONS_RE = /^rebuild-exclusions-(.+)\.json$/;

function readJsonOrNull(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// { showId: { file: statKey } } from the rebuild's per-show exclusion files.
function loadRebuildExclusions(auditDir) {
  const out = Object.create(null);
  let names = [];
  try { names = fs.readdirSync(auditDir); } catch { return out; }
  for (const name of names) {
    const m = name.match(REBUILD_EXCLUSIONS_RE);
    if (!m) continue;
    const payload = readJsonOrNull(path.join(auditDir, name));
    if (!payload || !Array.isArray(payload.exclusions)) continue;
    const files = Object.create(null);
    for (const ex of payload.exclusions) {
      if (ex && ex.file && ex.file !== '-' && ex.reason && !files[ex.file]) files[ex.file] = ex.reason;
    }
    out[payload.showId || m[1]] = files;
  }
  return out;
}

function loadProcessedShowIds(reviewsJsonPath) {
  const doc = readJsonOrNull(reviewsJsonPath);
  const reviews = doc && Array.isArray(doc.reviews) ? doc.reviews : [];
  return new Set(reviews.map((r) => r && r.showId).filter(Boolean));
}

// A leased opening-night show is not rebuilt: its rows are carried over and it
// gets no fresh exclusion list, so comparing it would invent disagreements.
function loadLeasedShowIds() {
  try {
    return new Set(require('./lib/opening-night-lane/lease-guard').leasedShowIds());
  } catch (e) {
    console.warn(`::warning::exclusion census: could not read opening-night leases (${e.message}); comparing all shows`);
    return new Set();
  }
}

// Show ids the rebuild skips before reading any file (explainShowLevelExclusion).
function wholeShowSkippedIds(showById, showIds) {
  const out = new Set();
  for (const id of showIds) if (explainShowLevelExclusion(showById[id])) out.add(id);
  return out;
}

function numArg(argv, name, fallback) {
  const raw = (argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function runCheck(argv) {
  const summary = readJsonOrNull(MIRROR_SUMMARY_PATH);
  const breaches = checkMirrorSummary(summary, {
    maxRuleDelta: numArg(argv, 'max-rule-delta', 200),
    maxRateRise: numArg(argv, 'max-rate-rise', 0.01),
  });
  if (summary) {
    const m = summary.mirror;
    console.log(`Exclusion mirror summary ${summary.generatedAt}: ${summary.totalExcluded}/${summary.totalScanned} excluded by the mirror`
      + (m ? `; ${m.disagreements}/${m.comparedFiles} disagree with the rebuild (${(m.disagreementRate * 100).toFixed(2)}%)` : ''));
    const deltas = Object.entries(summary.ruleDeltas || {}).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5);
    if (deltas.length) console.log(`  largest rule moves: ${deltas.map(([r, d]) => `${r} ${d > 0 ? '+' : ''}${d}`).join(', ')}`);
  }
  for (const b of breaches) console.log(`DRIFT: ${b}`);
  process.exit(breaches.length ? 1 : 0);
}

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
 * review file, returning one {showId, file, rule} record per file. With
 * rebuildExcludedByShow (BRO-5129) each record also carries alignedRule: the
 * same call given that show's rebuild list, used only for the mirror-vs-rebuild
 * comparison.
 */
function scanCorpus({ reviewTextsDir, showById, showFilter, rebuildExcludedByShow = null }) {
  const showDirs = showFilter ? [showFilter] : listShowDirs(reviewTextsDir);
  const records = [];
  for (const showId of showDirs) {
    const dirPath = path.join(reviewTextsDir, showId);
    let files;
    try {
      files = fs.readdirSync(dirPath).filter((f) => isReviewTextFile(f));
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
      const rebuildList = rebuildExcludedByShow && Object.prototype.hasOwnProperty.call(rebuildExcludedByShow, showId)
        ? rebuildExcludedByShow[showId] : null;
      if (rebuildList) {
        records.push({ showId, file, rule, alignedRule: explainExclusion(data, show, filePath, { rebuildExclusions: rebuildList }) });
      } else {
        records.push({ showId, file, rule });
      }
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
  const compareRebuild = argv.includes('--compare-rebuild');
  if (argv.includes('--check')) return runCheck(argv);

  console.error(`review-texts dir: ${REVIEW_TEXTS_DIR}`);
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error(`ERROR: review-texts dir not found at ${REVIEW_TEXTS_DIR}`);
    process.exit(1);
  }

  const showById = loadShowsById(SHOWS_JSON);
  // Loaded before the scan so each file's mirror verdict can consult its show's
  // list for the passes a per-file mirror cannot see (BRO-5129).
  const rebuildLists = compareRebuild ? loadRebuildExclusions(AUDIT_DIR) : null;
  const records = scanCorpus({ reviewTextsDir: REVIEW_TEXTS_DIR, showById, showFilter, rebuildExcludedByShow: rebuildLists });
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

  let comparison = null;
  if (compareRebuild) {
    const allLists = rebuildLists;
    const processedShowIds = loadProcessedShowIds(REVIEWS_JSON);
    const leased = loadLeasedShowIds();
    for (const id of leased) { delete allLists[id]; processedShowIds.delete(id); }
    if (leased.size) console.error(`exclusion census: ${leased.size} leased show(s) left out of the comparison`);
    // BRO-5129: an upcoming / Broadway-previews show is skipped before any file
    // is read, yet carried-over rows can keep it in reviews.json; its files
    // were never judged, so comparing them invents disagreements.
    const wholeShowSkipped = wholeShowSkippedIds(showById, [...processedShowIds, ...Object.keys(allLists)]);
    for (const id of wholeShowSkipped) { delete allLists[id]; processedShowIds.delete(id); }
    if (wholeShowSkipped.size) console.error(`exclusion census: ${wholeShowSkipped.size} show(s) the rebuild skips wholesale left out of the comparison`);
    const rebuildExcludedByShow = showFilter
      ? (allLists[showFilter] ? { [showFilter]: allLists[showFilter] } : {})
      : allLists;
    if (Object.keys(rebuildExcludedByShow).length === 0) {
      console.error(`WARN: --compare-rebuild found no rebuild-exclusions-*.json in ${AUDIT_DIR}; skipping comparison`);
    } else {
      comparison = compareToRebuildExclusions(records, {
        rebuildExcludedByShow,
        processedShowIds,
      });
      if (!jsonOnly) {
        console.log('');
        console.log('=== Mirror vs rebuild (explainExclusion vs rebuild-exclusions-*.json) ===');
        console.log(formatMirrorReport(comparison, { limit }));
      }
    }
    // A single-show comparison is a spot check; only a full scan feeds the
    // committed summary check-corpus-drift.js reads.
    // Local per-show lists can be left over from older rebuilds, so only a CI
    // run (fresh checkout, this run's lists) writes the committed summary.
    if (!showFilter && !process.env.GITHUB_ACTIONS && !process.env.EXCLUSION_CENSUS_WRITE_SUMMARY) {
      if (!jsonOnly) console.log(`\n${path.relative(REPO_ROOT, MIRROR_SUMMARY_PATH)} not written (local run; set EXCLUSION_CENSUS_WRITE_SUMMARY=1 to force)`);
    } else if (!showFilter) {
      const summary = buildMirrorSummary(census, comparison, readJsonOrNull(MIRROR_SUMMARY_PATH));
      fs.mkdirSync(AUDIT_DIR, { recursive: true });
      fs.writeFileSync(MIRROR_SUMMARY_PATH, JSON.stringify(summary, null, 2) + '\n');
      if (!jsonOnly) console.log(`\nWrote ${path.relative(REPO_ROOT, MIRROR_SUMMARY_PATH)}`);
    }
  }

  if (!showFilter) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n');
    if (!jsonOnly) console.log(`\nWrote ${path.relative(REPO_ROOT, SNAPSHOT_PATH)}`);
  }

  if (jsonOnly) console.log(JSON.stringify({ census: snapshot, diff, comparison }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { scanCorpus, loadShowsById, loadRebuildExclusions, loadProcessedShowIds, wholeShowSkippedIds };
