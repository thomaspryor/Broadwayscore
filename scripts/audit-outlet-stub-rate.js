#!/usr/bin/env node
/**
 * Outlet stub-rate & invalid-content-rate monitor (card #100, generalized by
 * card #1244) — detects a broken article extractor automatically instead of
 * by accident.
 *
 * When an outlet redesigns its site, its article-extractor.js pattern can
 * silently stop matching in one of two shapes:
 *   - contentTier:'stub'    — extraction returns ~nothing (near-zero chars)
 *   - contentTier:'invalid' — extraction returns SOMETHING, just not real
 *                             article text (a cookie-consent wall, a 404
 *                             rendered as 200, boilerplate) — isGarbageContent()
 *                             in content-quality.js catches these
 * Both are the same underlying failure ("article-extractor.js is broken for
 * this outlet"); only the stub shape was watched until #1244. TheaterMania's
 * 2026 Bootstrap redesign (the stub shape) left 26 reviews stuck corpus-wide
 * and was only caught chasing one unrelated show (Bedlam's Othello; fixed
 * reactively in a8b8945d94).
 *
 * A healthy outlet has a low stub-tier rate overall (old pre-collection-era
 * stubs are normal and expected). A broken extractor instead produces a
 * SPIKE in the stub rate among reviews collected recently — that's the
 * redesign signature this script looks for, distinct from legacy debt.
 *
 * 'invalid' is 23x larger than 'stub' corpus-wide (17,449 vs 753 files,
 * checked 2026-08-11) and, unlike stub, includes outlets that are
 * CHRONICALLY near-100% invalid — paywalled or bot-blocked sites where the
 * extractor reliably lands on a cookie wall, not a newly-broken pattern. A
 * flat recent-rate threshold false-positived on 22 outlets in a corpus
 * probe, including major T1/T2 outlets (Variety, Deadline, Hollywood
 * Reporter, Daily Mail) that were already 30-75% invalid before the recent
 * window — cry-wolf noise, not a redesign signal. computeOutletInvalidRates()
 * additionally requires the recent rate to SPIKE over the outlet's own
 * pre-window baseline (see requireBaselineSpike in computeOutletTierRates),
 * which drops that probe's flagged set to 7 outlets showing an actual
 * before/after change.
 *
 * Modes:
 *   node scripts/audit-outlet-stub-rate.js            snapshot, writes
 *                                                      data/audit/outlet-stub-rates.json
 *                                                      and outlet-invalid-content-rates.json
 *   node scripts/audit-outlet-stub-rate.js --json      same, combined JSON to stdout
 *   node scripts/audit-outlet-stub-rate.js --check     CI-style: exit 1 (with
 *                                                      ::warning::/::error::)
 *                                                      if any outlet is flagged
 *                                                      in either tier
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

// invalid-tier tuning (card #1244) — same primary threshold shape as stub,
// plus a baseline-spike requirement (see computeOutletTierRates) to filter
// out outlets that are chronically invalid rather than newly broken.
const FLAG_RECENT_INVALID_RATE = 0.5; // >50%
const FLAG_MIN_RECENT_INVALID_COUNT = 3;
const MIN_BASELINE_FOR_SPIKE_CHECK = 5; // need this many pre-window records to trust a baseline rate
const MIN_BASELINE_SPIKE_DELTA = 0.3; // recent rate must exceed baseline rate by this much

/**
 * Walk a review-texts tree and return one flat record per review file, with
 * just the fields the stub-rate computation needs. Uses listShowDirs() so a
 * dangling symlink or stray file doesn't crash the scan (memory:
 * feedback_stray_symlink_crashes_pipeline.md).
 *
 * @param {string} reviewTextsDir - path to data/review-texts
 * @returns {Array<{showId: string, file: string, outletId: string, outlet: string|null, contentTier: string|null, contentTierReason: string|null, textFetchedAt: string|null}>}
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
        contentTierReason: data.contentTierReason || null,
        textFetchedAt: data.textFetchedAt || null,
      });
    }
  }
  return records;
}

/**
 * Pure aggregation: group review records by outletId and compute
 * contentTier-rate stats for an arbitrary tier ('stub' or 'invalid'),
 * flagging outlets whose RECENT tier rate spikes (the redesign signature)
 * rather than their all-time rate (which legitimately includes old
 * pre-collection-era debt or chronically-blocked outlets).
 *
 * @param {Array<{outletId: string, outlet?: string|null, contentTier?: string|null, textFetchedAt?: string|null}>} records
 * @param {object} [opts]
 * @param {string} [opts.tier] - contentTier value to match (default 'stub')
 * @param {number} [opts.nowMs] - reference "now" in epoch ms (defaults to Date.now())
 * @param {number} [opts.recentWindowMs] - recency window in ms (default 30 days)
 * @param {number} [opts.flagRecentTierRate] - recent tier-rate threshold to flag (default 0.5)
 * @param {number} [opts.flagMinRecentTierCount] - minimum recent tier-match count to flag (default 3)
 * @param {boolean} [opts.requireBaselineSpike] - also require recentTierRate to exceed the
 *   outlet's pre-window baseline rate by opts.minBaselineSpikeDelta, once the outlet has
 *   opts.minBaselineForSpikeCheck+ baseline records. Filters "chronically bad" outlets
 *   (stable high rate, no actual change) from "newly broken" outlets (default false)
 * @param {number} [opts.minBaselineForSpikeCheck] - baseline sample size needed to trust it (default 5)
 * @param {number} [opts.minBaselineSpikeDelta] - required (recentRate - baselineRate) to flag (default 0.3)
 * @returns {{outlets: Array<object>, flaggedOutletIds: string[]}}
 */
