#!/usr/bin/env node
/**
 * check-rebuild-staleness-advisory.js — report-only post-rebuild half of the
 * stale-checkout race guard (BRO-3162), for the workflows that adopted the
 * guard via .github/actions/sync-review-texts-drift.
 *
 * Same scan as scripts/check-rebuild-staleness.js (shared:
 * scripts/lib/rebuild-staleness-scan.js) but, per CLAUDE.md rule 19 (new
 * gates land advisory first), it only REPORTS: ::error annotation + step
 * summary, exit 1 under a continue-on-error step. Unlike the blocking guard it
 * never touches data/audit/guard-escalation-state.json and never routes an
 * owner alert, which keeps:
 *   - ~17 unrelated workflows out of the blocking guard's single GUARD_ID
 *     streak counter (BRO-3162 card item 2: two blocks from two DIFFERENT
 *     workflows would read as one recurring problem and auto-recover);
 *   - tracked files clean in jobs that never commit data/audit/ (a dirty
 *     tracked file makes push-with-retry.sh's rebase refuse, BRO-3662).
 * The scraped data is already protected by the pre-rebuild drift sync; a
 * report here means the sync could not fully close the race, and the next
 * Rebuild Reviews Data / rebuild-fast run rebuilds from a fresh checkout.
 *
 * Usage: node scripts/check-rebuild-staleness-advisory.js --shows-file=<path>
 *   Missing/empty shows file = no drift this run = exit 0.
 *   Exit 1 = a drifted scoreable show is missing from reviews.json, or
 *   reviews.json could not be read.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readCandidateShowIds, scanDriftedShows } = require('./lib/rebuild-staleness-scan');

const DATA_DIR = path.join(path.resolve(__dirname, '..'), 'data');

function summarize(msg) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n## ⚠️ Stale-checkout race (advisory)\n\n${msg}\n`);
  } catch { /* best-effort */ }
}

function run(argv = process.argv.slice(2), dataDir = DATA_DIR) {
  const showsFileArg = (argv.find((a) => a.startsWith('--shows-file=')) || '').replace('--shows-file=', '') || null;
  const candidateShowIds = readCandidateShowIds(showsFileArg);
  if (candidateShowIds.length === 0) {
    console.log('[check-rebuild-staleness-advisory] no drifted shows this run — nothing to verify.');
    return 0;
  }
  const scan = scanDriftedShows(candidateShowIds, dataDir);
  const where = process.env.GITHUB_WORKFLOW || 'local run';
  if (!scan.ok) {
    const msg = `[check-rebuild-staleness-advisory] (${where}) could not read data/reviews.json after the rebuild — cannot verify the ${candidateShowIds.length} drifted show(s).`;
    console.error(`::error::${msg}`);
    summarize(msg);
    return 1;
  }
  if (scan.missing.length > 0) {
    const msg =
      `[check-rebuild-staleness-advisory] (${where}) ${scan.missing.length} show(s) had scoreable review-text ` +
      `files that drifted in during this job but ZERO reviews.json entries after rebuild — stale-checkout race. ` +
      `Shows: ${scan.missing.join(', ')}. The next Rebuild Reviews Data / rebuild-fast run rebuilds from a fresh checkout.`;
    console.error(`::error::${msg}`);
    summarize(msg);
    return 1;
  }
  console.log(
    `[check-rebuild-staleness-advisory] verified ${candidateShowIds.length} drifted show(s), ` +
    `${scan.scoreableShowIds.length} scoreable — all present in reviews.json.`,
  );
  return 0;
}

if (require.main === module) {
  process.exit(run());
}

module.exports = { run };
