import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveShowIdentity } = require('./show-identity.js');
const { assessTextQuality, detectMultiShowContent } = require('./content-quality.js');

// ============================================================================
// Regression: Holy Fool (Park Theatre) 2026-09-04.
//
// assessTextQuality's signature is (text, showId, showTitle). Callers used to
// collapse both into one derived slug and pass it positionally, so the slug
// landed in the showId slot and showTitle was undefined. The mention check
// then hunted for "holy fool off west end" — the id with its CATEGORY SUFFIX
// still attached — which appears in no review, so the show read as "not
// mentioned". That is the condition that hardens a multi-show hit into
// garbage/high, and it kept two real London reviews out of the corpus.
//
// Broadway ids ("hamilton-2015" -> "hamilton") survived by accident; every
// West End / Off-West-End / Off-Broadway / regional id carries a suffix, so
// London shows failed as a class. resolveShowIdentity is the shared fix —
// shared because the same mistake was independently present in
// collect-review-texts.js AND in fix-garbage-reviews.js, which DELETES
// already-saved fullText on a garbage verdict.
// ============================================================================

test('resolveShowIdentity returns the id unchanged and a title without the category suffix', () => {
  const { showId, showTitle } = resolveShowIdentity('holy-fool-off-west-end-2026');
  assert.equal(showId, 'holy-fool-off-west-end-2026', 'showId must pass through verbatim');
  assert.ok(
    !/off west end|west end/i.test(showTitle),
    `title must not carry the category suffix, got ${JSON.stringify(showTitle)}`
  );
});

test('resolveShowIdentity degrades to a slug title for an unknown id without throwing', () => {
  const { showId, showTitle } = resolveShowIdentity('not-a-real-show-9999');
  assert.equal(showId, 'not-a-real-show-9999');
  assert.ok(showTitle.length > 0, 'must still yield some title rather than empty');
  // The fallback is degraded but not broken: the id is still correct, so the
  // mention check keeps working off the id's own words.
  assert.ok(!showTitle.includes('-'), `slug fallback should be space-separated, got ${showTitle}`);
});

test('resolveShowIdentity tolerates a missing showId', () => {
  const r = resolveShowIdentity(undefined);
  assert.equal(r.showId, '');
  assert.equal(typeof r.showTitle, 'string');
});

// The end-to-end shape of the bug: a real single-show review that mentions one
// frequently-revived title. Called the OLD way it reads as garbage; called
// through resolveShowIdentity it reads as a valid review.
function buildLondonReviewText() {
  const body = 'At the Park Theatre this production traces the composer from the denunciation of his opera in 1936 through four decades of work under a state that could turn on him overnight. Holy Fool is spare, and the two performances hold it together. Macbeth is invoked again and again as the work that made him dangerous. ';
  let text = '';
  while (text.length < 2600) text += body;
  return text;
}

test('the old slug-in-showId call reads a real London review as not-mentioned; the fixed call does not', () => {
  const text = buildLondonReviewText();
  const legacySlug = 'holy-fool-off-west-end-2026'.replace(/-\d{4}$/, '').replace(/-/g, ' ');

  // Old call shape: slug in the showId slot, showTitle undefined.
  const legacy = assessTextQuality(text, legacySlug);
  // Fixed call shape.
  const { showId, showTitle } = resolveShowIdentity('holy-fool-off-west-end-2026');
  const fixed = assessTextQuality(text, showId, showTitle);

  assert.notEqual(
    fixed.confidence,
    'low',
    `fixed call should recognise the show; got ${fixed.quality}/${fixed.confidence} ${JSON.stringify(fixed.issues)}`
  );
  assert.ok(
    !(fixed.quality === 'garbage' && fixed.confidence === 'high'),
    `a real review must not read as garbage/high; got ${JSON.stringify(fixed.issues)}`
  );
  // The legacy shape is what produced the incident — assert it is genuinely
  // worse, so this test fails if someone reinstates the old call.
  const legacyIssues = JSON.stringify(legacy.issues || []);
  assert.ok(
    legacyIssues.includes('not mentioned') || legacy.quality === 'garbage',
    `expected the legacy slug call to misjudge the show, got ${legacy.quality}/${legacy.confidence} ${legacyIssues}`
  );
});

test('a proper showId lets detectMultiShowContent exclude the show under review', () => {
  const text = buildLondonReviewText();
  const withId = detectMultiShowContent(text, 'holy-fool-off-west-end-2026');
  assert.ok(
    !withId.showsFound.includes('holy fool'),
    `the show under review must be excluded from its own mention count, got ${JSON.stringify(withId.showsFound)}`
  );
});
