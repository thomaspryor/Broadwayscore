#!/usr/bin/env node
/**
 * Outlet stub-rate monitor (card #100) — detects a broken article extractor
 * automatically instead of by accident.
 *
 * When an outlet redesigns its site, its article-extractor.js pattern can
 * silently stop matching: extractArticleTextFromUrl returns 0 chars, the
 * review is saved as contentTier:stub, and it never scores or reaches
 * reviews.json. Nothing alerted on this — TheaterMania's 2026 Bootstrap
 * redesign left 26 reviews stuck as stubs corpus-wide and was only caught
 * chasing one unrelated show (Bedlam's Othello; fixed reactively in
 * a8b8945d94).
 *
 * A healthy outlet has a low stub-tier rate overall (old pre-collection-era
 * stubs are normal and expected). A broken extractor instead produces a
 * SPIKE in the stub rate among reviews collected recently — that's the
 * redesign signature this script looks for, distinct from legacy debt.
 *
 * Modes:
 *   node scripts/audit-outlet-stub-rate.js            snapshot, writes
 *                                                      data/audit/outlet-stub-rates.json
 *   node scripts/audit-outlet-stub-rate.js --json      same, JSON to stdout
 *   node scripts/audit-outlet-stub-rate.js --check     CI-style: exit 1 (with
 *                                                      ::warning::/::error::)
 *                                                      if any outlet is flagged
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { hasHelpFlag } = require('./lib/cli-help.js');

const DATA_DIR = path.join(process.env.BSC_DATA_ROOT || path.join(__dirname, '..'), 'data');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');
// CI checks the private repo out into data/review-texts (checkout-review-texts
// action); locally it's a separate clone at ~/broadway-review-texts, NOT a
// symlink (memory: feedback_review_texts_not_symlink.md — the repo copy under
// data/review-texts is a plain gitignored directory, usually empty/stale
// locally). REVIEW_TEXTS_DIR always wins when set; otherwise prefer the
// data/review-texts copy if it's actually populated (CI), else fall back to
// the home-directory clone (local runs), matching audit-review-url-clusters.js.
const CI_REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const HOME_REVIEW_TEXTS_DIR = path.join(os.homedir(), 'broadway-review-texts');
function resolveReviewTextsDir() {
  if (process.env.REVIEW_TEXTS_DIR) return process.env.REVIEW_TEXTS_DIR;
  if (fs.existsSync(CI_REVIEW_TEXTS_DIR) && fs.readdirSync(CI_REVIEW_TEXTS_DIR).length > 0) {
    return CI_REVIEW_TEXTS_DIR;
  }
  return HOME_REVIEW_TEXTS_DIR;
}
const REVIEW_TEXTS_DIR = resolveReviewTextsDir();

const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const FLAG_RECENT_STUB_RATE = 0.5; // >50%
const FLAG_MIN_RECENT_STUB_COUNT = 3; // a redesign signature, not noise

/**
 * Walk a review-texts tree and return one flat record per review file, with
 * just the fields the stub-rate computation needs. Uses listShowDirs() so a
 * dangling symlink or stray file doesn't crash the scan (memory:
 * feedback_stray_symlink_crashes_pipeline.md).
 *
 * @param {string} reviewTextsDir - path to data/review-texts
 * @returns {Array<{showId: string, file: string, outletId: string, outlet: string|null, contentTier: string|null, textFetchedAt: string|null}>}
 */
function collectReviewRecords(reviewTextsDir) {
  const records = [];
  for (const showId of listShowDirs(reviewTextsDir)) {
    // `_`-prefixed dirs (_pending, _superseded-misattributed, ...) are
    // sentinel/staging directories, not real shows.
    if (showId.startsWith('_')) continue;
    const showDir = path.join(reviewTextsDir, showId);
    let files;
    try {
      files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      const filePath = path.join(showDir, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        continue;
      }
      if (!data || typeof data !== 'object') continue;
      const outletId = data.outletId || null;
      if (!outletId) continue; // can't group without one
      // Corpus check (2026-08-11, ship-check): 84% of ALL stub-tier files
      // corpus-wide lack textFetchedAt — this is expected, not a detector
      // gap. contentTier:'stub' is also set by discovery scripts as a
      // pre-fetch placeholder (create-stubs-from-reviews-json.js,
      // discover-outlet-reviews-serp.js, etc.) before any fetch attempt, so
      // most timestamp-less stubs are legitimate "not yet collected" —
      // correctly excluded from the recent window. A genuine extraction
      // failure (successful HTTP fetch, broken CSS selector, near-empty
      // result) DOES reach collect-review-texts.js's updateReviewJson(),
      // which sets textFetchedAt unconditionally except when protecting
      // existing non-empty fullText from an empty overwrite (review-write-
      // guard.js:shouldSkipPollerUpdate) — that guard never fires for a
      // fresh file with no prior fullText, so real broken-extractor hits
      // ARE timestamped and DO count as recent.
      records.push({
        showId,
        file,
        outletId,
        outlet: data.outlet || null,
        contentTier: data.contentTier || null,
        textFetchedAt: data.textFetchedAt || null,
      });
    }
  }
  return records;
}

