#!/usr/bin/env node

/**
 * Self-contradictory clear-breadcrumb sweep (tasks #1020 / #1022 / #1023).
 *
 * Fires on review-text records that assert an exclusion flag AND their own
 * retraction breadcrumb at the same time — "this review is wrong" and "the
 * wrong-ness was cleared" in one file. Unlike the flag-vs-CV detectors in
 * audit-cv-flag-contradiction.js, this needs no adjudication between two
 * verdicts: the state is invalid on its face, so it gates.
 *
 * The forward fixes for the known pairs already exist (every wrongProduction
 * re-flag writer calls review-write-guard.invalidateWrongProductionAutoClear;
 * fix-playbill-bleed-attributions.js stamps wrongArticleManualClear on clear) —
 * this is the standing detector that proves they hold and surfaces the pre-fix
 * backlog. Pair coverage lives in scripts/lib/flag-contradiction.js
 * (SELF_CLEAR_PAIRS); adding a pair there is one table row.
 *
 * Usage:
 *   node scripts/audit-self-contradictory-clears.js              # report
 *   node scripts/audit-self-contradictory-clears.js --gate       # exit 1 over --max
 *   node scripts/audit-self-contradictory-clears.js --gate --max=0
 *   node scripts/audit-self-contradictory-clears.js --fix        # retract stale breadcrumbs
 *   node scripts/audit-self-contradictory-clears.js --show=ID    # scope to one show
 *   node scripts/audit-self-contradictory-clears.js --json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const {
  detectAllSelfContradictoryClears,
  retractStaleClearBreadcrumb,
  demoteStaleWrongShowPromotion,
} = require('./lib/flag-contradiction');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard');
const { parseMaxArgOrExit } = require('./lib/parse-max-arg.js');

const USAGE = `audit-self-contradictory-clears.js — exclusion flag + its own clear breadcrumb (#1020/#1022/#1023)

Usage:
  node scripts/audit-self-contradictory-clears.js [--gate] [--max=N] [--fix] [--show=ID] [--json]

  --gate            exit 1 when the count exceeds the baseline band (or --max)
  --baseline[=PATH] gate against the committed baseline count + tolerance
                    (preferred; defaults to data/audit/self-contradictory-
                    clears-baseline.json). Bot writes move this corpus every
                    ~30 min, so an absolute ceiling flaps main red.
  --record-baseline rewrite the baseline file from the current count
  --max=N           legacy absolute ceiling, used only without --baseline
  --fix             retract the stale CLEAR breadcrumb, leaving the flag intact.
                    NOT a safe bulk drain — it flips 563 records to
                    contentTier 'invalid' and drops 438 scored reviews out of
                    live scores. Use --show=ID for adjudicated single fixes.
  --show=ID         scope the sweep to one show directory
  --json            machine-readable output
`;

const ROOT = path.resolve(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const DEFAULT_BASELINE_PATH = path.join(ROOT, 'data', 'audit', 'self-contradictory-clears-baseline.json');

// Why this gate is a BAND around a committed baseline rather than an absolute
// ceiling (2026-08-14).
//
// The old form was `--gate --max=780` against a live count of ~772-776. The
// rebuild bots rewrite this corpus every ~30 minutes and each pass moves the
// count by a few records, so main went red at 20:27 and 20:31 and green at
// 20:33 and 20:37 — the SAME code, four different answers. A ceiling sitting
// ~4 records above the live count is a coin flip, not a guard. (This session
// watched the count read 772 and 776 twenty minutes apart.)
//
// The workflow's prescribed remedy was "DRAIN THEN RATCHET" — run --fix, then
// lower --max. That remedy was measured on 2026-08-14 and is UNSAFE. --fix
// deletes the clear breadcrumb and leaves the exclusion flag standing, and
// content-quality.js:classifyContentTier treats `wrongProduction &&
// !wrongProductionAutoCleared` as contentTier 'invalid'. So removing the
// breadcrumb EXCLUDES the review:
//     563 of 772 records flip contentTier valid -> invalid
//     438 of those carry a live score signal (assignedScore/aggregatorStars/
//         showScoreExcerpt/llmScore), incl. NYT, WSJ, The Stage, FT
//       0 records become newly INCLUDED
// That is the mirror image of the sibling remediation that was deleted after
// audit-stale-flag-after-url-correction.js --fix un-suppressed 8 wrong-
// production reviews into live Critic Scores. Draining here would silently
// drop 438 scored reviews out of published scores. Do not run --fix in bulk.
//
// So the backlog is STRUCTURAL, not a queue to be worked off, and the honest
// gate is "has this got materially worse than the number we last agreed to?"
// A committed baseline + tolerance keeps drift visible (every run prints the
// delta) while a single bot write no longer reddens main. A genuine new source
// of contradictions still fails the moment it exceeds the band.
const BASELINE_TOLERANCE = 25;

// Tombstone directories only. `_pending/` is deliberately NOT here: it holds
// real reviews awaiting a byline strand that later land on a live show, so a
// contradiction parked there must still gate (memory/feedback_pending_no_byline
// _strand_drain). `_superseded-misattributed/` is the graveyard for records
// already replaced — their flag state is history, not a live scoring input.
const SKIP_DIRS = new Set(['_superseded-misattributed']);

function parseArgs(argv) {
  // --max via the shared parser: the old inline parseInt returned NaN for
  // `--max=abc`/`--max=`, and `unhandled > NaN` is always false, which would
  // have silently disabled this gate. test.yml now gates on --baseline instead,
  // but --max is still the fallback path whenever --baseline is absent, so the
  // NaN-safety it provides still matters.
  const args = {
    gate: false,
    max: parseMaxArgOrExit(argv, { scriptName: 'audit-self-contradictory-clears' }),
    fix: false,
    show: null,
    json: false,
    baseline: null,
    recordBaseline: false,
  };
  for (const a of argv) {
    if (a === '--gate') args.gate = true;
    else if (a === '--fix') args.fix = true;
    else if (a === '--json') args.json = true;
    else if (a === '--record-baseline') args.recordBaseline = true;
    else if (a === '--baseline') args.baseline = DEFAULT_BASELINE_PATH;
    else if (a.startsWith('--baseline=')) args.baseline = a.slice('--baseline='.length);
    else if (a.startsWith('--show=')) args.show = a.split('=')[1];
  }
  return args;
}

// Committed baseline: { count, tolerance, recordedAt, note }. A missing or
// unparseable file is FATAL under --gate rather than a silent fall-through to
// the old ceiling — a gate that quietly stops gating when its baseline goes
// missing is the vacuous-guard class this repo has already fixed six times
// (see corpus-scan-guard.js / #1063).
function readBaseline(baselinePath) {
  const raw = fs.readFileSync(baselinePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (typeof parsed.count !== 'number' || !Number.isFinite(parsed.count)) {
    throw new Error(`baseline ${baselinePath} has no numeric "count"`);
  }
  const tolerance = typeof parsed.tolerance === 'number' && Number.isFinite(parsed.tolerance)
    ? parsed.tolerance
    : BASELINE_TOLERANCE;
  return { count: parsed.count, tolerance };
}

function listShowDirs(showFilter) {
  let entries;
  try {
    entries = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    // isDirectory() is false for symlinked show dirs — accept those too, but
    // never plain files (the stray-symlink class, memory/feedback_stray_symlink).
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .filter((name) => !SKIP_DIRS.has(name))
    .filter((name) => !showFilter || name === showFilter)
    .filter((name) => {
      try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, name)).isDirectory(); }
      catch { return false; }
    });
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const args = parseArgs(process.argv.slice(2));

  const hits = [];
  let fixed = 0;
  let scanned = 0;

  for (const showId of listShowDirs(args.show)) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try { files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json')); }
    catch { continue; }

    for (const file of files) {
      const filePath = path.join(showDir, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
      catch { continue; }
      scanned++;

      // ALL contradictions on this record, not just the first — a file can
      // carry more than one pair, and fixing one per pass would need repeated
      // runs to converge while reporting itself clean-ish in between.
      const contradictions = detectAllSelfContradictoryClears(data);
      if (!contradictions.length) continue;
      for (const c of contradictions) hits.push({ showId, file, ...c });

      if (args.fix) {
        let removedAny = false;
        for (const c of contradictions) {
          // Dispatch per pair: demote-flag (currently only #1022, wrongShow +
          // contentVerificationPromoted) clears the stale FLAG instead of the
          // breadcrumb — see demoteStaleWrongShowPromotion's docstring for why
          // retractStaleClearBreadcrumb is the wrong resolution for that pair.
          if (c.resolution === 'demote-flag') {
            if (demoteStaleWrongShowPromotion(data, c)) removedAny = true;
          } else if (retractStaleClearBreadcrumb(data, c).length) {
            removedAny = true;
          }
        }
        if (removedAny) {
          // Deliberately a plain write, not safeWriteReview(): the whole point
          // is to REMOVE breadcrumbs that safeWriteReview's isIntentionalClear
          // machinery would otherwise treat as protected and restore. Listed in
          // .review-write-guard-exempt.txt so the write-routing lint records
          // this as a reviewed exemption rather than passing by accident (the
          // lint's import check is textual and the word safeWriteReview appears
          // in this very comment).
          fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
          fixed++;
        }
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ scanned, count: hits.length, fixed, hits }, null, 2));
  } else {
    console.log(`Self-contradictory clear sweep: ${scanned} review file(s) scanned, ${hits.length} contradiction(s).`);
    const byPair = {};
    for (const h of hits) {
      const key = `${h.flag} + ${h.breadcrumb} (${h.task})`;
      (byPair[key] = byPair[key] || []).push(h);
    }
    for (const [pair, list] of Object.entries(byPair).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${String(list.length).padStart(4)} | ${pair}`);
      for (const h of list.slice(0, 5)) console.log(`         ${h.showId}/${h.file}`);
      if (list.length > 5) console.log(`         … and ${list.length - 5} more`);
    }
    if (args.fix) console.log(`\nRetracted stale breadcrumbs on ${fixed} file(s).`);
  }

  // FAIL LOUD on an empty corpus. review-texts is a private-repo checkout; when
  // it is missing the sweep finds zero contradictions and a naive gate reports
  // PASS — a vacuous guard that would go green for every CI run that forgot the
  // checkout, exactly when it is least able to see a regression. Caught by
  // running the gate with the corpus symlink removed (2026-08-05). Shared
  // across all corpus audits — see scripts/lib/corpus-scan-guard.js (#1063).
  try {
    assertCorpusScanned(scanned, { gate: args.gate });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`\nFAIL: ${e.message}`);
    process.exit(1);
  }

  if (args.recordBaseline) {
    const target = args.baseline || DEFAULT_BASELINE_PATH;
    fs.writeFileSync(target, `${JSON.stringify({
      count: hits.length,
      tolerance: BASELINE_TOLERANCE,
      recordedAt: new Date().toISOString().split('T')[0],
      note: 'Structural backlog — see the BASELINE_TOLERANCE comment in scripts/audit-self-contradictory-clears.js. --fix is NOT a safe drain (it excludes 438 scored reviews).',
    }, null, 2)}\n`);
    console.log(`\nRecorded baseline ${hits.length} (±${BASELINE_TOLERANCE}) → ${target}`);
    return;
  }

  if (args.gate && args.baseline) {
    let baseline;
    try {
      baseline = readBaseline(args.baseline);
    } catch (e) {
      console.error(`\nFAIL: cannot read baseline (${e.message}).`);
      console.error('Fix: node scripts/audit-self-contradictory-clears.js --record-baseline');
      process.exit(1);
    }
    const delta = hits.length - baseline.count;
    const sign = delta >= 0 ? '+' : '';
    console.log(`\nBaseline ${baseline.count} (±${baseline.tolerance}) — now ${hits.length} (${sign}${delta}).`);
    if (delta > baseline.tolerance) {
      console.error(`\nFAIL: ${hits.length} self-contradictory clear(s) is ${delta} over the committed baseline of ${baseline.count} (tolerance ±${baseline.tolerance}).`);
      console.error('This is a REGRESSION: something started writing an exclusion flag alongside its own');
      console.error('clear breadcrumb. Find the writer — do NOT re-record the baseline to make this pass,');
      console.error('and do NOT bulk-run --fix (it excludes scored reviews; see the comment in this file).');
      process.exit(1);
    }
    if (-delta > baseline.tolerance) {
      // An improvement, not a failure — but the baseline is now stale and would
      // hide a later regression back up to the old number, so say so loudly.
      console.log(`NOTE: count is ${-delta} BELOW baseline — re-record it with --record-baseline to keep the band tight.`);
    }
    return;
  }

  if (args.gate && hits.length > args.max) {
    console.error(`\nFAIL: ${hits.length} self-contradictory clear(s) > max ${args.max}.`);
    console.error('Fix: investigate the writer. --fix is NOT a safe bulk drain — see the comment in this file.');
    process.exit(1);
  }
}

main();
