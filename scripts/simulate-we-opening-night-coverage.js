#!/usr/bin/env node
/**
 * simulate-we-opening-night-coverage.js — BRO-591
 *
 * Previous opening-night simulations (simulate-opening-night.sh,
 * simulate-opening-night-full.sh) prove "does the pipeline run without
 * crashing" — they check dry-run output, HTTP-style pass/fail, file counts.
 * They do NOT prove "does the pipeline find the reviews that actually exist."
 * JPITV and Teeth n Smiles both showed 0% real coverage in earlier sessions
 * despite a prior "tested" claim (see BRO-591 issue body). This script closes
 * that gap: it checks discovered/scored coverage against a hand-built
 * ground-truth manifest of reviews that are known, from a manual Google
 * search at the time, to have been published for a real WE opening.
 *
 * Two modes:
 *
 *   --mode=audit (default, no network, no API keys, runs anywhere)
 *     For each ground-truth outlet: is it SCORED (counted in reviews.json),
 *     FOUND_BUT_BLOCKED (a review-texts file exists but a flag/contentTier
 *     keeps it out of reviews.json — the file-writer/rebuild pipeline
 *     "found" it but didn't count it), or NOT_FOUND (no file at all — a
 *     genuine discovery-layer gap)? Also reports EXTRA reviews found beyond
 *     the manifest (bonus T3/aggregator coverage). This is a coverage-drift
 *     regression check you can run in CI or any session, today, using
 *     whatever review-texts state is currently on disk.
 *
 *   --mode=replay (prints a runbook; never executes anything itself)
 *     Implements the ticket's "Option B: synthetic test with existing show":
 *     back up the show's review-texts files, delete them (simulating a
 *     just-opened show with zero reviews), run the real discovery layers
 *     (scripts/opening-night-poller.js), diff what got (re)discovered
 *     against the ground-truth manifest, then restore the backup (a `trap`
 *     in the printed runbook covers Ctrl-C/crash too) so the real data is
 *     never lost. This is the one that actually exercises Show Score / WET /
 *     theatre.reviews / RSS / site-search / SERP end-to-end — but it deletes
 *     real production review files, so this script only ever PRINTS the
 *     runbook (exit 2) for a human to run by hand, credentials or not; it
 *     never auto-executes live discovery itself. It also warns that both
 *     manifested shows opened months ago, so a replay today would exercise
 *     the poller's stale-show fallback path rather than a faithful Day-0 run
 *     — see the printed CAVEAT and the BRO-591 write-up.
 *
 * Usage:
 *   node scripts/simulate-we-opening-night-coverage.js --show=all
 *   node scripts/simulate-we-opening-night-coverage.js --show=john-proctor-is-the-villain-west-end-2026
 *   node scripts/simulate-we-opening-night-coverage.js --show=all --json=/tmp/coverage.json
 *   node scripts/simulate-we-opening-night-coverage.js --show=teeth-n-smiles-west-end-2026 --mode=replay
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { readEnvKeys } = require('./lib/load-env');
const { loadReviewsWithBlog } = require('./lib/load-reviews-with-blog');

const ROOT = path.join(__dirname, '..');

// ── Ground truth (BRO-591 issue body, manually gathered 2026-03-28 audit) ──
// outletId is the value observed in this show's review-texts filenames /
// reviews.json outletId — filled in from the real corpus so the audit does
// exact matching instead of fuzzy display-name guessing. `null` outletId
// means the outlet was never even discovered (no file exists under any name)
// as of the manifest's last verification date.
const GROUND_TRUTH = {
  'john-proctor-is-the-villain-west-end-2026': {
    label: 'John Proctor Is the Villain (Royal Court, opened 2026-03-26)',
    openingDate: '2026-03-26',
    // `critic` is the byline the issue body's 2026-03-28 manual audit named for
    // this outlet, where it gave one. It's a soft cross-check, not a match
    // requirement: SCORED still means "this outletId has a scored review", but
    // if NO scored review's criticName resembles the named critic, the report
    // flags criticMismatch — the outlet may be covered by a different piece
    // than the one originally audited (verified live: Theatre and Tonic's
    // scored review is bylined Emmie Newitt, not the manifest's "Ziwen").
    outlets: [
      // T1
      { name: 'Guardian', tier: 1, outletId: 'guardian', critic: 'Arifa Akbar' },
      { name: 'Telegraph', tier: 1, outletId: 'telegraph', critic: 'Claire Allfree' },
      { name: 'Financial Times', tier: 1, outletId: 'financialtimes', critic: 'Sarah Hemming' },
      { name: 'Independent', tier: 1, outletId: 'independent', critic: 'Alice Saville' },
      { name: 'Evening Standard', tier: 1, outletId: 'standard', critic: 'Nick Curtis' },
      { name: 'Times (UK)', tier: 1, outletId: 'times-uk', critic: 'Clive Davis' },
      { name: 'WhatsOnStage', tier: 1, outletId: 'whatsonstage', critic: 'Sarah Crompton' },
      { name: 'The Stage', tier: 1, outletId: 'thestage', critic: 'Sam Marlowe' },
      { name: 'Time Out', tier: 1, outletId: 'timeout-london', critic: 'Andrzej Lukowski' },
      // T2
      { name: 'London Theatre', tier: 2, outletId: 'london-theatre', critic: 'Marianka Swain' },
      { name: 'BroadwayWorld WE', tier: 2, outletId: 'broadwayworld', critic: 'Cindy Marcolina' },
      { name: 'Afridiziak', tier: 2, outletId: 'afridiziak-theatre-news', critic: 'Mark Arbouine' },
      // T3
      { name: 'All That Dazzles', tier: 3, outletId: 'all-that-dazzles-uk', critic: null },
      { name: 'Theatre and Tonic', tier: 3, outletId: 'theatreandtonic', critic: 'Ziwen' },
      { name: 'LondonTheatre1', tier: 3, outletId: 'londontheatre1', critic: 'Chris Omaweng' },
      { name: 'London Unattached', tier: 3, outletId: null, critic: 'Madeleine Morrow' },
      { name: 'New Statesman', tier: 3, outletId: 'new-statesman', critic: 'Emily Lawford' },
      { name: 'Monstagigz', tier: 3, outletId: null, critic: 'Neil Durham' },
      { name: 'West End Best Friend', tier: 3, outletId: 'west-end-best-friend', critic: 'Anna Nichols' },
    ],
  },
  'teeth-n-smiles-west-end-2026': {
    label: "Teeth 'n' Smiles (Duke of York's, opened 2026-03-25)",
    openingDate: '2026-03-25',
    // Issue body: "theatre.reviews roundup has 10 (Teeth only)" — this is the
    // floor, not the full published set (22 were eventually scored).
    outlets: [
      { name: 'Times (UK)', tier: 1, outletId: 'times-uk' },
      { name: 'WhatsOnStage', tier: 1, outletId: 'whatsonstage' },
      { name: 'London Theatre', tier: 2, outletId: 'london-theatre' },
      { name: 'Independent', tier: 1, outletId: 'independent' },
      { name: 'Time Out', tier: 1, outletId: 'timeout-london' },
      { name: 'Guardian', tier: 1, outletId: 'guardian' },
      { name: 'The Stage', tier: 1, outletId: 'thestage' },
      { name: 'Telegraph', tier: 1, outletId: 'telegraph' },
      { name: 'Evening Standard', tier: 1, outletId: 'standard' },
      { name: 'City A.M.', tier: 2, outletId: 'city-am' },
    ],
  },
};

// Success criteria from the issue body (single point-in-time check here,
// since the audit mode can only see whatever review-texts state currently
// exists on disk — it cannot rewind to "day 0"/"day 1" without --mode=replay,
// which needs live credentials. See header comment.)
const FINAL_TARGET_PCT = 0.9; // "Day 4: 18+ reviews (approaching ground truth)" ~= 90%+ of the manifest

function parseArgs(argv) {
  const get = (flag) => {
    const hit = argv.find((a) => a.startsWith(`--${flag}=`));
    return hit ? hit.slice(flag.length + 3) : null;
  };
  return {
    show: get('show') || 'all',
    mode: get('mode') || 'audit',
    json: get('json') || null,
  };
}

function loadScoredReviews(showId) {
  // Must go through the shared loader, not a raw reviews.json require(): shows
  // with blog-tier reviews (data/blog-reviews-for-scoring.json) are concatenated
  // in at build time (src/lib/data-core.ts) but don't live in reviews.json
  // itself — reading reviews.json alone would report a real, live-scored blog
  // review as a coverage gap.
  return loadReviewsWithBlog().filter((r) => r.showId === showId);
}

// An outlet can have more than one critic-bylined file for the same show
// (e.g. WhatsOnStage's Sarah Crompton wrote the JPITV review, but a stray
// Alun Hood file for a different show also matched the outletId prefix
// during discovery). Returning only the alphabetically-first match hid the
// real ground-truth critic's block reason behind an unrelated file's — this
// returns every match so the report can't silently pick the wrong one.
function findReviewTextFiles(reviewTextsDir, showId, outletId) {
  const dir = path.join(reviewTextsDir, showId);
  if (!outletId || !fs.existsSync(dir)) return [];
  const prefix = `${outletId}--`;
  return fs.readdirSync(dir)
    .filter((f) => f === `${outletId}.json` || f.startsWith(prefix))
    .map((f) => path.join(dir, f));
}

function classifyBlockedReason(data) {
  const reasons = [];
  if (data.wrongProduction) reasons.push(`wrongProduction${data.wrongProductionNote ? ` (${data.wrongProductionNote})` : ''}`);
  if (data.wrongShow) reasons.push(`wrongShow${data.wrongShowReason ? ` (${data.wrongShowReason})` : ''}`);
  if (data.contentTier === 'invalid') reasons.push(`contentTier=invalid${data.contentTierReason ? ` (${data.contentTierReason})` : ''}`);
  if (data.needsReview) reasons.push(`needsReview${data.needsReviewReason ? ` (${data.needsReviewReason})` : ''}`);
  if (!reasons.length) reasons.push('present in review-texts but not in reviews.json (unscored / rebuild pending)');
  return reasons;
}

// Loose match: does ANY word of `manifestCritic` appear as a substring of
// `actualCritic` (or vice versa), case-insensitively? Good enough to tell
// "Sarah Hemming" from "Emmie Newitt" without requiring exact-string equality
// (bylines get formatted differently across sources: "Sam Marlowe" vs "Marlowe, Sam").
function criticsLooselyMatch(manifestCritic, actualCritic) {
  if (!manifestCritic || !actualCritic) return true; // nothing to check against
  const norm = (s) => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
  const mWords = norm(manifestCritic);
  const aWords = norm(actualCritic);
  return mWords.some((w) => aWords.includes(w));
}

function auditShow(showId, reviewTextsDir) {
  const manifest = GROUND_TRUTH[showId];
  if (!manifest) throw new Error(`No ground-truth manifest for ${showId}. Known shows: ${Object.keys(GROUND_TRUTH).join(', ')}`);

  const scored = loadScoredReviews(showId);
  const scoredOutletIds = new Set(scored.filter((r) => r.assignedScore > 0).map((r) => r.outletId));

  const results = manifest.outlets.map((entry) => {
    if (entry.outletId && scoredOutletIds.has(entry.outletId)) {
      const scoredForOutlet = scored.filter((r) => r.assignedScore > 0 && r.outletId === entry.outletId);
      const criticMatch = scoredForOutlet.some((r) => criticsLooselyMatch(entry.critic, r.criticName));
      const criticMismatch = entry.critic && !criticMatch;
      return {
        ...entry,
        status: 'SCORED',
        detail: criticMismatch
          ? [`criticMismatch: manifest names "${entry.critic}", scored review(s) bylined ${scoredForOutlet.map((r) => `"${r.criticName || 'unknown'}"`).join(', ')} — outlet is covered, but possibly not by the originally-audited piece`]
          : null,
        criticMismatch: !!criticMismatch,
      };
    }
    const filePaths = findReviewTextFiles(reviewTextsDir, showId, entry.outletId);
    if (filePaths.length) {
      const perFile = filePaths.map((filePath) => {
        let data = {};
        try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { /* leave empty */ }
        return {
          file: path.relative(ROOT, filePath),
          criticName: data.criticName || null,
          reasons: classifyBlockedReason(data),
        };
      });
      return { ...entry, status: 'FOUND_BUT_BLOCKED', detail: perFile.flatMap((f) => f.reasons), files: perFile };
    }
    return { ...entry, status: 'NOT_FOUND', detail: null };
  });

  const extra = scored
    .filter((r) => r.assignedScore > 0 && !manifest.outlets.some((e) => e.outletId === r.outletId))
    .map((r) => ({ outlet: r.outlet, outletId: r.outletId, tier: r.tier || null, score: r.assignedScore }));

  const scoredCount = results.filter((r) => r.status === 'SCORED').length;
  const blockedCount = results.filter((r) => r.status === 'FOUND_BUT_BLOCKED').length;
  const notFoundCount = results.filter((r) => r.status === 'NOT_FOUND').length;
  const pct = results.length ? scoredCount / results.length : 0;

  return {
    showId,
    label: manifest.label,
    openingDate: manifest.openingDate,
    manifestSize: results.length,
    scoredCount,
    blockedCount,
    notFoundCount,
    coveragePct: Math.round(pct * 1000) / 10,
    meetsTarget: pct >= FINAL_TARGET_PCT,
    results,
    extraReviewsFound: extra.length,
    extra,
    totalScoredInReviewsJson: scored.filter((r) => r.assignedScore > 0).length,
  };
}

