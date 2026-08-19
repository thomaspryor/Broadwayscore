#!/usr/bin/env node
'use strict';

/**
 * audit-excerpt-only-backfill-queue.js — BRO-115: report the remaining
 * excerpt-only-unscored backfill queue unlocked by task #501's
 * isIncludableForRebuild fix.
 *
 * The standing daily scoring pipeline (llm-ensemble-score.yml, cron
 * '--unscored-only') already delegates to the same canonical isScoreable()
 * gate #501 fixed, so it has been draining this backlog automatically since
 * the fix landed — this script does not re-implement scoring, it just
 * reports what is left so the backlog can be verified closed (or a residual
 * investigated) without re-running the corpus-wide sweep by hand.
 *
 * Usage:
 *   node scripts/audit-excerpt-only-backfill-queue.js              # report, exit 0
 *   node scripts/audit-excerpt-only-backfill-queue.js --json        # machine-readable
 *   node scripts/audit-excerpt-only-backfill-queue.js --gate --max=0   # exit 1 if over threshold
 *
 * Exit codes: 0 = at/under threshold (or --gate not passed), 1 = over threshold
 *   with --gate, 2 = could not run (corpus/shows.json missing).
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { isExcerptOnlyBackfillCandidate } = require('./lib/excerpt-backfill-eligibility');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { parseMaxArgOrExit } = require('./lib/parse-max-arg.js');

const USAGE = `audit-excerpt-only-backfill-queue.js — BRO-115 excerpt-only backfill queue report.

Usage:
  node scripts/audit-excerpt-only-backfill-queue.js [options]
  node scripts/audit-excerpt-only-backfill-queue.js --help, -h    print this usage and exit
`;

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  return {
    gate: argv.includes('--gate') || argv.includes('--strict'),
    json: argv.includes('--json'),
    max: parseMaxArgOrExit(argv, { scriptName: 'audit-excerpt-only-backfill-queue' }),
  };
}

function loadShowsById() {
  const showsPath = path.join(ROOT, 'data', 'shows.json');
  const raw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const arr = Array.isArray(raw) ? raw : (raw.shows || []);
  return new Map(arr.map((s) => [s.id, s]));
}

// Pure-ish scan (reads files): returns the candidate list. Kept separate from
// the CLI's I/O side effects so the queue logic stays testable via the
// predicate directly (see tests/unit/review-scoring-backfill.test.mjs).
function findBackfillCandidates(reviewTextsDir, showsById) {
  const candidates = [];
  let scanned = 0;
  const showDirs = listShowDirs(reviewTextsDir).filter((f) =>
    fs.statSync(path.join(reviewTextsDir, f)).isDirectory()
  );
  for (const showDir of showDirs) {
    const showPath = path.join(reviewTextsDir, showDir);
    let files;
    try {
      files = fs.readdirSync(showPath).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json');
    } catch {
      continue;
    }
    const show = showsById.get(showDir);
    for (const file of files) {
      const fp = path.join(showPath, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      } catch {
        continue;
      }
      scanned++;
      const ctx = { show, showTitle: show && show.title, filePath: fp };
      if (isExcerptOnlyBackfillCandidate(data, ctx)) {
        candidates.push({ path: fp, rel: `${showDir}/${file}`, showId: showDir });
      }
    }
  }
  return { candidates, scanned };
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const opts = parseArgs(process.argv.slice(2));

  const reviewTextsDir = resolveReviewTextsDir();
  if (!fs.existsSync(reviewTextsDir)) {
    console.error(`[excerpt-backfill] review-texts dir missing: ${reviewTextsDir}`);
    process.exit(2);
  }
  let showsById;
  try {
    showsById = loadShowsById();
  } catch (e) {
    console.error(`[excerpt-backfill] cannot load shows.json: ${e.message}`);
    process.exit(2);
  }

  const { candidates, scanned } = findBackfillCandidates(reviewTextsDir, showsById);
  const showsHit = new Set(candidates.map((c) => c.showId));

  if (opts.json) {
    console.log(JSON.stringify({
      scanned,
      candidateCount: candidates.length,
      showCount: showsHit.size,
      max: opts.max,
      examples: candidates.slice(0, 20).map((c) => c.rel),
    }, null, 2));
  } else {
    console.log(`[excerpt-backfill] ${candidates.length} excerpt-only backfill candidate(s) across ${showsHit.size} show(s), of ${scanned} scanned; threshold --max=${opts.max}`);
    for (const c of candidates.slice(0, 20)) console.log(`    - ${c.rel}`);
    if (candidates.length > 20) console.log(`    … +${candidates.length - 20} more`);
    console.log('[excerpt-backfill] These are already picked up by the standing daily llm-ensemble-score.yml run (--unscored-only) — no separate dispatch needed unless this count is unexpectedly high.');
  }

  const over = candidates.length > opts.max;
  process.exit(opts.gate && over ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { findBackfillCandidates };
