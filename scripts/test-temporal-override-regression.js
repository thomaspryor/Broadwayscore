#!/usr/bin/env node
/**
 * test-temporal-override-regression.js
 *
 * Regression fixture for applyTemporalOverrides — the 2026-04-14 Giant incident.
 *
 * A session edited applyTemporalOverrides to "trust high-confidence LLM
 * wrongProduction flags near opening." Unit tests in test-opening-night-fixes.js
 * were updated to match and all 276 passed. The change merged. Only post-merge
 * real-data verification revealed 183 legitimate T1 reviews across 46 flagship
 * shows (Hamilton, Giant, Hadestown, Phantom, Lion King, Book of Mormon) would
 * have been excluded — because the LLM has ~15% false-positive rate at high
 * confidence on opening-week reviews. The "bug" was a safety net.
 *
 * This fixture does what unit tests cannot: runs the real
 * applyTemporalOverrides against real opening-week reviews from real flagship
 * shows and asserts that the number of high-confidence wrongProduction flags
 * that SURVIVE the temporal override stays within a tolerance band. If that
 * number jumps (e.g., override removed for high-confidence), the test fails.
 *
 * Run:
 *   node scripts/test-temporal-override-regression.js
 *
 * Exit: 0 on pass, 1 on fail.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { applyTemporalOverrides } = require('./lib/review-guards');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const SHOWS_FILE = path.join(DATA_DIR, 'shows.json');

// Seed fixtures: always-included shows we care about by historical relevance.
// Augmented at runtime with "any Broadway show that is open/previews AND has
// opened in the last 5 years AND has ≥5 scored reviews" so the regression
// test automatically picks up new flagships as they open, and doesn't rot
// as shows close.
const SEED_FLAGSHIPS = [
  'giant-2026',
  'hamilton-2015',
  'hadestown-2019',
  'the-phantom-of-the-opera-1988',
  'the-lion-king-1997',
  'the-book-of-mormon-2011',
  'wicked-2003',
  'angels-in-america-2018',
  'sweeney-todd-2023',
  'into-the-woods-2022',
];

function buildFlagshipList(showsById) {
  const ids = new Set(SEED_FLAGSHIPS);
  const now = Date.now();
  const FIVE_YEARS_MS = 5 * 365 * 86400 * 1000;
  for (const show of showsById.values()) {
    if (show.category !== 'broadway') continue;
    if (show.status !== 'open' && show.status !== 'previews') continue;
    if (!show.openingDate) continue;
    const opened = new Date(show.openingDate).getTime();
    if (isNaN(opened)) continue;
    if (now - opened > FIVE_YEARS_MS) continue;
    ids.add(show.id);
  }
  return [...ids];
}

// Tolerance band: the number of reviews where temporal override DOES NOT
// downgrade a 'high' confidence wrongProduction flag. Under the current
// (correct) logic, this is 0 — the override always downgrades 'high' within
// 30 days. Under the reverted-Giant-bad-fix logic, this would be ~9+ just
// on flagship shows alone. A single survivor on a flagship show = regression.
const MAX_ALLOWED_SURVIVORS = 0;

// Tolerance band for "all eligible temporal cases get downgraded". Under
// correct logic this equals the count of eligible reviews.
function isEligible(review, show) {
  if (!show || !show.openingDate) return false;
  if (!review.publishDate) return false;
  if (!review.contentVerification) return false;
  const cv = review.contentVerification;
  if (cv.wrongProduction !== true) return false;
  if (cv.confidence !== 'high') return false;
  // Skip already-cleared cases (manual review)
  if (review.wrongProductionManualClear === true) return false;
  if (review.humanReviewedWrongProduction === false) return false;
  if (review.wrongProductionOverride === true) return false;
  // Must be within 30 days
  const opening = new Date(show.openingDate);
  const publish = new Date(review.publishDate);
  if (isNaN(opening.getTime()) || isNaN(publish.getTime())) return false;
  const daysDiff = Math.abs((publish.getTime() - opening.getTime()) / 86400000);
  return daysDiff <= 30;
}

function loadShows() {
  if (!fs.existsSync(SHOWS_FILE)) {
    throw new Error(`shows.json not found at ${SHOWS_FILE}`);
  }
  const raw = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  const arr = Array.isArray(raw) ? raw : raw.shows || [];
  const byId = new Map();
  for (const s of arr) byId.set(s.id, s);
  return byId;
}

// Synthetic fixtures — guarantee the test always has SOMETHING to check, even when
// real data has been fully curated. Shape matches a real review-text file's cv block.
const SYNTHETIC_FIXTURES = [
  {
    __file: 'SYNTHETIC:giant-opening-night-timeout.json',
    __show: { id: 'giant-2026-fixture', openingDate: '2026-03-23', category: 'broadway' },
    outletId: 'timeout',
    outlet: 'Time Out',
    criticName: 'Synthetic Critic',
    publishDate: '2026-03-23',
    contentVerification: { wrongProduction: true, confidence: 'high', isFilmTv: false },
  },
  {
    __file: 'SYNTHETIC:hadestown-opening-night-vulture.json',
    __show: { id: 'hadestown-2019-fixture', openingDate: '2019-04-17', category: 'broadway' },
    outletId: 'vulture',
    outlet: 'Vulture',
    criticName: 'Synthetic Critic',
    publishDate: '2019-04-18',
    contentVerification: { wrongProduction: true, confidence: 'high', isFilmTv: false },
  },
];

function collectFlagshipReviews(showsById, flagshipShows) {
  const reviews = [];
  for (const showId of flagshipShows) {
    const show = showsById.get(showId);
    if (!show) continue;
    const dir = path.join(REVIEW_TEXTS_DIR, showId);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f === 'failed-fetches.json') continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        d.__file = f;
        d.__show = show;
        reviews.push(d);
      } catch { /* skip malformed */ }
    }
  }
  return reviews;
}

