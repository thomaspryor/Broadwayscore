#!/usr/bin/env node
'use strict';

/**
 * audit-excerpt-only-backfill-queue.js — BRO-115: report the remaining
 * excerpt-only-unscored backfill queue unlocked by task #501's
 * isIncludableForRebuild fix.
 *
 * The standing daily scoring pipeline (llm-ensemble-score.yml, cron
 * '--unscored-only') selects files via the same canonical isActionableUnscored()
 * gate this script's predicate delegates to, so anything reported here is, at
 * minimum, in that run's selection set. This script does NOT prove those
 * files have actually been scored yet or will be in the next run alone — the
 * cron caps how much it processes per run and can batch asynchronously, so a
 * nonzero count here is a snapshot of current eligibility, not a completion
 * or dispatch guarantee. Verify actual scoring by re-running this script (or
 * checking llmScore on the specific files) after the next cron run, not by
 * reading this report's exit code alone.
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
//
// Read/parse failures are COUNTED, not swallowed (scoring-queue-counts.js's
// own pattern) — a spike in malformed/unreadable entries means this scan is
// under-reporting real work, and a caller trusting `candidates.length === 0`
// as "queue is empty" needs to see that the scan itself was incomplete.
function findBackfillCandidates(reviewTextsDir, showsById) {
  const candidates = [];
  let scanned = 0;
  let malformed = 0;
  let unreadableDirs = 0;
  const showDirs = listShowDirs(reviewTextsDir).filter((f) => {
    try {
      return fs.statSync(path.join(reviewTextsDir, f)).isDirectory();
    } catch {
      unreadableDirs++;
      return false;
    }
  });
  for (const showDir of showDirs) {
    const showPath = path.join(reviewTextsDir, showDir);
    let files;
    try {
      files = fs.readdirSync(showPath).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json');
    } catch {
      unreadableDirs++;
      continue;
    }
    const show = showsById.get(showDir);
    for (const file of files) {
      const fp = path.join(showPath, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      } catch {
        malformed++;
        continue;
      }
      scanned++;
      const ctx = { show, showTitle: show && show.title, filePath: fp };
      if (isExcerptOnlyBackfillCandidate(data, ctx)) {
        candidates.push({ path: fp, rel: `${showDir}/${file}`, showId: showDir });
      }
    }
  }
  return { candidates, scanned, malformed, unreadableDirs };
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

  const { candidates, scanned, malformed, unreadableDirs } = findBackfillCandidates(reviewTextsDir, showsById);
  const showsHit = new Set(candidates.map((c) => c.showId));

  if (opts.json) {
    console.log(JSON.stringify({
      scanned,
      malformed,
      unreadableDirs,
      candidateCount: candidates.length,
      showCount: showsHit.size,
      max: opts.max,
      examples: candidates.slice(0, 20).map((c) => c.rel),
    }, null, 2));
  } else {
    console.log(`[excerpt-backfill] ${candidates.length} excerpt-only backfill candidate(s) across ${showsHit.size} show(s), of ${scanned} scanned (${malformed} malformed, ${unreadableDirs} unreadable dir(s)); threshold --max=${opts.max}`);
    for (const c of candidates.slice(0, 20)) console.log(`    - ${c.rel}`);
    if (candidates.length > 20) console.log(`    … +${candidates.length - 20} more`);
    console.log('[excerpt-backfill] These pass the same isActionableUnscored() gate the standing daily llm-ensemble-score.yml run selects on — re-run this script (or check llmScore on the files above) after its next run to confirm they actually scored; a nonzero count here is not proof of completion.');
  }

  const over = candidates.length > opts.max;
  process.exit(opts.gate && over ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { findBackfillCandidates };
