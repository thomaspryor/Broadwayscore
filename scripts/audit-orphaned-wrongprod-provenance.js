#!/usr/bin/env node
/**
 * BRO-2740 corpus gate: review-text files with wrongProduction provenance but
 * no wrongProduction flag and no clear record (a merge dropped only the flag,
 * so the file silently scores). Predicate: scripts/lib/orphaned-wrongprod-provenance.js.
 *
 * Usage:
 *   node scripts/audit-orphaned-wrongprod-provenance.js            # report
 *   node scripts/audit-orphaned-wrongprod-provenance.js --gate     # exit 1 on any orphan NOT in baseline
 *   node scripts/audit-orphaned-wrongprod-provenance.js --update-baseline  # freeze current set (supervised)
 *   Corpus location: resolveReviewTextsDir() (REVIEW_TEXTS_DIR env override; worktrees fall back to the main checkout).
 * Wired into scripts/check-corpus-drift.js AUDITS (non-blocking), NOT test.yml: a live-corpus baseline-diff
 * gate there can redden main on an unrelated bot commit (BRO-3535 precedent).
 *
 * Baseline: data/audit/orphaned-wrongprod-provenance-baseline.json. Each baselined
 * file needs triage (restore the flag, or delete the false provenance); do NOT
 * bulk-restore, it changes scoring (CLAUDE.md 12.7: scoring-delta.js first).
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const { listShowDirs } = require('./lib/list-show-dirs');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { isOrphanedWrongProdProvenance } = require('./lib/orphaned-wrongprod-provenance');

const REVIEW_TEXTS_DIR = resolveReviewTextsDir();
const BASELINE_PATH = path.join(__dirname, '..', 'data', 'audit', 'orphaned-wrongprod-provenance-baseline.json');
// Corpus is ~46k files; a half-synced checkout must not pass vacuously.
const MIN_FILES = 30000;
const ARGV = process.argv.slice(2);
if (hasHelpFlag(ARGV)) {
  console.log('Usage: node scripts/audit-orphaned-wrongprod-provenance.js [--gate | --update-baseline]\n  (no flag) report; --gate exit 1 on orphans not in baseline; --update-baseline freeze current set.');
  process.exit(0);
}
const GATE = ARGV.includes('--gate');
const UPDATE_BASELINE = ARGV.includes('--update-baseline');

function loadBaseline() {
  try {
    const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    return new Set(Array.isArray(raw.files) ? raw.files : []);
  } catch {
    return new Set();
  }
}

function scan(dir) {
  const orphans = [];
  let scanned = 0;
  let unparseable = 0;
  for (const showId of listShowDirs(dir, { silent: true })) {
    let files;
    try { files = fs.readdirSync(path.join(dir, showId)).filter(f => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(dir, showId, f), 'utf8')); } catch { unparseable++; continue; }
      scanned++;
      if (isOrphanedWrongProdProvenance(d)) orphans.push(`${showId}/${f}`);
    }
  }
  return { orphans: orphans.sort(), scanned, unparseable };
}

function main() {
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error(`✗ review-texts not found at ${REVIEW_TEXTS_DIR} (set REVIEW_TEXTS_DIR or run setup-local-data.sh)`);
    process.exit(2);
  }
  const { orphans, scanned, unparseable } = scan(REVIEW_TEXTS_DIR);
  // A near-empty checkout would pass vacuously; fail loud instead.
  if (scanned < MIN_FILES || unparseable > scanned * 0.01) {
    console.error(`✗ ${scanned} review files scanned (${unparseable} unparseable) from ${REVIEW_TEXTS_DIR}; refusing to pass on a partial/corrupt checkout`);
    process.exit(2);
  }

  if (UPDATE_BASELINE) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify({
      generatedAt: new Date().toISOString().slice(0, 10),
      note: 'BRO-2740: files with orphaned wrongProduction provenance. Triage each (restore flag or delete provenance); shrink, never grow.',
      files: orphans,
    }, null, 2) + '\n');
    console.log(`Baseline written: ${orphans.length} files`);
    return;
  }

  const baseline = loadBaseline();
  const fresh = orphans.filter(o => !baseline.has(o));
  const stale = [...baseline].filter(b => !orphans.includes(b));
  console.log(`Scanned ${scanned} files: ${orphans.length} orphaned (${orphans.length - fresh.length} baselined, ${fresh.length} NEW, ${stale.length} baseline entries now fixed)`);
  if (fresh.length) {
    console.log('NEW orphaned wrongProduction provenance (flag dropped, file would score):');
    for (const o of fresh) console.log(`  ${o}`);
    console.log('Fix: restore wrongProduction:true if the detection was right, else delete the wrongProduction* provenance fields.');
  }
  if (stale.length) console.log(`(run --update-baseline to drop ${stale.length} fixed entries)`);
  if (GATE && fresh.length) process.exit(1);
}

main();
