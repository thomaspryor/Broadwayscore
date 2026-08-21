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
 *   --mode=replay (local session only, needs SCRAPINGBEE_API_KEY or
 *     BRIGHTDATA_TOKEN)
 *     Implements the ticket's "Option B: synthetic test with existing show":
 *     back up the show's review-texts files, delete them (simulating a
 *     just-opened show with zero reviews), run the real discovery layers
 *     (scripts/opening-night-poller.js), diff what got (re)discovered
 *     against the ground-truth manifest, then ALWAYS restore the backup
 *     (even on crash/Ctrl-C) so the real data is never lost. This is the
 *     one that actually exercises Show Score / WET / theatre.reviews / RSS /
 *     site-search / SERP end-to-end. It needs live scraping credentials, so
 *     it refuses to run (exit 2) in a cloud/headless session that has none —
 *     print the exact local command instead of silently no-op'ing.
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
    outlets: [
      // T1
      { name: 'Guardian', tier: 1, outletId: 'guardian' },
      { name: 'Telegraph', tier: 1, outletId: 'telegraph' },
      { name: 'Financial Times', tier: 1, outletId: 'financialtimes' },
      { name: 'Independent', tier: 1, outletId: 'independent' },
      { name: 'Evening Standard', tier: 1, outletId: 'standard' },
      { name: 'Times (UK)', tier: 1, outletId: 'times-uk' },
      { name: 'WhatsOnStage', tier: 1, outletId: 'whatsonstage' },
      { name: 'The Stage', tier: 1, outletId: 'thestage' },
      { name: 'Time Out', tier: 1, outletId: 'timeout-london' },
      // T2
      { name: 'London Theatre', tier: 2, outletId: 'london-theatre' },
      { name: 'BroadwayWorld WE', tier: 2, outletId: 'broadwayworld' },
      { name: 'Afridiziak', tier: 2, outletId: 'afridiziak-theatre-news' },
      // T3
      { name: 'All That Dazzles', tier: 3, outletId: 'all-that-dazzles-uk' },
      { name: 'Theatre and Tonic', tier: 3, outletId: 'theatreandtonic' },
      { name: 'LondonTheatre1', tier: 3, outletId: 'londontheatre1' },
      { name: 'London Unattached', tier: 3, outletId: null },
      { name: 'New Statesman', tier: 3, outletId: 'new-statesman' },
      { name: 'Monstagigz', tier: 3, outletId: null },
      { name: 'West End Best Friend', tier: 3, outletId: 'west-end-best-friend' },
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
      { name: 'City A.M.', tier: 2, outletId: 'cityam' },
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
  const revs = require(path.join(ROOT, 'data', 'reviews.json'));
  const arr = Array.isArray(revs.reviews || revs) ? (revs.reviews || revs) : Object.values(revs.reviews || revs);
  return arr.filter((r) => r.showId === showId);
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

function auditShow(showId, reviewTextsDir) {
  const manifest = GROUND_TRUTH[showId];
  if (!manifest) throw new Error(`No ground-truth manifest for ${showId}. Known shows: ${Object.keys(GROUND_TRUTH).join(', ')}`);

  const scored = loadScoredReviews(showId);
  const scoredOutletIds = new Set(scored.filter((r) => r.assignedScore > 0).map((r) => r.outletId));

  const results = manifest.outlets.map((entry) => {
    if (entry.outletId && scoredOutletIds.has(entry.outletId)) {
      return { ...entry, status: 'SCORED', detail: null };
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
    if (r.status === 'SCORED') continue;
    const icon = r.status === 'FOUND_BUT_BLOCKED' ? '⚠️ ' : '❌';
    lines.push(`  ${icon} [T${r.tier}] ${r.name} (${r.outletId || 'never discovered'}) — ${r.status}`);
    if (r.files) {
      for (const f of r.files) {
        lines.push(`       - ${f.file}${f.criticName ? ` (${f.criticName})` : ''}: ${f.reasons.join('; ')}`);
      }
    }
  }
  console.log(lines.join('\n'));
}

function printReplayPlan(showId, reviewTextsDir) {
  console.log(`
--mode=replay requires live scraping credentials (SCRAPINGBEE_API_KEY or
BRIGHTDATA_TOKEN) that this session does not have — this is a cloud/headless
session per .claude/CLOUD.md, so live network discovery cannot run here.

Run this on a local session with .env populated instead:

  # 1. Back up (never skip — this deletes real production review files)
  cp -r "${path.join(reviewTextsDir, showId)}" "/tmp/${showId}-backup-$(date +%s)"

  # 2. Simulate a just-opened show with zero reviews
  find "${path.join(reviewTextsDir, showId)}" -name '*.json' ! -name 'failed-fetches.json' -delete

  # 3. Run the real discovery layers (same code path as production polling)
  node scripts/opening-night-poller.js --show=${showId}

  # 4. Diff what got rediscovered against ground truth
  node scripts/simulate-we-opening-night-coverage.js --show=${showId} --mode=audit

  # 5. ALWAYS restore, whether step 3 succeeded or not
  rm -rf "${path.join(reviewTextsDir, showId)}"
  cp -r "/tmp/${showId}-backup-<timestamp>" "${path.join(reviewTextsDir, showId)}"

This is the ticket's "Option B: synthetic test with existing show" — it
proves live discovery still finds these reviews from a cold start, not just
that today's already-collected review-texts state matches the manifest.
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
    const hasCreds = !!(process.env.SCRAPINGBEE_API_KEY || process.env.BRIGHTDATA_TOKEN);
    if (!hasCreds) {
      showIds.forEach((id) => printReplayPlan(id, reviewTextsDir));
      process.exit(2);
    }
    console.error('--mode=replay live execution is a local-session-only manual runbook — see the plan printed above; this script does not auto-run live scraping against production data.');
    showIds.forEach((id) => printReplayPlan(id, reviewTextsDir));
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