function main() {
  console.log('[temporal-regression] Loading flagship shows…');
  const showsById = loadShows();
  const flagshipShows = buildFlagshipList(showsById);
  console.log(`[temporal-regression] Flagship cohort: ${flagshipShows.length} shows (${SEED_FLAGSHIPS.length} seed + ${flagshipShows.length - SEED_FLAGSHIPS.length} dynamic from open/previews <5yr)`);
  const reviews = collectFlagshipReviews(showsById, flagshipShows);
  // Always add synthetic fixtures so the test never becomes a no-op when real
  // data is fully curated. These are pure function inputs, not file-system entries.
  const allReviews = reviews.concat(SYNTHETIC_FIXTURES);
  const eligible = allReviews.filter(r => isEligible(r, r.__show));
  const syntheticCount = SYNTHETIC_FIXTURES.filter(r => isEligible(r, r.__show)).length;

  console.log(`[temporal-regression] Flagship reviews scanned: ${reviews.length} real + ${SYNTHETIC_FIXTURES.length} synthetic`);
  console.log(`[temporal-regression] Eligible for temporal override (cv.wp=true, high conf, within 30d, not manually cleared): ${eligible.length} (${syntheticCount} synthetic)`);

  if (eligible.length === 0) {
    // Should never happen — synthetic fixtures always match isEligible.
    console.log('\n❌ FAIL — not even the synthetic fixtures were eligible. isEligible() may be broken.');
    process.exit(1);
  }

  // Run the real applyTemporalOverrides. Count how many retain 'high' confidence.
  // Under correct logic, this MUST be 0 — every 'high' gets downgraded to 'low'
  // within 30d. Under the Giant bad fix, survivors = eligible count.
  const survivors = [];
  const downgraded = [];
  for (const r of eligible) {
    const cv = r.contentVerification;
    const result = applyTemporalOverrides(
      cv.wrongProduction === true,
      cv.isFilmTv === true,
      cv.confidence,
      r.__show.openingDate,
      r.publishDate,
    );
    const summary = {
      showId: r.__show.id,
      outlet: r.outletId || r.outlet,
      critic: r.criticName,
      publishDate: r.publishDate,
      openingDate: r.__show.openingDate,
      before: cv.confidence,
      after: result.wpConfidence,
    };
    if (result.wpConfidence === 'high' || result.wpConfidence === 'medium') {
      survivors.push(summary);
    } else {
      downgraded.push(summary);
    }
  }

  console.log(`\n[temporal-regression] Downgraded by override: ${downgraded.length}`);
  console.log(`[temporal-regression] Survived override at high/medium: ${survivors.length} (tolerance: ≤${MAX_ALLOWED_SURVIVORS})`);

  if (survivors.length > MAX_ALLOWED_SURVIVORS) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('❌ FAIL — temporal override regression');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\nThe temporal override in applyTemporalOverrides is a SAFETY NET');
    console.log('against LLM false positives on opening-week wrongProduction flags.');
    console.log('LLM has ~15% FP rate at high confidence on opening-week reviews.');
    console.log('\nThe following flagship show reviews would be excluded:');
    console.log('');
    for (const s of survivors.slice(0, 20)) {
      console.log(`  • ${s.showId} · ${s.outlet} · ${s.critic || '(unknown critic)'}`);
      console.log(`      published ${s.publishDate}, show opened ${s.openingDate}`);
      console.log(`      cv.confidence: ${s.before} → ${s.after} (expected 'low')`);
    }
    if (survivors.length > 20) console.log(`  ...and ${survivors.length - 20} more`);
    console.log('');
    console.log('See: memory/feedback_llm_wrongprod_false_positives.md');
    console.log('     memory/feedback_scoring_delta_required.md');
    process.exit(1);
  }

  console.log('\n✅ PASS — all eligible high-confidence wrongProduction flags correctly downgraded to low within 30-day window.');
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.error(`[temporal-regression] fatal: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}
