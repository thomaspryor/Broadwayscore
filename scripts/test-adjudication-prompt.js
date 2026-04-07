#!/usr/bin/env node

/**
 * Tests for adjudication prompt builder — verifies KNOWN_STAR_OUTLETS gating.
 * Uses require() on the real lib module (never copies logic).
 */

const { KNOWN_STAR_OUTLETS, buildUserPrompt } = require('./lib/adjudication-prompt');

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
  assert(KNOWN_STAR_OUTLETS.has('guardian'), 'guardian is in set');
  assert(KNOWN_STAR_OUTLETS.has('nytimes'), 'nytimes is in set');
  assert(KNOWN_STAR_OUTLETS.has('thestage'), 'thestage is in set');
  assert(!KNOWN_STAR_OUTLETS.has('london-theatre'), 'london-theatre is NOT in set');
  assert(!KNOWN_STAR_OUTLETS.has('london-box-office'), 'london-box-office is NOT in set');
  assert(!KNOWN_STAR_OUTLETS.has('show-score'), 'show-score is NOT in set');
  assert(KNOWN_STAR_OUTLETS.size > 20, `Set has ${KNOWN_STAR_OUTLETS.size} entries (expected >20)`);
}

// --- Summary ---
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