/**
 * Pure aggregation: group review records by outletId and compute stub-rate
 * stats, flagging outlets whose RECENT stub rate spikes (the redesign
 * signature) rather than their all-time rate (which legitimately includes
 * old pre-collection-era stubs).
 *
 * @param {Array<{outletId: string, outlet?: string|null, contentTier?: string|null, textFetchedAt?: string|null}>} records
 * @param {object} [opts]
 * @param {number} [opts.nowMs] - reference "now" in epoch ms (defaults to Date.now())
 * @param {number} [opts.recentWindowMs] - recency window in ms (default 30 days)
 * @param {number} [opts.flagRecentStubRate] - recent stub-rate threshold to flag (default 0.5)
 * @param {number} [opts.flagMinRecentStubCount] - minimum recent stub count to flag (default 3)
 * @returns {{outlets: Array<object>, flaggedOutletIds: string[]}}
 */
function computeOutletStubRates(records, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const recentWindowMs = opts.recentWindowMs ?? RECENT_WINDOW_MS;
  const flagRecentStubRate = opts.flagRecentStubRate ?? FLAG_RECENT_STUB_RATE;
  const flagMinRecentStubCount = opts.flagMinRecentStubCount ?? FLAG_MIN_RECENT_STUB_COUNT;

  const byOutlet = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || !r.outletId) continue;
    if (!byOutlet.has(r.outletId)) {
      byOutlet.set(r.outletId, { outletId: r.outletId, outlet: r.outlet || null, reviews: [] });
    }
    const entry = byOutlet.get(r.outletId);
    entry.reviews.push(r);
    // Prefer the first non-null display name seen, but keep filling in if the
    // group started with a null (some review files omit `outlet`).
    if (!entry.outlet && r.outlet) entry.outlet = r.outlet;
  }

  const outlets = [];
  for (const { outletId, outlet, reviews } of byOutlet.values()) {
    const total = reviews.length;
    const stubs = reviews.filter((r) => r.contentTier === 'stub');
    const stubCount = stubs.length;
    const stubRate = total > 0 ? stubCount / total : 0;

    const recent = reviews.filter((r) => {
      if (!r.textFetchedAt) return false;
      const t = Date.parse(r.textFetchedAt);
      if (Number.isNaN(t)) return false;
      return nowMs - t <= recentWindowMs && nowMs - t >= 0;
    });
    const recentTotal = recent.length;
    const recentStubCount = recent.filter((r) => r.contentTier === 'stub').length;
    const recentStubRate = recentTotal > 0 ? recentStubCount / recentTotal : 0;

    const flagged = recentStubRate > flagRecentStubRate && recentStubCount >= flagMinRecentStubCount;

    outlets.push({
      outletId,
      outlet: outlet || outletId,
      total,
      stubCount,
      stubRate: Number(stubRate.toFixed(4)),
      recentTotal,
      recentStubCount,
      recentStubRate: Number(recentStubRate.toFixed(4)),
      flagged,
    });
  }

  outlets.sort((a, b) => (b.flagged - a.flagged) || (b.recentStubRate - a.recentStubRate) || (b.recentStubCount - a.recentStubCount));

  const flaggedOutletIds = outlets.filter((o) => o.flagged).map((o) => o.outletId);
  return { outlets, flaggedOutletIds };
}

function main() {
  if (hasHelpFlag(process.argv)) {
    console.log('Usage: node scripts/audit-outlet-stub-rate.js [--json] [--check]');
    return;
  }

  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.log('review-texts not checked out (private repo) — skipping.');
    return;
  }

  const records = collectReviewRecords(REVIEW_TEXTS_DIR);
  const { outlets, flaggedOutletIds } = computeOutletStubRates(records);

  const summary = {
    _meta: {
      generatedAt: new Date().toISOString(),
      totalReviews: records.length,
      totalOutlets: outlets.length,
      flaggedCount: flaggedOutletIds.length,
      recentWindowDays: RECENT_WINDOW_MS / (24 * 60 * 60 * 1000),
      flagThreshold: { recentStubRateOver: FLAG_RECENT_STUB_RATE, minRecentStubCount: FLAG_MIN_RECENT_STUB_COUNT },
    },
    flaggedOutletIds,
    outlets,
  };

  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.writeFileSync(path.join(AUDIT_DIR, 'outlet-stub-rates.json'), JSON.stringify(summary, null, 2) + '\n');

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`=== Outlet Stub-Rate Audit (${outlets.length} outlet(s), ${records.length} review(s)) ===\n`);
  if (flaggedOutletIds.length === 0) {
    console.log('No outlets flagged — no recent stub-rate spikes detected.');
  } else {
    console.log(`::warning::${flaggedOutletIds.length} outlet(s) show a broken-extractor signature (recent stub rate >${FLAG_RECENT_STUB_RATE * 100}%, ≥${FLAG_MIN_RECENT_STUB_COUNT} recent stubs):`);
    for (const o of outlets.filter((x) => x.flagged)) {
      console.log(`  - ${o.outletId} (${o.outlet}): ${o.recentStubCount}/${o.recentTotal} recent stubs (${(o.recentStubRate * 100).toFixed(0)}%), ${o.stubCount}/${o.total} all-time`);
    }
    console.log('\nLikely a redesigned article-extractor.js pattern no longer matching. Compare against a known-good extraction and add a regression test (see tests/unit/theatermania-extractor.test.mjs for the pattern).');
  }
  console.log(`\nWritten to data/audit/outlet-stub-rates.json`);

  if (process.argv.includes('--check') && flaggedOutletIds.length > 0) {
    process.exitCode = 1;
  }
}

module.exports = {
  collectReviewRecords,
  computeOutletStubRates,
  RECENT_WINDOW_MS,
  FLAG_RECENT_STUB_RATE,
  FLAG_MIN_RECENT_STUB_COUNT,
};

if (require.main === module) main();
