#!/usr/bin/env node

/**
 * Tests for adjudication prompt builder — verifies KNOWN_STAR_OUTLETS gating.
 * Uses require() on the real lib module (never copies logic).
 */

const { KNOWN_STAR_OUTLETS, DESIGNATION_OUTLETS, buildUserPrompt } = require('./lib/adjudication-prompt');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

// --- Test fixtures ---
const baseReview = {
  showId: 'test-show-2026',
  outletId: 'guardian',
  criticName: 'Jane Doe',
  llmScore: 72,
  llmBucket: 'Positive',
  llmConfidence: 'high',
  reason: 'thumb-disagree',
};

const baseSourceData = {
  outletId: 'guardian',
  outlet: 'The Guardian',
  criticName: 'Jane Doe',
  fullText: 'This is a wonderful production that shines on every level.',
  originalScore: '4/5 stars',
};

// --- Test 1: Known star outlet includes rating without warning ---
console.log('\nTest 1: Known star outlet (guardian) — rating included normally');
{
  const prompt = buildUserPrompt(baseReview, baseSourceData, 'Test Show');
  assert(prompt.includes('### Original Rating\n4/5 stars'), 'Rating is present');
  assert(!prompt.includes('UNVERIFIED'), 'No UNVERIFIED warning');
}

// --- Test 2: Unknown outlet gets UNVERIFIED warning ---
console.log('\nTest 2: Unknown outlet (london-theatre) — rating marked UNVERIFIED');
{
  const review = { ...baseReview, outletId: 'london-theatre' };
  const source = { ...baseSourceData, outletId: 'london-theatre', outlet: 'London Theatre' };
  const prompt = buildUserPrompt(review, source, 'Test Show');
  assert(prompt.includes('UNVERIFIED'), 'UNVERIFIED warning is present');
  assert(prompt.includes('4/5 stars'), 'Rating value is still shown for context');
  assert(prompt.includes('not known to publish star ratings'), 'Explanation is present');
}

// --- Test 3: No originalScore — no rating section at all ---
console.log('\nTest 3: No originalScore — rating section omitted');
{
  const source = { ...baseSourceData, originalScore: undefined };
  const prompt = buildUserPrompt(baseReview, source, 'Test Show');
  assert(!prompt.includes('Original Rating'), 'No rating section');
}

// --- Test 4: outletId fallback from review when sourceData lacks it ---
console.log('\nTest 4: outletId falls back to review.outletId');
{
  const source = { ...baseSourceData, outletId: undefined };
  // review.outletId is 'guardian' (known), so should NOT get UNVERIFIED
  const prompt = buildUserPrompt(baseReview, source, 'Test Show');
  assert(!prompt.includes('UNVERIFIED'), 'Fallback to review.outletId works');
}

// --- Test 5: Unknown outlet in review fallback triggers warning ---
console.log('\nTest 5: Unknown outlet via review fallback');
{
  const review = { ...baseReview, outletId: 'some-blog' };
  const source = { ...baseSourceData, outletId: undefined };
  const prompt = buildUserPrompt(review, source, 'Test Show');
  assert(prompt.includes('UNVERIFIED'), 'Unknown outlet via fallback gets warning');
}

