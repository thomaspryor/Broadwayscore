#!/usr/bin/env node
/**
 * Backward-looking SERP wrong-production audit (BRO-2271).
 *
 * BRO-736 fixed FUTURE opening-night discovery runs: gather-reviews.js's
 * --opening-night mode, discover-opening-night-reviews.js, and
 * opening-night-poller.js now reject a SERP-discovered URL whose embedded
 * year doesn't match the show's opening year (0-grace
 * isSerpUrlWrongProductionForOpeningNight), unless a declared priorRuns/
 * tourLegs window explains it.
 *
 * Before that fix, all three paths used isUrlYearOutsideWindow
 * (scripts/lib/content-filters.js), which grants a -3y grace on the opening
 * year. Any revival/transfer whose SERP-discovered reviews came from an
 * undeclared earlier/different production within that 3-year window could
 * have been silently absorbed into the corpus already sitting in
 * data/review-texts. This script re-runs the STRICT (0-grace) check against
 * every file the loose guard could plausibly have let through, to find
 * contamination that predates the fix and is not caught by it.
 *
 * SUSPECT_SOURCES is the set of `source` tags written by the paths that used
 * to call isUrlYearOutsideWindow: gather-reviews.js's own SERP/site-search
 * discovery (serp-discovery, serp-discovery-per-critic, site-search),
 * discover-opening-night-reviews.js (broad-web-serp, opening-night-discovery),
 * discover-outlet-reviews-serp.js (outlet-serp-discovery), and
 * opening-night-poller.js (serp-discovery). Aggregator-sourced files
 * (show-score, bww-*, dtli, playbill-verdict, theatre-record, ...) never went
 * through that guard and are out of scope.
 *
 * A flagged candidate is a HEURISTIC hit, not proof — the embedded-year check
 * has no way to tell "wrong production" from "outlet republished/updated an
 * old URL with a new year in the path." Every candidate must be manually
 * verified (fetch the page, compare content/byline/date to the declared
 * production) before being written back as wrongProduction:true. Confirmed
 * false positives should be recorded with --clear so reruns don't re-surface
 * them as unverified.
 *
 * Usage:
 *   node scripts/audit-corpus-contamination.js [--json]
 *     Report candidates: suspect-source review files whose URL year fails
 *     isSerpUrlWrongProductionForOpeningNight against the show's current
 *     shows.json record, and that aren't already wrongProduction or cleared.
 *
 *   node scripts/audit-corpus-contamination.js --flag=<path> --note="..."
 *     After manual verification confirms contamination: write
 *     wrongProduction:true + wrongProductionNote to the file at <path>
 *     (absolute, or relative to the resolved review-texts dir).
 *
 *   node scripts/audit-corpus-contamination.js --clear=<path> --note="..."
 *     After manual verification confirms the file IS the declared
 *     production (heuristic false positive): write
 *     wrongProductionAuditCleared:true + a note, so the file stops
 *     surfacing as an unverified candidate.
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { isSerpUrlWrongProductionForOpeningNight } = require('./lib/opening-night-discovery');
const { shouldSkipWrongProductionAudit } = require('./lib/review-guards');
const { invalidateWrongProductionAutoClear } = require('./lib/review-write-guard');
// `source` values written by paths that historically used the -3y-grace
// isUrlYearOutsideWindow guard (see file header for the per-source mapping).
// Canonical set lives in lib/ (BRO-4101) — review-guards.js's namedNonReviewUrl
// rule and scripts/sweep-named-non-review-urls.js share this exact list.
const { SUSPECT_SOURCES } = require('./lib/unvetted-serp-sources');

const CANONICAL_REPO = '/Users/tompryor/Broadwayscore';

function loadShows() {
  const local = path.join(__dirname, '..', 'data', 'shows.json');
  const p = fs.existsSync(local) ? local : path.join(CANONICAL_REPO, 'data', 'shows.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Array.isArray(raw) ? raw : raw.shows;
}

/**
 * Scan the review-texts corpus for suspect-source files whose URL fails the
 * strict opening-night production check against the show's current record.
 *
 * @param {object} [opts]
 * @param {Map<string,object>} [opts.showsById] - defaults to loadShows() indexed by id
 * @param {string} [opts.reviewTextsDir] - defaults to resolveReviewTextsDir()
 * @returns {Array<object>} candidates, one per suspect review file
 */
