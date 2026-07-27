#!/usr/bin/env node
/**
 * monitor-outlet-recency.js — flags T1/T2 outlets that have gone silent
 * beyond their own cadence.
 *
 * Root cause this closes (card #582): outlet-cadence.js's market-pulse-aware
 * classification already runs weekly inside audit-critic-coverage.js, but its
 * persistent state file (data/audit/outlet-heartbeat-state.json) was never
 * added to that workflow's commit step — so the "2 consecutive red weeks"
 * streak reset to zero every run and could never cross the alert threshold.
 * NY Post (silent since 2026-04-27) and Hollywood Reporter (silent since
 * 2026-04-15) went 3 months undetected as a result. This script is the
 * standalone, independently-runnable + testable surface for that same
 * cadence logic, and audit-critic-coverage.yml now also commits the
 * heartbeat state so the existing 2-week alert can actually fire.
 *
 * Usage:
 *   node scripts/monitor-outlet-recency.js               # print flagged outlets, exit 1 if any
 *   node scripts/monitor-outlet-recency.js --dry-run      # print only, always exit 0
 *   node scripts/monitor-outlet-recency.js --json         # machine-readable output
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { buildCadenceReport } = require('./lib/outlet-cadence');

const REPO_ROOT = path.resolve(__dirname, '..');

function resolveDataFile(relPath) {
  const worktreePath = path.join(REPO_ROOT, relPath);
  if (fs.existsSync(worktreePath)) return worktreePath;
  const mainPath = path.join('/Users/tompryor/Broadwayscore', relPath);
  if (fs.existsSync(mainPath)) return mainPath;
  return worktreePath;
}

function marketOfCategory(cat) {
  if (cat === 'west-end' || cat === 'off-west-end') return 'west-end';
  if (cat === 'off-broadway') return 'off-broadway';
  if (cat === 'broadway') return 'broadway';
  return null;
}

/**
 * Pure: given reviews.json rows + outlet registry + a showId->category map,
 * return the red (silent-beyond-cadence) T1/T2 outlet×market rows.
 * Exported so tests can exercise it against a small fixture without
 * touching the live corpus.
 */
function getFlaggedOutlets(reviews, outlets, showCategoryById, opts = {}) {
  const marketOf = (showId) => marketOfCategory(showCategoryById[showId]);
  const rows = buildCadenceReport(reviews, outlets, { marketOf, maxTier: 2, ...opts });
  return rows.filter((r) => r.status === 'red').sort((a, b) => b.silentDays - a.silentDays);
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const jsonOut = args.includes('--json');

  const reviewsData = JSON.parse(fs.readFileSync(resolveDataFile('data/reviews.json'), 'utf8'));
  const outletsData = JSON.parse(fs.readFileSync(resolveDataFile('data/outlet-registry.json'), 'utf8'));
  const showsData = JSON.parse(fs.readFileSync(resolveDataFile('data/shows.json'), 'utf8'));

  const reviews = reviewsData.reviews || reviewsData;
  const outlets = outletsData.outlets || outletsData;
  const shows = showsData.shows || showsData;

  const showCategoryById = {};
  for (const s of shows) if (s.id) showCategoryById[s.id] = s.category;

  const flagged = getFlaggedOutlets(reviews, outlets, showCategoryById);

  if (jsonOut) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), flagged }, null, 2));
  } else {
    console.error(`=== Outlet recency monitor (${flagged.length} T1/T2 outlet×market rows silent beyond cadence) ===`);
    for (const r of flagged) {
      console.error(`  RED  ${r.outletId} / ${r.market}  silent ${r.silentDays}d (threshold ${r.thresholdDays}d, median gap ${r.medianGapDays}d, last review ${r.lastReviewDate})`);
    }
    if (!flagged.length) console.error('  (none)');
  }

  if (dryRun) process.exit(0);
  process.exit(flagged.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { getFlaggedOutlets, marketOfCategory };