// --- Test 6: KNOWN_STAR_OUTLETS set is populated and correct ---
console.log('\nTest 6: KNOWN_STAR_OUTLETS sanity checks');
{
  // WE outlets
  assert(KNOWN_STAR_OUTLETS.has('guardian'), 'guardian is in set');
  assert(KNOWN_STAR_OUTLETS.has('thestage'), 'thestage is in set');
  assert(KNOWN_STAR_OUTLETS.has('broadwayworld'), 'broadwayworld is in set');
  // US outlets — verify correct outletIds (not display names)
  assert(!KNOWN_STAR_OUTLETS.has('nytimes'), 'nytimes is NOT in star set (uses Critic\'s Pick designation)');
  assert(KNOWN_STAR_OUTLETS.has('ew'), 'ew is in set (not entertainment-weekly)');
  assert(KNOWN_STAR_OUTLETS.has('nypost'), 'nypost is in set (not new-york-post)');
  assert(KNOWN_STAR_OUTLETS.has('chicagotribune'), 'chicagotribune is in set (not chicago-tribune)');
  assert(KNOWN_STAR_OUTLETS.has('washpost'), 'washpost is in set (not washington-post)');
  assert(KNOWN_STAR_OUTLETS.has('nydailynews'), 'nydailynews is in set (not new-york-daily-news)');
  assert(KNOWN_STAR_OUTLETS.has('nysr'), 'nysr is in set (not new-york-stage-review)');
  assert(KNOWN_STAR_OUTLETS.has('latimes'), 'latimes is in set (not la-times)');
  assert(KNOWN_STAR_OUTLETS.has('rollingstone'), 'rollingstone is in set (not rolling-stone)');
  assert(KNOWN_STAR_OUTLETS.has('time'), 'time is in set (not time-magazine)');
  // Excluded outlets
  assert(!KNOWN_STAR_OUTLETS.has('london-theatre'), 'london-theatre is NOT in set');
  assert(!KNOWN_STAR_OUTLETS.has('london-box-office'), 'london-box-office is NOT in set');
  assert(!KNOWN_STAR_OUTLETS.has('show-score'), 'show-score is NOT in set');
  // Old wrong IDs should NOT be present
  assert(!KNOWN_STAR_OUTLETS.has('entertainment-weekly'), 'entertainment-weekly (wrong ID) is NOT in set');
  assert(!KNOWN_STAR_OUTLETS.has('chicago-tribune'), 'chicago-tribune (wrong ID) is NOT in set');
  assert(!KNOWN_STAR_OUTLETS.has('new-york-post'), 'new-york-post (wrong ID) is NOT in set');
  assert(!KNOWN_STAR_OUTLETS.has('rolling-stone'), 'rolling-stone (wrong ID) is NOT in set');
  assert(KNOWN_STAR_OUTLETS.size > 30, `Set has ${KNOWN_STAR_OUTLETS.size} entries (expected >30)`);
}

// --- Test 7: EW (known star outlet) gets rating without warning ---
console.log('\nTest 7: EW outlet (ew) — rating included normally');
{
  const review = { ...baseReview, outletId: 'ew' };
  const source = { ...baseSourceData, outletId: 'ew', outlet: 'Entertainment Weekly', originalScore: 'A-' };
  const prompt = buildUserPrompt(review, source, 'Test Show');
  assert(prompt.includes('### Original Rating\nA-'), 'EW rating included normally');
  assert(!prompt.includes('UNVERIFIED'), 'No UNVERIFIED warning for EW');
}

// --- Test 8: NYT (designation outlet) gets special handling ---
console.log('\nTest 8: NYT Critic\'s Pick — treated as designation, not star rating');
{
  const review = { ...baseReview, outletId: 'nytimes' };
  const source = { ...baseSourceData, outletId: 'nytimes', outlet: 'The New York Times', originalScore: "Critic's Pick" };
  const prompt = buildUserPrompt(review, source, 'Test Show');
  assert(prompt.includes('Designation (NOT a star rating)'), 'Labeled as designation');
  assert(prompt.includes('binary endorsement'), 'Explains it is binary');
  assert(prompt.includes('score based on the review text'), 'Instructs to use text');
  assert(!prompt.includes('UNVERIFIED'), 'Not marked as UNVERIFIED');
  assert(!prompt.includes('### Original Rating\n'), 'Not shown as plain Original Rating');
}

// --- Test 9: DESIGNATION_OUTLETS sanity checks ---
console.log('\nTest 9: DESIGNATION_OUTLETS membership');
{
  assert(DESIGNATION_OUTLETS.has('nytimes'), 'nytimes is a designation outlet');
  assert(!DESIGNATION_OUTLETS.has('timeout'), 'timeout is NOT designation-only (has star ratings too)');
  assert(!DESIGNATION_OUTLETS.has('guardian'), 'guardian is NOT a designation outlet');
}

// --- Summary ---
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
