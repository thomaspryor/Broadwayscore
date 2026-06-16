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
const {
  applyTemporalOverrides,
  isReviewWithinOwnProductionWindow,
  isSameTitleDifferentYearFalsePositive,
  applyVenueClassificationCarveout,
} = require('./lib/review-guards');

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
    return false;
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
    return false;
  }

  console.log('\n✅ PASS — all eligible high-confidence wrongProduction flags correctly downgraded to low within 30-day window.');
  return true;
}

// ───────────────────────────────────────────────────────────────────────────
// Same-title / different-year + festival-venue regression (R&J Delacorte 2026)
//
// On 2026-06-15 the 2026 Shakespeare-in-the-Park "Romeo and Juliet" (Delacorte,
// opening 2026-06-11) had its in-window reviews flagged wrongProduction as the
// 2024 Connor/Zegler Broadway "Romeo + Juliet" — same title, different year —
// and the show rendered scoreless. These fixtures lock in the two guards added
// to prevent recurrence on the next classic revival (Hamlet, A Doll's House…).
// ───────────────────────────────────────────────────────────────────────────

const RJ_2026 = {
  id: 'romeo-and-juliet-off-broadway-2026-fixture',
  title: 'Romeo and Juliet',
  category: 'off-broadway',
  previewsStartDate: '2026-05-22',
  openingDate: '2026-06-11',
  closingDate: '2026-06-28',
  venue: 'Public Theater/Delacorte Theater',
};
const RJ_2024_BROADWAY = {
  id: 'romeo-juliet-2024-fixture',
  title: 'Romeo + Juliet',
  category: 'broadway',
  previewsStartDate: '2024-09-26',
  openingDate: '2024-10-24',
  closingDate: '2025-02-16',
  venue: 'Circle in the Square Theatre',
};

function assert(cond, label, failures) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    failures.push(label);
  }
}

function runSameTitleAndVenueFixtures() {
  console.log('\n[same-title-venue-regression] Running same-title/different-year + festival-venue fixtures…');
  const failures = [];

  // 1. In-window reviews of the NEW production are recognized as in-window.
  assert(
    isReviewWithinOwnProductionWindow(RJ_2026, '2026-06-12T06:57:12-04:00') === true,
    'opening-day review (2026-06-12) is inside R&J 2026 own window',
    failures,
  );
  assert(
    isReviewWithinOwnProductionWindow(RJ_2026, '2026-05-25') === true,
    'preview-week review (2026-05-25) is inside R&J 2026 own window',
    failures,
  );
  // A 2024 Broadway review is NOT inside the 2026 production's window.
  assert(
    isReviewWithinOwnProductionWindow(RJ_2026, '2024-10-25') === false,
    '2024 Broadway-era review is NOT inside R&J 2026 own window',
    failures,
  );

  // 2. Same-title/different-year false positive: an in-window 2026 review that
  //    the classifier wrongly attributes to the 2024 Broadway production is
  //    recognized as a false positive (forced CORRECT).
  assert(
    isSameTitleDifferentYearFalsePositive(RJ_2026, '2026-06-12', RJ_2024_BROADWAY) === true,
    'in-window 2026 review mis-attributed to 2024 Broadway → flagged as false positive',
    failures,
  );
  //    A genuinely 2024-era review is NOT exempted (out of the 2026 window).
  assert(
    isSameTitleDifferentYearFalsePositive(RJ_2026, '2024-10-25', RJ_2024_BROADWAY) === false,
    '2024-era review (out of 2026 window) is NOT exempted',
    failures,
  );
  //    A truly concurrent same-title production near publish time is NOT exempted.
  const CONCURRENT = { ...RJ_2024_BROADWAY, previewsStartDate: '2026-06-01', openingDate: '2026-06-10', closingDate: '2026-07-30' };
  assert(
    isSameTitleDifferentYearFalsePositive(RJ_2026, '2026-06-12', CONCURRENT) === false,
    'concurrent same-title production near publish time is NOT exempted',
    failures,
  );

  // 3. Festival-venue carve-out: a Delacorte review flagged wrongProduction purely
  //    on the "not an Off-Broadway venue" objection has the flag cleared.
  const venueCv = applyVenueClassificationCarveout(
    {
      wrongProduction: true,
      isValid: false,
      issues: ['Review describes Shakespeare in the Park production at Delacorte Theater, which is NOT an Off-Broadway venue'],
      reasoning: 'This is a legitimate review of a contemporary-set Romeo and Juliet at the Delacorte Theater in Central Park, not an Off-Broadway indoor production.',
    },
    RJ_2026,
  );
  assert(venueCv.clearedWrongProduction === true, 'venue-only objection clears wrongProduction', failures);
  assert(venueCv.restoredValidity === true, 'venue-only objection restores isValid=true', failures);

  //    But a Delacorte review with a REAL non-venue problem (truncation) keeps
  //    isValid=false — the carve-out only neutralizes the venue-only case.
  const venueCvTruncated = applyVenueClassificationCarveout(
    {
      wrongProduction: true,
      isValid: false,
      issues: [
        'Delacorte Theater is NOT an Off-Broadway venue',
        'Text is truncated mid-sentence at end',
        'Known excerpt does not appear in scraped content',
      ],
      reasoning: 'Legitimate Romeo and Juliet review at the Delacorte / Shakespeare in the Park, but truncated.',
    },
    RJ_2026,
  );
  assert(venueCvTruncated.clearedWrongProduction === true, 'venue objection clears wrongProduction even with truncation', failures);
  assert(venueCvTruncated.restoredValidity === false, 'truncated Delacorte review stays isValid=false (not venue-only)', failures);

  //    An ordinary (non-festival) show is unaffected by the carve-out.
  const ordinaryCv = applyVenueClassificationCarveout(
    {
      wrongProduction: true,
      isValid: false,
      issues: ['Review describes the Kennedy Center tryout, not the Broadway production'],
      reasoning: 'This review evaluates the pre-Broadway Kennedy Center run.',
    },
    { venue: 'Shubert Theatre', category: 'broadway' },
  );
  assert(ordinaryCv.clearedWrongProduction === false, 'ordinary-venue wrongProduction is NOT cleared by festival carve-out', failures);

  if (failures.length > 0) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`❌ FAIL — same-title/venue regression (${failures.length} assertion(s))`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('These guards prevent same-title revivals (R&J Delacorte 2026) from being');
    console.log('false-flagged as a different-year production and dropped from reviews.json.');
    console.log('See: memory/feedback_llm_wrongprod_false_positives.md');
    return false;
  }
  console.log('✅ PASS — same-title/different-year + festival-venue guards intact.');
  return true;
}

try {
  const temporalOk = main();
  const sameTitleOk = runSameTitleAndVenueFixtures();
  process.exit(temporalOk && sameTitleOk ? 0 : 1);
} catch (e) {
  console.error(`[temporal-regression] fatal: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}