function computeOutletTierRates(records, opts = {}) {
  const tier = opts.tier ?? 'stub';
  const nowMs = opts.nowMs ?? Date.now();
  const recentWindowMs = opts.recentWindowMs ?? RECENT_WINDOW_MS;
  const flagRecentTierRate = opts.flagRecentTierRate ?? FLAG_RECENT_STUB_RATE;
  const flagMinRecentTierCount = opts.flagMinRecentTierCount ?? FLAG_MIN_RECENT_STUB_COUNT;
  const requireBaselineSpike = opts.requireBaselineSpike ?? false;
  const minBaselineForSpikeCheck = opts.minBaselineForSpikeCheck ?? MIN_BASELINE_FOR_SPIKE_CHECK;
  const minBaselineSpikeDelta = opts.minBaselineSpikeDelta ?? MIN_BASELINE_SPIKE_DELTA;

  const byOutlet = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || !r.outletId) continue;
    if (!byOutlet.has(r.outletId)) {
      byOutlet.set(r.outletId, { outletId: r.outletId, outlet: r.outlet || null, reviews: [], excludedReviews: [] });
    }
    const entry = byOutlet.get(r.outletId);
    if (excludeTierReasons.size > 0 && excludeTierReasons.has(r.contentTierReason)) {
      // Kept aside (not dropped) so the baseline trust check below can tell
      // "genuinely new/thin outlet" apart from "exclusion ate the baseline
      // sample" — see passesSpikeCheck.
      entry.excludedReviews.push(r);
    } else {
      entry.reviews.push(r);
    }
    // Prefer the first non-null display name seen, but keep filling in if the
    // group started with a null (some review files omit `outlet`).
    if (!entry.outlet && r.outlet) entry.outlet = r.outlet;
  }

  const outlets = [];
  for (const { outletId, outlet, reviews } of byOutlet.values()) {
    const total = reviews.length;
    const tierCount = reviews.filter((r) => r.contentTier === tier).length;
    const tierRate = total > 0 ? tierCount / total : 0;

    // A record is exactly one of: recent (within the window), future
    // (clock-skew timestamp beyond "now" — excluded from both buckets, since
    // it's neither current evidence nor historical baseline evidence), or
    // baseline (everything else: older than the window, or missing/
    // unparseable textFetchedAt — treated as "not recently fetched").
    const future = reviews.filter((r) => {
      if (!r.textFetchedAt) return false;
      const t = Date.parse(r.textFetchedAt);
      return !Number.isNaN(t) && nowMs - t < 0;
    });
    const recent = reviews.filter((r) => {
      if (!r.textFetchedAt) return false;
      const t = Date.parse(r.textFetchedAt);
      if (Number.isNaN(t)) return false;
      return nowMs - t <= recentWindowMs && nowMs - t >= 0;
    });
    const recentTotal = recent.length;
    const recentTierCount = recent.filter((r) => r.contentTier === tier).length;
    const recentTierRate = recentTotal > 0 ? recentTierCount / recentTotal : 0;

    const baselineTotal = total - recentTotal - future.length;
    const baselineTierCount = tierCount - recentTierCount - future.filter((r) => r.contentTier === tier).length;
    const baselineTierRate = baselineTotal > 0 ? baselineTierCount / baselineTotal : 0;

    const passesRateThreshold = recentTierRate > flagRecentTierRate && recentTierCount >= flagMinRecentTierCount;
    const passesSpikeCheck = !requireBaselineSpike
      || baselineTotal < minBaselineForSpikeCheck
      || (recentTierRate - baselineTierRate) >= minBaselineSpikeDelta;
    const flagged = passesRateThreshold && passesSpikeCheck;

    outlets.push({
      outletId,
      outlet: outlet || outletId,
      total,
      tierCount,
      tierRate: Number(tierRate.toFixed(4)),
      recentTotal,
      recentTierCount,
      recentTierRate: Number(recentTierRate.toFixed(4)),
      baselineTotal,
      baselineTierCount,
      baselineTierRate: Number(baselineTierRate.toFixed(4)),
      flagged,
    });
  }

  outlets.sort((a, b) => (b.flagged - a.flagged) || (b.recentTierRate - a.recentTierRate) || (b.recentTierCount - a.recentTierCount));

  const flaggedOutletIds = outlets.filter((o) => o.flagged).map((o) => o.outletId);
  return { outlets, flaggedOutletIds };
}

