#!/usr/bin/env node
'use strict';

/**
 * audit-stale-score-input.js — corpus-wide detector + backfill for card #1902:
 * reviews scored off an excerpt that now have fullText on disk, with nothing
 * having ever raised needsRescore for them (the write-time hook in
 * review-file-writer.js and the wrongProduction auto-clear sites in
 * rebuild-all-reviews.js only catch this going FORWARD, from the moment they
 * landed — this script finds and backfills the EXISTING backlog).
 *
 * Measured 2026-08-26: 653 reviews across ~439 shows have contentTier
 * complete/truncated but llmMetadata.textSource.type=excerpt. Of those, 375
 * (261 shows) are safe to flag per isScoreable(); the other 278 would become
 * permanent stuck flags if flagged — see scripts/lib/stuck-rescore-flag.js's
 * invariant (needsRescore===true ⟹ isScoreable()===true, the 2026-06-30
 * late-star bug). `total` is the coarse population (contentTier +
 * textSource.type — the same signal used to measure the incident); `fixable`
 * is the subset scripts/lib/rescore-flagging.js's isStaleScoreInput() accepts
 * (also requires a prior numeric assignedScore and no ensembleData);
 * `unscoreable` is total minus fixable. Gate on `fixable` only — `total`
 * never reaches 0 (278 residual is permanent-exclusion backlog).
 *
 * Usage:
 *   node scripts/audit-stale-score-input.js                 # report, exit 0
 *   node scripts/audit-stale-score-input.js --show=ID        # scope to one show
 *   node scripts/audit-stale-score-input.js --json           # {total,fixable,unscoreable,...}
 *   node scripts/audit-stale-score-input.js --fix             # flag the fixable subset
 *   node scripts/audit-stale-score-input.js --fix --show=ID   # canary a single show
 *   node scripts/audit-stale-score-input.js --strict --max=0  # exit 1 if fixable > max
 *
 * Exit codes: 0 = at/under threshold (or no --strict), 1 = fixable > max
 *   (only with --strict/--gate and not --fix), 2 = could not run.
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { isStaleScoreInput, markRescoreNeeded } = require('./lib/rescore-flagging');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { parseMaxArgOrExit } = require('./lib/parse-max-arg.js');

const USAGE = `audit-stale-score-input.js — find reviews scored off an excerpt that now have fullText, with no rescore ever flagged.

Usage:
  node scripts/audit-stale-score-input.js [options]
  node scripts/audit-stale-score-input.js --help, -h    print this usage and exit
`;

const ROOT = path.join(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');

function parseArgs(argv) {
  const showArg = argv.find((a) => a.startsWith('--show='));
  return {
    fix: argv.includes('--fix'),
    gate: argv.includes('--gate') || argv.includes('--strict'),
    json: argv.includes('--json'),
    show: showArg ? showArg.slice('--show='.length) : null,
    max: parseMaxArgOrExit(argv, { scriptName: 'audit-stale-score-input' }),
  };
}

// Mirrors flag-rescore-needed.js's loadShowTitles — isScoreable's wrongShow
// override and premature-review gate need status/date fields, not just title.
function loadShowTitles() {
  const map = new Map();
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  for (const s of (raw.shows || raw)) {
    if (s.id && s.title) {
      map.set(s.id, {
        title: s.title,
        status: s.status,
        previewDate: s.previewDate,
        previewsStartDate: s.previewsStartDate,
        openingDate: s.openingDate,
        priorRuns: s.priorRuns,
      });
    }
  }
  return map;
}

// The coarse population signal card #1902's investigation measured 653
// against: scored, but the persisted score came from an excerpt even though
// the file now carries usable full text.
function isCandidate(data) {
  if (!data) return false;
  if (data.contentTier !== 'complete' && data.contentTier !== 'truncated') return false;
  return data.llmMetadata?.textSource?.type === 'excerpt';
}

function scan(reviewTextsDir, titleById, showFilter) {
  const results = { total: 0, fixable: 0, unscoreable: 0, fixableFiles: [], unscoreableFiles: [] };
  let showDirs = listShowDirs(reviewTextsDir).filter((f) =>
    fs.statSync(path.join(reviewTextsDir, f)).isDirectory()
  );
  if (showFilter) showDirs = showDirs.filter((d) => d === showFilter);

  for (const showDir of showDirs) {
    const showPath = path.join(reviewTextsDir, showDir);
    const files = fs
      .readdirSync(showPath)
      .filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json');
    const show = titleById.get(showDir);
    for (const file of files) {
      const fp = path.join(showPath, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      } catch {
        continue;
      }
      if (!isCandidate(data)) continue;
      results.total++;
      const rel = `${showDir}/${file}`;
      if (isStaleScoreInput(data, show, fp)) {
        results.fixable++;
        results.fixableFiles.push({ path: fp, rel });
      } else {
        results.unscoreable++;
        results.unscoreableFiles.push({ path: fp, rel });
      }
    }
  }
  return results;
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error(`[stale-score-input] review-texts dir missing: ${REVIEW_TEXTS_DIR}`);
    process.exit(2);
  }
  let titleById;
  try {
    titleById = loadShowTitles();
  } catch (e) {
    console.error(`[stale-score-input] cannot load shows.json: ${e.message}`);
    process.exit(2);
  }

  const results = scan(REVIEW_TEXTS_DIR, titleById, opts.show);

  if (opts.fix && results.fixableFiles.length) {
    const { safeWriteReview } = require('./lib/review-write-guard');
    for (const f of results.fixableFiles) {
      const d = JSON.parse(fs.readFileSync(f.path, 'utf8'));
      markRescoreNeeded(d, 'fullText added after excerpt-based score (backfill)');
      safeWriteReview(f.path, d, { force: true });
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({
      total: results.total,
      fixable: results.fixable,
      unscoreable: results.unscoreable,
      max: opts.max,
      fixed: opts.fix ? results.fixableFiles.length : 0,
      examples: results.fixableFiles.slice(0, 20).map((f) => f.rel),
    }, null, 2));
  } else {
    console.log(`[stale-score-input] ${results.total} candidate(s)${opts.show ? ` (show=${opts.show})` : ''}: ${results.fixable} fixable, ${results.unscoreable} unscoreable; threshold --max=${opts.max}`);
    for (const f of results.fixableFiles.slice(0, 20)) console.log(`    - ${f.rel}`);
    if (results.fixableFiles.length > 20) console.log(`    … +${results.fixableFiles.length - 20} more fixable`);
    if (opts.fix) console.log(`[stale-score-input] --fix flagged ${results.fixableFiles.length} file(s) for rescore.`);
  }

  const over = results.fixable > opts.max;
  process.exit(opts.gate && over && !opts.fix ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { scan, isCandidate };