function printReport(report) {
  const lines = [];
  lines.push(`\n=== ${report.label} ===`);
  lines.push(`showId: ${report.showId}  opened: ${report.openingDate}`);
  lines.push(`Ground truth: ${report.manifestSize} outlets  |  SCORED: ${report.scoredCount}  FOUND_BUT_BLOCKED: ${report.blockedCount}  NOT_FOUND: ${report.notFoundCount}`);
  lines.push(`Coverage vs ground truth: ${report.coveragePct}%  (target ${FINAL_TARGET_PCT * 100}%+)  ${report.meetsTarget ? 'PASS' : 'FAIL'}`);
  lines.push(`Total scored in reviews.json (incl. non-manifest T3/bonus): ${report.totalScoredInReviewsJson} (+${report.extraReviewsFound} beyond manifest)`);
  for (const r of report.results) {
    if (r.status === 'SCORED' && !r.criticMismatch) continue;
    const icon = r.status === 'SCORED' ? 'ℹ️ ' : r.status === 'FOUND_BUT_BLOCKED' ? '⚠️ ' : '❌';
    lines.push(`  ${icon} [T${r.tier}] ${r.name} (${r.outletId || 'never discovered'}) — ${r.status}`);
    if (r.status === 'SCORED' && r.detail) lines.push(`       ${r.detail.join('; ')}`);
    if (r.files) {
      for (const f of r.files) {
        lines.push(`       - ${f.file}${f.criticName ? ` (${f.criticName})` : ''}: ${f.reasons.join('; ')}`);
      }
    }
  }
  console.log(lines.join('\n'));
}

