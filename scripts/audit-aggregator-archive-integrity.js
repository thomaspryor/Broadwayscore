#!/usr/bin/env node
/**
 * Aggregator-archive integrity audit.
 *
 * Walks every cached HTML archive under data/aggregator-archive/<src>/<showId>.html
 * and runs checkArchiveCategory() (validateRoundupPageTitle() plus the
 * shared punctuation rescue) to confirm the page title matches the
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
 *   node scripts/audit-aggregator-archive-integrity.js --check-stale  # exit 1 on stale baseline entries (BRO-5315)
 *   node scripts/audit-aggregator-archive-integrity.js --prune-stale  # drop only stale baseline entries
 *
 * Notion: 34e637c5-416f-812c (CI gate for cached archive validation, P2).
 */

const fs = require('fs');
const path = require('path');
const { scanArchiveIntegrity } = require('./lib/aggregator-archive-scan');
const { computeStaleBaselineKeys, reportStaleBaseline, pruneStaleEntries, runStaleModes } = require('./lib/stale-baseline');

const STRICT = process.argv.includes('--strict');
const UPDATE_BASELINE = process.argv.includes('--update-baseline');
// --check-stale / --prune-stale (BRO-5315, scripts/lib/stale-baseline.js):
// a known-bad archive the live scan no longer flags. Both exit before the
// report write.

const ROOT = path.join(__dirname, '..');
const ARCHIVE_ROOT = path.join(ROOT, 'data', 'aggregator-archive');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const REPORT_PATH = path.join(ROOT, 'data', 'audit', 'aggregator-archive-integrity.json');
const BASELINE_PATH = path.join(ROOT, 'data', 'audit', 'aggregator-archive-integrity-baseline.json');

function loadShowMap() {
  const raw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const list = raw.shows || raw;
  const byId = {};
  for (const s of list) byId[s.id] = s;
  return byId;
}

function audit() {
  const r = scanArchiveIntegrity(ARCHIVE_ROOT, loadShowMap());
  // `file` is for the quarantine script; the committed report keeps its original shape.
  return { ...r, bad: r.bad.map(({ file, ...rest }) => rest) };
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

const STALE_LABEL = 'aggregator-archive-integrity';
const STALE_CMD = 'node scripts/audit-aggregator-archive-integrity.js --prune-stale (or --update-baseline when the scan has no new bad archives)';
{
  const baselineDoc = loadBaseline() || {};
  runStaleModes(process.argv, {
    stale: computeStaleBaselineKeys(baselineDoc.knownBad || [], result.bad.map(b => `${b.source}/${b.showId}`)),
    label: STALE_LABEL,
    updateCmd: STALE_CMD,
    prune: (stale) => {
      if (!result.totalScanned) { console.error('refusing --prune-stale: scan found no archives (missing data/aggregator-archive?)'); process.exit(2); }
      baselineDoc.knownBad = pruneStaleEntries(baselineDoc.knownBad || [], k => k, stale);
      baselineDoc.updatedAt = new Date().toISOString();
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(baselineDoc, null, 2) + '\n');
    },
  });
}

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
  const removals = computeStaleBaselineKeys(knownBad, currentBad);

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

  console.log(`✓ No additions vs baseline (${knownBad.size} known-bad).`);
  reportStaleBaseline(removals, { label: STALE_LABEL, updateCmd: STALE_CMD });
}

console.log(`Report: ${REPORT_PATH}`);
