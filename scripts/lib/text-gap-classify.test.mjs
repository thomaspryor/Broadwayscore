// classifyTextGap: one fixture per class (zero-gap plan section 1), plus the
// recency rule. Requires the real functions; no logic is copied here.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyTextGap, recencyOf, GAP_CLASSES, CLOSED_CLASSES } = require('./text-gap-classify.js');
const { NON_EVIDENCE_REASONS } = require('./failed-fetch-policy.js');

const NOW = Date.parse('2026-11-08T00:00:00Z');
const BODY = 'The company sings well and the second act moves quickly, though the book sags in places and the staging never quite earns its final image. '.repeat(14).trim();

const base = (over = {}) => ({
  showId: 'x-2026', outletId: 'example', criticName: 'A Critic', url: 'https://example.com/a',
  contentTier: 'truncated', contentTierReason: 'Missing proper ending or other signals',
  fullText: BODY, fetchMethod: 'scrapingbee', textFetchedAt: '2026-10-01T00:00:00Z', ...over,
});
const ff = (failureReason, over = {}) => ({ reviewId: 'x-2026/example--a-critic.json', failureReason, failureCount: 3, ...over });
const classify = (review, entry = null, ctx = {}) => classifyTextGap(review, entry, { nowMs: NOW, ...ctx });

const seen = new Set();
function expectClass(result, gapClass, subclass) {
  seen.add(result.gapClass);
  assert.equal(result.gapClass, gapClass, JSON.stringify(result));
  if (subclass !== undefined) assert.equal(result.subclass, subclass);
}

test('EXCLUDED: duplicate, live wrongShow, wrongProduction, roundup, non-review', () => {
  for (const [field, sub] of [['duplicateOf', 'duplicate'], ['wrongShow', 'wrongShow'], ['wrongProduction', 'wrongProduction'], ['isRoundupArticle', 'roundup'], ['isNonReview', 'nonReview']]) {
    const r = classify(base({ [field]: field === 'duplicateOf' ? 'other.json' : true }));
    expectClass(r, 'EXCLUDED', sub);
    assert.equal(r.open, false);
  }
});

test('a human-cleared wrongProduction is not an exclusion (ship-check finding)', () => {
  for (const f of ['wrongProductionManualClear', 'wrongProductionOverride']) {
    const r = classify(base({ wrongProduction: true, [f]: true }));
    assert.notEqual(r.gapClass, 'EXCLUDED', f);
    assert.equal(r.open, true);
  }
  assert.notEqual(classify(base({ wrongProduction: true, humanReviewedWrongProduction: false })).gapClass, 'EXCLUDED');
  expectClass(classify(base({ wrongProduction: true })), 'EXCLUDED', 'wrongProduction');
});

test('COMPLETE with a leftover failed-fetches row is closed but flagged', () => {
  const r = classify(base({ contentTier: 'complete' }), ff('url_content_mismatch'));
  assert.equal(r.gapClass, 'COMPLETE');
  assert.equal(r.subclass, 'with_failed_fetch_row');
  assert.equal(r.open, false);
});

test('COMPLETE is not a gap', () => {
  const r = classify(base({ contentTier: 'complete' }));
  expectClass(r, 'COMPLETE');
  assert.equal(r.open, false);
});

test('TERMINAL needs a record with reason, date and evidence', () => {
  const rec = { reason: 'ARTICLE_GONE', decidedAt: '2026-11-01', evidence: ['run1:a1'] };
  expectClass(classify(base({ textUnrecoverable: rec })), 'TERMINAL', 'ARTICLE_GONE');
  assert.notEqual(classify(base({ textUnrecoverable: { reason: 'ARTICLE_GONE' } })).gapClass, 'TERMINAL');
  assert.ok(CLOSED_CLASSES.includes('TERMINAL'));
});

test('FALSE_TRUNCATION_SUSPECT: Guardian listing trailer on a whole review', () => {
  const r = classify(base({
    outletId: 'guardian', truncationSignals: ['no_ending_punctuation'],
    fullText: BODY + ' • At the Almeida, London, until 7 June',
  }));
  expectClass(r, 'FALSE_TRUNCATION_SUSPECT');
  assert.equal(r.open, true);
});

test('FALSE_TRUNCATION_SUSPECT is not claimed for a mid-sentence cut before a trailer', () => {
  const r = classify(base({
    outletId: 'guardian', truncationSignals: ['no_ending_punctuation'],
    fullText: BODY.slice(0, -40) + ' • At the Almeida, London, until 7 June',
  }));
  expectClass(r, 'TRUNCATED_OTHER', 'truncated');
});

test('FALSE_TRUNCATION_SUSPECT is not claimed when a paywall signal is present', () => {
  const r = classify(base({
    outletId: 'guardian', truncationSignals: ['no_ending_punctuation', 'paywall_or_login_prompt'],
    fullText: BODY + ' • At the Almeida, London, until 7 June',
  }));
  assert.notEqual(r.gapClass, 'FALSE_TRUNCATION_SUSPECT');
});