/**
 * contentTier:'stub' view over computeOutletTierRates — kept as a distinct
 * function (not a bare default-args call) so its output schema/back-compat
 * for existing callers (health-check.js, CLI, tests) never has to change
 * shape when the shared 'invalid' tier logic evolves.
 *
 * @param {Array<object>} records - see computeOutletTierRates
 * @param {object} [opts]
 * @param {number} [opts.nowMs]
 * @param {number} [opts.recentWindowMs]
 * @param {number} [opts.flagRecentStubRate] - default 0.5
 * @param {number} [opts.flagMinRecentStubCount] - default 3
 * @returns {{outlets: Array<object>, flaggedOutletIds: string[]}}
 */
function computeOutletStubRates(records, opts = {}) {
  const { outlets, flaggedOutletIds } = computeOutletTierRates(records, {
    nowMs: opts.nowMs,
    recentWindowMs: opts.recentWindowMs,
    tier: 'stub',
    requireBaselineSpike: false,
    flagRecentTierRate: opts.flagRecentStubRate ?? FLAG_RECENT_STUB_RATE,
    flagMinRecentTierCount: opts.flagMinRecentStubCount ?? FLAG_MIN_RECENT_STUB_COUNT,
  });
  return {
    outlets: outlets.map((o) => ({
      outletId: o.outletId,
      outlet: o.outlet,
      total: o.total,
      stubCount: o.tierCount,
      stubRate: o.tierRate,
      recentTotal: o.recentTotal,
      recentStubCount: o.recentTierCount,
      recentStubRate: o.recentTierRate,
      flagged: o.flagged,
    })),
    flaggedOutletIds,
  };
}

