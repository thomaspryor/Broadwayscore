// BRO-5231: URL-corrected reviews must not be skipped by the "already has good
// text / already scored" short-circuits in collect-review-texts.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isUrlCorrectedRefetch, mayShortCircuitCollected } = require('../../scripts/lib/url-corrected-refetch.js');
const { shouldSkipScoredReview } = require('../../scripts/lib/review-guards.js');

const stale = {
  needsRefetch: true,
  urlCorrectedFrom: 'https://example.com/old',
  contentTier: 'complete',
  textQuality: 'full',
  fullText: 'x'.repeat(4000),
  assignedScore: 77,
};
const opts = (d, over = {}) => ({
  isTruncated: false,
  hasGarbageText: false,
  datelessDateRetry: false,
  completeSkip: d.contentTier === 'complete' || d.textQuality === 'full',
  scoredSkip: shouldSkipScoredReview(d, 0),
  ...over,
});

test('url-corrected complete+scored review is NOT short-circuited', () => {
  assert.equal(isUrlCorrectedRefetch(stale), true);
  assert.equal(opts(stale).completeSkip, true);
  assert.equal(opts(stale).scoredSkip, true);
  assert.equal(mayShortCircuitCollected(stale, opts(stale)), false);
});

test('ordinary complete review is still skipped', () => {
  const d = { ...stale, needsRefetch: false, urlCorrectedFrom: undefined };
  assert.equal(isUrlCorrectedRefetch(d), false);
  assert.equal(mayShortCircuitCollected(d, opts(d)), true);
});

test('ordinary scored-only review is still skipped', () => {
  const d = { fullText: 'x'.repeat(500), assignedScore: 70 };
  assert.equal(mayShortCircuitCollected(d, opts(d)), true);
});

test('needsRefetch without urlCorrectedFrom is not a url correction', () => {
  assert.equal(isUrlCorrectedRefetch({ needsRefetch: true }), false);
  assert.equal(isUrlCorrectedRefetch(null), false);
});