test('SHORT_UNVERIFIED: tier reason "Short text"', () => {
  expectClass(classify(base({ contentTierReason: 'Short text (80 words)', fullText: 'Short capsule.' })), 'SHORT_UNVERIFIED');
});

test('PAYWALL_TRUNCATED: partial text on a known paywall domain', () => {
  expectClass(classify(base({ url: 'https://www.wsj.com/articles/x', outletId: 'wsj' })), 'PAYWALL_TRUNCATED', 'paywall');
});

test('TRUNCATED_OTHER: partial text, no paywall, no failed fetch', () => {
  expectClass(classify(base({ fullText: BODY.slice(0, -40) })), 'TRUNCATED_OTHER', 'truncated');
});

test('NO_URL with subclasses: defunct outlet, aggregator reference, bare', () => {
  const none = base({ url: null, fullText: '', contentTier: 'stub' });
  expectClass(classify(none, null, { outletInfo: { accessModel: 'defunct' } }), 'NO_URL', 'PRINT_OR_DEFUNCT');
  expectClass(classify({ ...none, bwwExcerpt: 'A line from the roundup.' }), 'NO_URL', 'AGG_REF');
  expectClass(classify(none), 'NO_URL', 'BARE');
});

test('URL_DEAD: failed fetch says 404', () => {
  expectClass(classify(base({ fullText: '', contentTier: 'stub' }), ff('url_dead_404')), 'URL_DEAD', 'url_dead_404');
});

test('URL_WRONG_PAGE: url_content_mismatch', () => {
  expectClass(classify(base({ fullText: '', contentTier: 'stub' }), ff('url_content_mismatch')), 'URL_WRONG_PAGE');
});

test('PAYWALL_PAGE vs GARBAGE_PAGE from garbage_content', () => {
  const stub = base({ fullText: '', contentTier: 'stub' });
  expectClass(classify(stub, ff('garbage_content', { garbageReason: 'Subscribe to continue reading' })), 'PAYWALL_PAGE');
  expectClass(classify(stub, ff('garbage_content', { garbageReason: 'Error page' })), 'GARBAGE_PAGE', 'garbage_content');
  expectClass(classify(base({ contentTier: 'invalid' })), 'GARBAGE_PAGE', 'invalid_tier');
});

test('BLOCKED: every tier failed', () => {
  const stub = base({ fullText: '', contentTier: 'stub' });
  expectClass(classify(stub, ff('all_tiers_failed')), 'BLOCKED', 'all_tiers_failed');
  expectClass(classify(stub, ff('all_tiers_timeout')), 'BLOCKED', 'all_tiers_timeout');
});

test('DEFERRED: every NON_EVIDENCE reason, soft_404 included (failed-fetch-policy agrees)', () => {
  assert.ok(NON_EVIDENCE_REASONS.includes('soft_404'));
  const stub = base({ fullText: '', contentTier: 'stub' });
  for (const reason of NON_EVIDENCE_REASONS) {
    expectClass(classify(stub, ff(reason)), 'DEFERRED', reason);
  }
});

test('NEVER_FETCHED: URL, no body, no failure row', () => {
  const never = base({ fullText: '', contentTier: 'excerpt', fetchMethod: undefined, textFetchedAt: undefined });
  expectClass(classify(never), 'NEVER_FETCHED', 'never_scraped');
  expectClass(classify(base({ fullText: '', contentTier: 'excerpt' })), 'NEVER_FETCHED', 'no_text_after_fetch');
});

test('UNCLASSIFIED: nothing matches, surfaced rather than hidden', () => {
  expectClass(classify(base({ contentTier: 'none', fullText: '' })), 'UNCLASSIFIED');
});

test('every declared class has a fixture above', () => {
  assert.deepEqual([...seen].sort(), [...GAP_CLASSES].sort());
});

test('recency: opened within 730 days is recent, older is historic, undated counts as recent', () => {
  assert.equal(recencyOf({ openingDate: '2025-03-01' }, NOW).recency, 'recent');
  assert.equal(recencyOf({ openingDate: '2024-11-09' }, NOW).recency, 'recent');
  assert.equal(recencyOf({ openingDate: '2024-11-07' }, NOW).recency, 'historic');
  assert.equal(recencyOf({ openingDate: '2027-01-01' }, NOW).recency, 'recent');
  assert.equal(recencyOf({ previewsStartDate: '2019-05-01' }, NOW).recency, 'historic');
  const undated = recencyOf({}, NOW);
  assert.deepEqual(undated, { recency: 'recent', dateKnown: false });
  assert.equal(classify(base({ contentTier: 'complete' }), null, { show: { openingDate: '2019-01-01' } }).recency, 'historic');
});