/**
 * contentTier:'invalid' view over computeOutletTierRates (card #1244).
 * Defaults requireBaselineSpike to true — see the module docstring for why
 * a flat rate threshold alone false-positives heavily on this tier.
 *
 * @param {Array<object>} records - see computeOutletTierRates
 * @param {object} [opts]
 * @param {number} [opts.nowMs]
 * @param {number} [opts.recentWindowMs]
 * @param {number} [opts.flagRecentInvalidRate] - default 0.5
 * @param {number} [opts.flagMinRecentInvalidCount] - default 3
 * @param {boolean} [opts.requireBaselineSpike] - default true
 * @param {number} [opts.minBaselineForSpikeCheck] - default 5
 * @param {number} [opts.minBaselineSpikeDelta] - default 0.3
 * @returns {{outlets: Array<object>, flaggedOutletIds: string[]}}
 */
function computeOutletInvalidRates(records, opts = {}) {
  const { outlets, flaggedOutletIds } = computeOutletTierRates(records, {
    nowMs: opts.nowMs,
    recentWindowMs: opts.recentWindowMs,
    tier: 'invalid',
    requireBaselineSpike: opts.requireBaselineSpike ?? true,
    minBaselineForSpikeCheck: opts.minBaselineForSpikeCheck ?? MIN_BASELINE_FOR_SPIKE_CHECK,
    minBaselineSpikeDelta: opts.minBaselineSpikeDelta ?? MIN_BASELINE_SPIKE_DELTA,
    flagRecentTierRate: opts.flagRecentInvalidRate ?? FLAG_RECENT_INVALID_RATE,
    flagMinRecentTierCount: opts.flagMinRecentInvalidCount ?? FLAG_MIN_RECENT_INVALID_COUNT,
  });
  return {
    outlets: outlets.map((o) => ({
      outletId: o.outletId,
      outlet: o.outlet,
      total: o.total,
      invalidCount: o.tierCount,
      invalidRate: o.tierRate,
      recentTotal: o.recentTotal,
      recentInvalidCount: o.recentTierCount,
      recentInvalidRate: o.recentTierRate,
      baselineTotal: o.baselineTotal,
      baselineInvalidCount: o.baselineTierCount,
      baselineInvalidRate: o.baselineTierRate,
      flagged: o.flagged,
    })),
    flaggedOutletIds,
  };
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
  const stub = computeOutletStubRates(records);
  const invalid = computeOutletInvalidRates(records);

  const stubSummary = {
    _meta: {
      generatedAt: new Date().toISOString(),
      totalReviews: records.length,
      totalOutlets: stub.outlets.length,
      flaggedCount: stub.flaggedOutletIds.length,
      recentWindowDays: RECENT_WINDOW_MS / (24 * 60 * 60 * 1000),
      flagThreshold: { recentStubRateOver: FLAG_RECENT_STUB_RATE, minRecentStubCount: FLAG_MIN_RECENT_STUB_COUNT },
    },
    flaggedOutletIds: stub.flaggedOutletIds,
    outlets: stub.outlets,
  };
  const invalidSummary = {
    _meta: {
      generatedAt: new Date().toISOString(),
      totalReviews: records.length,
      totalOutlets: invalid.outlets.length,
      flaggedCount: invalid.flaggedOutletIds.length,
      recentWindowDays: RECENT_WINDOW_MS / (24 * 60 * 60 * 1000),
      flagThreshold: {
        recentInvalidRateOver: FLAG_RECENT_INVALID_RATE,
        minRecentInvalidCount: FLAG_MIN_RECENT_INVALID_COUNT,
        requiresBaselineSpikeOver: MIN_BASELINE_SPIKE_DELTA,
      },
    },
    flaggedOutletIds: invalid.flaggedOutletIds,
    outlets: invalid.outlets,
  };

  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.writeFileSync(path.join(AUDIT_DIR, 'outlet-stub-rates.json'), JSON.stringify(stubSummary, null, 2) + '\n');
  fs.writeFileSync(path.join(AUDIT_DIR, 'outlet-invalid-content-rates.json'), JSON.stringify(invalidSummary, null, 2) + '\n');

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ stub: stubSummary, invalidContent: invalidSummary }, null, 2));
    return;
  }

  console.log(`=== Outlet Stub-Rate Audit (${stub.outlets.length} outlet(s), ${records.length} review(s)) ===\n`);
  if (stub.flaggedOutletIds.length === 0) {
    console.log('No outlets flagged — no recent stub-rate spikes detected.');
  } else {
    console.log(`::warning::${stub.flaggedOutletIds.length} outlet(s) show a broken-extractor signature (recent stub rate >${FLAG_RECENT_STUB_RATE * 100}%, ≥${FLAG_MIN_RECENT_STUB_COUNT} recent stubs):`);
    for (const o of stub.outlets.filter((x) => x.flagged)) {
      console.log(`  - ${o.outletId} (${o.outlet}): ${o.recentStubCount}/${o.recentTotal} recent stubs (${(o.recentStubRate * 100).toFixed(0)}%), ${o.stubCount}/${o.total} all-time`);
    }
    console.log('\nLikely a redesigned article-extractor.js pattern no longer matching. Compare against a known-good extraction and add a regression test (see tests/unit/theatermania-extractor.test.mjs for the pattern).');
  }
  console.log(`\nWritten to data/audit/outlet-stub-rates.json`);

  console.log(`\n=== Outlet Invalid-Content Rate Audit (${invalid.outlets.length} outlet(s), ${records.length} review(s)) ===\n`);
  if (invalid.flaggedOutletIds.length === 0) {
    console.log('No outlets flagged — no recent invalid-content spikes detected.');
  } else {
    console.log(`::warning::${invalid.flaggedOutletIds.length} outlet(s) show a broken-extractor signature (recent invalid-content rate >${FLAG_RECENT_INVALID_RATE * 100}%, ≥${FLAG_MIN_RECENT_INVALID_COUNT} recent, spiking ≥${MIN_BASELINE_SPIKE_DELTA * 100}pts over baseline):`);
    for (const o of invalid.outlets.filter((x) => x.flagged)) {
      console.log(`  - ${o.outletId} (${o.outlet}): ${o.recentInvalidCount}/${o.recentTotal} recent invalid (${(o.recentInvalidRate * 100).toFixed(0)}%) vs ${(o.baselineInvalidRate * 100).toFixed(0)}% baseline, ${o.invalidCount}/${o.total} all-time`);
    }
    console.log('\nCheck each flagged file\'s contentTierReason before assuming a broken extractor: this tier catches BOTH a redesigned article-extractor.js pattern (reason "No text content"/garbage boilerplate — a scraper fix) AND a wrongProduction/wrongShow classification spike (extractor is fine, wrong show matched — belongs with the wrongProduction FP sweep, not article-extractor.js). A high all-time invalid rate alone is also common for paywalled/bot-blocked outlets — this list is filtered to outlets whose rate genuinely SPIKED over their own baseline.');
  }
  console.log(`\nWritten to data/audit/outlet-invalid-content-rates.json`);

  if (process.argv.includes('--check') && (stub.flaggedOutletIds.length > 0 || invalid.flaggedOutletIds.length > 0)) {
    process.exitCode = 1;
  }
}

module.exports = {
  collectReviewRecords,
  computeOutletTierRates,
  computeOutletStubRates,
  computeOutletInvalidRates,
  RECENT_WINDOW_MS,
  FLAG_RECENT_STUB_RATE,
  FLAG_MIN_RECENT_STUB_COUNT,
  FLAG_RECENT_INVALID_RATE,
  FLAG_MIN_RECENT_INVALID_COUNT,
  MIN_BASELINE_FOR_SPIKE_CHECK,
  MIN_BASELINE_SPIKE_DELTA,
};

if (require.main === module) main();