function printReplayPlan(showId, reviewTextsDir, hasCreds) {
  const showDir = path.join(reviewTextsDir, showId);
  console.log(`
--mode=replay never auto-executes live discovery against production data —
it only prints this runbook, credentials or not. Run these steps BY HAND, one
at a time, watching each complete:${hasCreds ? ' (credentials ARE present in this session — see the staleness caveat below before running it anyway.)' : ' this session has no SCRAPINGBEE_API_KEY/BRIGHTDATA_TOKEN in .env, so it could not run live discovery even in --apply mode if one existed.'}

  # 0. Back up FIRST, with nothing destructive armed yet (never skip this step)
  BACKUP="/tmp/${showId}-backup-\$(date +%s)"
  cp -r "${showDir}" "\$BACKUP"

  # 1. ONLY once the backup above finished, arm a restore-on-exit trap — it
  #    checks the backup actually exists before touching the real directory,
  #    so an interrupt before step 0 finishes does nothing destructive at all
  #    (setting the trap before the backup existed would delete the real data
  #    on an early Ctrl-C with nothing to restore from — verified in review).
  trap '[ -d "\$BACKUP" ] && { rm -rf "${showDir}"; cp -r "\$BACKUP" "${showDir}"; echo "restored from \$BACKUP"; } || echo "no backup at \$BACKUP — nothing restored, real directory left untouched"' EXIT

  # 2. Simulate a just-opened show with zero reviews
  find "${showDir}" -name '*.json' ! -name 'failed-fetches.json' -delete

  # 3. Run the real discovery layers (same code path as production polling)
  node scripts/opening-night-poller.js --show=${showId}

  # 4. Diff what got rediscovered against ground truth
  node scripts/simulate-we-opening-night-coverage.js --show=${showId} --mode=audit

  # 5. Restore happens automatically via the trap on exit (success or failure).
  #    Only clear it once you've confirmed the restore is what you want:
  #    trap - EXIT

This is the ticket's "Option B: synthetic test with existing show" — it
proves live discovery still finds these reviews from a cold start, not just
that today's already-collected review-texts state matches the manifest.

CAVEAT even with credentials: ${showId} opened months ago. The poller's
discovery layers gate behavior on days-since-opening (see
lib/opening-window-backoff.js, lib/serp-burst-caps.js), so running this today
exercises the stale-show fallback path, not a faithful Day-0 opening-night
run — see the "Why replay mode wasn't executed" section of the BRO-591
write-up. Option A (a show that is ACTUALLY in its opening window right now)
is the faithful test; abigails-party-west-end-2026 (opened 2026-08-19) is
one such candidate as of this writing.
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const reviewTextsDir = resolveReviewTextsDir();
  console.log(`review-texts dir: ${reviewTextsDir}${fs.existsSync(reviewTextsDir) ? '' : ' (MISSING)'}`);

  const showIds = args.show === 'all' ? Object.keys(GROUND_TRUTH) : [args.show];
  for (const id of showIds) {
    if (!GROUND_TRUTH[id]) {
      console.error(`Unknown show "${id}". Known: ${Object.keys(GROUND_TRUTH).join(', ')}, or --show=all`);
      process.exit(1);
    }
  }

  if (args.mode === 'replay') {
    // Match the codebase convention (see linear-client.js, browser-recovery-helpers.js):
    // read .env directly rather than raw process.env, since launchd/headless
    // sessions don't inherit a shell environment that sourced .env.
    const envKeys = readEnvKeys(['SCRAPINGBEE_API_KEY', 'BRIGHTDATA_TOKEN']);
    const hasCreds = !!(process.env.SCRAPINGBEE_API_KEY || envKeys.SCRAPINGBEE_API_KEY
      || process.env.BRIGHTDATA_TOKEN || envKeys.BRIGHTDATA_TOKEN);
    console.error('--mode=replay is a manual runbook, not an auto-executed action — see the plan below.');
    showIds.forEach((id) => printReplayPlan(id, reviewTextsDir, hasCreds));
    process.exit(2);
  }

  const reports = showIds.map((id) => auditShow(id, reviewTextsDir));
  reports.forEach(printReport);

  const allPass = reports.every((r) => r.meetsTarget);
  console.log(`\n${allPass ? '✅ All shows meet' : '❌ Not all shows meet'} the ${FINAL_TARGET_PCT * 100}% ground-truth coverage target.`);

  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2));
    console.log(`Wrote JSON report: ${args.json}`);
  }

  process.exit(allPass ? 0 : 1);
}

if (require.main === module) main();

module.exports = { GROUND_TRUTH, auditShow, classifyBlockedReason, FINAL_TARGET_PCT };