function findCandidates({ showsById, reviewTextsDir } = {}) {
  const dir = reviewTextsDir || resolveReviewTextsDir();
  const byId = showsById || new Map(loadShows().map((s) => [s.id, s]));
  const showDirs = listShowDirs(dir);
  const candidates = [];

  for (const showId of showDirs) {
    const show = byId.get(showId);
    if (!show || !show.openingDate) continue;

    const showDir = path.join(dir, showId);
    let files;
    try {
      files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }

    for (const file of files) {
      const full = path.join(showDir, file);
      let review;
      try {
        review = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch {
        continue;
      }

      if (review.wrongProduction) continue;
      if (review.wrongProductionAuditCleared) continue;
      // Manually cleared/overridden by a human via one of the shared
      // breadcrumbs (or another setter) — surfacing it as an "unverified
      // candidate" here would send an operator straight into applyFlag()'s
      // guard throw for no reason.
      if (shouldSkipWrongProductionAudit(review)) continue;
      // Already excluded from scoring via the sibling wrongShow flag — a
      // different guard already caught this file (not this audit's job to
      // re-flag it under a different name).
      if (review.wrongShow) continue;
      if (!review.source || !SUSPECT_SOURCES.has(review.source)) continue;
      if (!review.url) continue;

      if (isSerpUrlWrongProductionForOpeningNight(review.url, show)) {
        candidates.push({
          showId,
          file,
          path: full,
          url: review.url,
          source: review.source,
          outletId: review.outletId || null,
          criticName: review.criticName || null,
          publishDate: review.publishDate || null,
          openingDate: show.openingDate,
        });
      }
    }
  }

  return candidates.sort((a, b) => a.showId.localeCompare(b.showId) || a.file.localeCompare(b.file));
}

function resolveTargetPath(target, reviewTextsDir) {
  if (path.isAbsolute(target) && fs.existsSync(target)) return target;
  const dir = reviewTextsDir || resolveReviewTextsDir();
  const joined = path.join(dir, target);
  if (fs.existsSync(joined)) return joined;
  if (fs.existsSync(target)) return path.resolve(target);
  throw new Error(`No such review file: ${target}`);
}

// Deliberately guards on the shared shouldSkipWrongProductionAudit predicate
// plus this script's OWN wrongProductionAuditCleared breadcrumb (applyClear,
// below) — but NOT a bare `review.wrongProduction === false` (unlike
// audit-sibling-title-misroute.js's isHumanCleared()). rebuild-all-reviews.js's
// dateless-revival/priorRuns-window auto-clears also write wrongProduction=
// false with none of the guard predicate's breadcrumbs — this audit exists
// specifically to catch contamination those auto-clears miss, so treating a
// bare false as untouchable would let a stale auto-clear block an operator's
// fresh, manually-verified --flag=. wrongProductionAuditCleared is different:
// it's only ever written by a human running THIS tool's own --clear on THIS
// file, so honoring it here stops a later --flag= on the same path from
// silently overwriting that decision.
function applyFlag(target, note) {
  const full = resolveTargetPath(target);
  const review = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (review.wrongProductionAuditCleared) {
    throw new Error(
      `Refusing to flag ${full}: already cleared via this audit's --clear (wrongProductionAuditCleared=true, ` +
      `note: ${review.wrongProductionAuditClearedNote || 'none'}). Investigate before overriding it directly.`
    );
  }
  if (shouldSkipWrongProductionAudit(review)) {
    const signals = [
      review.humanReviewedWrongProduction === false && 'humanReviewedWrongProduction=false',
      review.wrongProductionManualClear === true && 'wrongProductionManualClear=true',
      review.wrongProductionOverride === true && 'wrongProductionOverride=true',
      review.allowCrossMarket === true && 'allowCrossMarket=true',
    ].filter(Boolean).join(', ') || 'shouldSkipWrongProductionAudit signal';
    throw new Error(
      `Refusing to flag ${full}: manually cleared/overridden (${signals}). ` +
      `A human already made a decision on this file — investigate before overriding it directly.`
    );
  }
  review.wrongProduction = true;
  invalidateWrongProductionAutoClear(review);
  review.wrongProductionNote = note || `Audit (BRO-2271): SERP-discovered URL year mismatch, manually verified as wrong production`;
  fs.writeFileSync(full, JSON.stringify(review, null, 2) + '\n');
  return full;
}

function applyClear(target, note) {
  const full = resolveTargetPath(target);
  const review = JSON.parse(fs.readFileSync(full, 'utf8'));
  review.wrongProductionAuditCleared = true;
  review.wrongProductionAuditClearedNote = note || `Audit (BRO-2271): manually verified — correct production despite embedded-year mismatch`;
  review.wrongProductionAuditClearedAt = new Date().toISOString();
  fs.writeFileSync(full, JSON.stringify(review, null, 2) + '\n');
  return full;
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: node scripts/audit-corpus-contamination.js [--json]
       node scripts/audit-corpus-contamination.js --flag=<path> --note="..."
       node scripts/audit-corpus-contamination.js --clear=<path> --note="..."

Backward-looking audit for pre-BRO-736 SERP wrong-production contamination
on revivals/transfers. See file header for full context. Read-only unless
--flag or --clear is passed.`);
    process.exit(0);
  }

  const noteArg = argv.find((a) => a.startsWith('--note='));
  const note = noteArg ? noteArg.slice('--note='.length) : null;

  const flagArg = argv.find((a) => a.startsWith('--flag='));
  if (flagArg) {
    const full = applyFlag(flagArg.slice('--flag='.length), note);
    console.log(`Flagged wrongProduction: ${full}`);
    process.exit(0);
  }

  const clearArg = argv.find((a) => a.startsWith('--clear='));
  if (clearArg) {
    const full = applyClear(clearArg.slice('--clear='.length), note);
    console.log(`Cleared as verified-correct: ${full}`);
    process.exit(0);
  }

  const candidates = findCandidates();
  const asJson = argv.includes('--json');

  if (asJson) {
    console.log(JSON.stringify({ total: candidates.length, candidates }, null, 2));
    process.exit(0);
  }

  console.log(`pre-BRO-736 SERP contamination audit: ${candidates.length} unverified candidate(s)\n`);
  if (candidates.length === 0) {
    console.log('No unverified candidates. Corpus clean per current shows.json.');
    process.exit(0);
  }

  for (const c of candidates) {
    console.log(`${c.showId} :: ${c.file}`);
    console.log(`  source=${c.source} url=${c.url}`);
    console.log(`  outlet=${c.outletId} critic=${c.criticName} publishDate=${c.publishDate} openingDate=${c.openingDate}`);
    console.log(`  path=${c.path}`);
  }

  console.log(`\nEach candidate needs manual verification (fetch the URL, compare content to the`);
  console.log(`declared production) before action:`);
  console.log(`  confirmed contamination -> --flag=<path> --note="..."`);
  console.log(`  confirmed correct       -> --clear=<path> --note="..."`);
}

if (require.main === module) main();

module.exports = { SUSPECT_SOURCES, loadShows, findCandidates, applyFlag, applyClear, resolveTargetPath };