test('collector wires the real predicate (no inline copy)', () => {
  const src = fs.readFileSync(new URL('../../scripts/collect-review-texts.js', import.meta.url), 'utf8');
  assert.match(src, /require\('\.\/lib\/url-corrected-refetch'\)/);
  assert.match(src, /mayShortCircuitCollected\(data,/);
  assert.match(src, /const urlCorrectedRefetch = isUrlCorrectedRefetch\(data\)/);
});

test('locked / manually-complete corrected files keep the skip (write guard never clears them)', () => {
  for (const extra of [{ _locked: true }, { manualContentTier: 'complete' }]) {
    const d = { ...stale, ...extra };
    assert.equal(mayShortCircuitCollected(d, opts(d)), true);
  }
});

// 2026-10-19 follow-ups: a flag left set on a body that already came from the
// corrected url, and a flag lost while the old body stayed.
const { isRefetchSatisfied, staleCorrectedBody, bypassesFetchFailureGate } = require('../../scripts/lib/url-corrected-refetch.js');

const NOW = Date.parse('2026-10-19T00:00:00Z');
// Shape of pride-west-end-2026/independent--louis-chilton.json on 2026-10-19.
const prideStale = {
  url: 'https://www.independent.co.uk/arts-entertainment/theatre-dance/reviews/pride-musical-review-national-theatre-b3003069.html',
  urlCorrectedFrom: 'https://www.independent.co.uk/independentpremium/culture/pride-and-prejudice-sort-of-review-b1950575.html',
  needsRefetch: false,
  publishDate: '2026-06-25',
  textFetchedAt: '2026-06-22T00:04:50.885Z',
  contentTier: 'complete',
  textQuality: 'full',
  assignedScore: 77,
  fullText: 'Independent Premium Culture Pride and Prejudice* (*Sort Of) review: There is bite to this fluffy cucumber sandwich of a show Alice Saville Thursday 04 November 2021 06:32 GMT Bookmark Comments '
    + 'Behind every period drama there are servants. '.repeat(80),
};

test('needsRefetch is satisfied by a body fetched after the correction to the current url', () => {
  const d = {
    ...stale,
    url: 'https://www.wsj.com/new',
    textFetchedAt: '2026-08-02T21:34:07.125Z',
    _urlChangedClear: { from: 'https://www.wsj.com/old', to: 'https://www.wsj.com/new', at: '2026-07-29T09:58:11.780Z', cleared: ['fullText'] },
  };
  assert.equal(isRefetchSatisfied(d), true);
  assert.equal(isUrlCorrectedRefetch(d), false);
  assert.equal(mayShortCircuitCollected(d, opts(d)), true);
});

test('needsRefetch is NOT satisfied by a body older than the correction, or a correction to another url', () => {
  const base = { ...stale, url: 'https://x.com/new', _urlChangedClear: { to: 'https://x.com/new', at: '2026-07-29T09:58:11.780Z' } };
  assert.equal(isUrlCorrectedRefetch({ ...base, textFetchedAt: '2026-07-01T00:00:00Z' }), true);
  assert.equal(isUrlCorrectedRefetch({ ...base, textFetchedAt: '2026-08-02T00:00:00Z', _urlChangedClear: { ...base._urlChangedClear, to: 'https://x.com/other' } }), true);
  assert.equal(isUrlCorrectedRefetch({ ...base, textFetchedAt: '2026-08-02T00:00:00Z', fullText: '' }), true);
});

test('lost flag: a corrected file whose body byline predates publishDate is refetched (Pride Independent)', () => {
  assert.ok(staleCorrectedBody(prideStale, { now: NOW }));
  assert.equal(isUrlCorrectedRefetch(prideStale, { now: NOW }), true);
  assert.equal(isUrlCorrectedRefetch(prideStale), true);
  assert.equal(mayShortCircuitCollected(prideStale, opts(prideStale)), false);
  // A stale-body pick does not bypass the failed-fetch ledger; a set flag does.
  assert.equal(bypassesFetchFailureGate(prideStale), false);
  assert.equal(bypassesFetchFailureGate(stale), true);
});

test('stale-body pick: cooldown after a recent fetch, and no pick without a correction or with a matching byline', () => {
  assert.equal(staleCorrectedBody({ ...prideStale, textFetchedAt: '2026-10-17T00:00:00Z' }, { now: NOW }), null);
  assert.equal(staleCorrectedBody({ ...prideStale, urlCorrectedFrom: undefined }, { now: NOW }), null);
  const current = { ...prideStale, fullText: prideStale.fullText.replace('Thursday 04 November 2021', 'Thursday 25 June 2026') };
  assert.equal(staleCorrectedBody(current, { now: NOW }), null);
  // Body dated AFTER publishDate: the date may be stale, not the body.
  const later = { ...prideStale, publishDate: '2021-06-25' };
  assert.equal(staleCorrectedBody(later, { now: NOW }), null);
});

test('collector reads the corrected state before replacing fullText and gates the ledger bypass', () => {
  const src = fs.readFileSync(new URL('../../scripts/collect-review-texts.js', import.meta.url), 'utf8');
  const before = src.indexOf('const urlCorrectedBefore = isUrlCorrectedRefetch(data)');
  const assign = src.indexOf('data.fullText = cleanedText;');
  assert.ok(before > 0 && assign > before, 'urlCorrectedBefore must be read before fullText is replaced');
  assert.match(src, /if \(urlCorrectedBefore && hadFullTextBefore/);
  assert.match(src, /fetchFailureEntry && !bypassesFetchFailureGate\(data\)/);
});

test('URL_CORRECTED_STALE_BODY_OFF=1 drops the stale-body signal only', () => {
  process.env.URL_CORRECTED_STALE_BODY_OFF = '1';
  try {
    assert.equal(isUrlCorrectedRefetch(prideStale, { now: NOW }), false);
    assert.equal(isUrlCorrectedRefetch(stale), true);
  } finally {
    delete process.env.URL_CORRECTED_STALE_BODY_OFF;
  }
});
