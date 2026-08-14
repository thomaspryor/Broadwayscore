#!/usr/bin/env node
'use strict';

/**
 * audit-stuck-rescore-flags.js — corpus invariant: no review may carry
 * needsRescore=true while the scorer would reject it (isScoreable=false).
 *
 * Such a flag never clears (the scorer filters non-scoreable reviews out BEFORE
 * processing and only clears needsRescore AFTER scoring), so it sits in the
 * rescore queue forever and accumulates every cron. See scripts/lib/stuck-rescore-flag.js
 * for the full rationale (the late-star producer/consumer seam bug, 2026-06-30).
 *
 * Report grouped by rescoreReason so a producer bug (one reason dominating) is
 * obvious. --fix clears the stuck flags (needsRescore/rescoreReason/lateStarAnchorBand)
 * via the write guard. Non-blocking by default; --gate/--strict escalates.
 *
 * Usage:
 *   node scripts/audit-stuck-rescore-flags.js              # report, exit 0 (or 1 if any, with --gate)
 *   node scripts/audit-stuck-rescore-flags.js --max=0      # threshold for drift exit-1
 *   node scripts/audit-stuck-rescore-flags.js --gate       # exit 1 if count > max
 *   node scripts/audit-stuck-rescore-flags.js --fix        # clear stuck flags
 *   node scripts/audit-stuck-rescore-flags.js --json       # machine-readable
 *
 * Exit codes: 0 = at/under threshold, 1 = over threshold (only with --gate/--strict),
 *   2 = could not run (corpus/shows.json missing).
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { isStuckRescoreFlag, isScoredButStillQueued } = require('./lib/stuck-rescore-flag');

const { hasHelpFlag } = require('./lib/cli-help.js');
const { parseMaxArgOrExit } = require('./lib/parse-max-arg.js');

const USAGE = `audit-stuck-rescore-flags.js — corpus invariant: no review may carry.

Usage:
  node scripts/audit-stuck-rescore-flags.js [options]
  node scripts/audit-stuck-rescore-flags.js --help, -h    print this usage and exit
`;
const ROOT = path.join(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');

function parseArgs(argv) {
  return {
    fix: argv.includes('--fix'),
    gate: argv.includes('--gate') || argv.includes('--strict'),
    json: argv.includes('--json'),
    max: parseMaxArgOrExit(argv, { scriptName: 'audit-stuck-rescore-flags' }),
  };
}

function loadShowTitles() {
  const showsPath = path.join(ROOT, 'data', 'shows.json');
  const raw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const arr = Array.isArray(raw) ? raw : (raw.shows || []);
  return new Map(arr.map((s) => [s.id, s.title]));
}

// Pure-ish scan (reads files): returns the stuck list. Kept separate from I/O
// side effects (--fix) so the invariant logic stays testable via the predicate.
function findStuck(reviewTextsDir, titleById) {
  const stuck = [];
  let total = 0;
  const showDirs = listShowDirs(reviewTextsDir).filter((f) =>
    fs.statSync(path.join(reviewTextsDir, f)).isDirectory()
  );
  for (const showDir of showDirs) {
    const showPath = path.join(reviewTextsDir, showDir);
    const files = fs
      .readdirSync(showPath)
      .filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json');
    for (const file of files) {
      const fp = path.join(showPath, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      } catch {
        continue;
      }
      if (data.needsRescore !== true) continue;
      total++;
      const show = titleById.get(showDir) ? { title: titleById.get(showDir) } : undefined;
      if (isStuckRescoreFlag(data, show, fp)) {
        stuck.push({
          path: fp,
          rel: `${showDir}/${file}`,
          reason: data.rescoreReason || '(none)',
          kind: 'not-scoreable',
        });
      } else if (isScoredButStillQueued(data)) {
        // Sibling half of the seam: already scored, flag never retired, so the
        // file is re-scored on every drain (2026-07-26). Same remedy as the
        // not-scoreable class — clear the flag; the score is already on disk.
        stuck.push({
          path: fp,
          rel: `${showDir}/${file}`,
          reason: data.rescoreReason || '(none)',
          kind: 'scored-but-queued',
        });
      }
    }
  }
  return { stuck, totalFlagged: total };
}

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error(`[stuck-rescore] review-texts dir missing: ${REVIEW_TEXTS_DIR}`);
    process.exit(2);
  }
  let titleById;
  try {
    titleById = loadShowTitles();
  } catch (e) {
    console.error(`[stuck-rescore] cannot load shows.json: ${e.message}`);
    process.exit(2);
  }

  const { stuck, totalFlagged } = findStuck(REVIEW_TEXTS_DIR, titleById);

  const byReason = {};
  for (const s of stuck) byReason[s.reason] = (byReason[s.reason] || 0) + 1;

  // REPORT-ONLY for kind==='scored-but-queued' (2026-07-26). That predicate keys
  // on scoreSource==='manual-cleared-haiku-fallback', but scoreSource is NOT
  // durable provenance: collect-review-texts.js:4186 requeues a file (fullText
  // arrived after excerpt scoring) WITHOUT resetting scoreSource, so a perfectly
  // valid pending rescore can still carry the fallback source. --fix deletes
  // needsRescore, which would silently cancel that real rescore. The producing
  // bug is already fixed at source (rescore-lifecycle.js markRescoreComplete on
  // every success path), so this class only needs to be VISIBLE, never auto-fixed.
  // Revisit once producers stamp rescoreFlaggedAt (Notion 3a9637c5-416f-8155).
  const fixable = stuck.filter((s) => s.kind !== 'scored-but-queued');
  const reportOnly = stuck.length - fixable.length;
  if (opts.fix && reportOnly) {
    console.log(`[stuck-rescore] ${reportOnly} scored-but-queued flag(s) reported but NOT auto-fixed (see comment above --fix)`);
  }
  if (opts.fix && fixable.length) {
    // Lazy-require so the pure/report path has no write-guard dependency.
    const { safeWriteReview } = require('./lib/review-write-guard');
    for (const s of fixable) {
      const d = JSON.parse(fs.readFileSync(s.path, 'utf8'));
      delete d.needsRescore;
      delete d.rescoreReason;
      delete d.lateStarAnchorBand;
      // Freshness-gated breadcrumb (task #1259, same shape as tasks #97/#1237):
      // this runs in enrich-reviews.yml's single job, which later calls
      // push-review-texts — without this stamp, the restore step sees
      // committed HEAD (checked out before this ran) still carrying the
      // stuck flag and resurrects it. review-write-guard.js CLEAR_BREADCRUMBS
      // honors it for needsRescore/rescoreReason/lateStarAnchorBand.
      d.stuckRescoreCleared = true;
      d.stuckRescoreClearedAt = new Date().toISOString();
      safeWriteReview(s.path, d, { force: true });
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({
      totalFlagged, stuckCount: stuck.length, max: opts.max, byReason,
      fixed: opts.fix ? stuck.length : 0,
      examples: stuck.slice(0, 20).map((s) => ({ rel: s.rel, reason: s.reason })),
    }, null, 2));
  } else {
    console.log(`[stuck-rescore] ${stuck.length} stuck needsRescore flag(s) (non-scoreable) of ${totalFlagged} flagged; threshold --max=${opts.max}`);
    for (const [reason, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${reason}`);
    }
    for (const s of stuck.slice(0, 20)) console.log(`    - ${s.rel}  [${s.reason}]`);
    if (stuck.length > 20) console.log(`    … +${stuck.length - 20} more`);
    if (opts.fix) console.log(`[stuck-rescore] --fix cleared ${stuck.length} flag(s).`);
    if (stuck.length > opts.max && !opts.fix) {
      console.log(`[stuck-rescore] A dominant single reason usually means a producer flagged non-includable reviews — fix that producer to gate on isScoreable/isIncludableForRebuild, then --fix the residue.`);
    }
  }

  const over = stuck.length > opts.max;
  process.exit(opts.gate && over && !opts.fix ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { findStuck };
