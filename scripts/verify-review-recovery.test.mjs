import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveRelativeReviewUrl, reverseCrossMarketExclusion, explainRecoveryExclusion } = require('./lib/recovery-exclusions');

const show = { id: 'uncle-vanya-2024', category: 'broadway', openingDate: '2024-04-24' };
const marketContext = {
  outletRegionMap: { 'london-theatre': 'london', britishtheatrecom: 'london', guardian: 'london' },
  dualMarketOutlets: new Set(['guardian']),
};
const review = {
  outletId: 'london-theatre', criticName: 'Unknown',
  url: 'https://www.londontheatre.co.uk/reviews/review-uncle-vanya',
  publishDate: '2020-01-24', fullText: 'A review of the acting and direction. '.repeat(30),
  contentTier: 'complete', wrongProduction: true,
  humanReviewedWrongProduction: false,
  contentVerification: { wrongProduction: false, wrongArticle: false },
};
const reason = (data, production = show) => explainRecoveryExclusion(data, production, undefined, marketContext);
const reverse = (data, production = show) => reverseCrossMarketExclusion({
  data, show: production, canonicalOutlet: data.outletId, rawOutlet: data.outletId, ...marketContext,
});

test('BRO-6045: London Uncle Vanya is excluded even with a production manual clear', () => {
  assert.equal(reason(review), 'crossMarket');
  assert.equal(reverse(review).exclude, true);
});

test('wrongProduction excludes a review without a manual clear', () => {
  assert.equal(reason({ ...review, humanReviewedWrongProduction: undefined }), 'wrongProduction');
});

test('a production clear still works for a review that passes the market guard', () => {
  assert.equal(reason({ ...review, outletId: 'nytimes', url: 'https://www.nytimes.com/review' }), null);
});

test('BRO-6045: scored Junk author-profile artifact is excluded', () => {
  assert.equal(reason({
    outletId: 'njcom', criticName: 'Christopher Kelly', url: '/people/Christopher-Kelly/',
    contentTier: 'excerpt', assignedScore: 79, llmScore: { score: 79 },
  }, { id: 'junk-2017', category: 'broadway', openingDate: '2017-11-02' }), 'invalidUrl');
});

test('relative BWW articles are repaired, other relative URLs are excluded', () => {
  assert.deepEqual(resolveRelativeReviewUrl('/article/Review-123'), { url: '/article/Review-123', exclude: true });
  assert.deepEqual(resolveRelativeReviewUrl('/broadway/article/Review-123'), {
    url: 'https://www.broadwayworld.com/broadway/article/Review-123', exclude: false,
  });
  assert.equal(reason({
    outletId: 'broadwayworld', url: '/broadway/article/Review-123', llmScore: { score: 80 },
  }), null);
});

test('absent and absolute URLs retain existing rebuild behavior', () => {
  for (const url of [undefined, null, '', 'http://example.com/review', 'https://example.com/review']) {
    assert.deepEqual(resolveRelativeReviewUrl(url), { url, exclude: false });
  }
});

test('BRO-6045: Therese Raquin requires the explicit cross-market exemption', () => {
  const data = {
    outletId: 'britishtheatrecom', url: 'https://britishtheatre.com/review-therese-raquin-studio-54-4stars/',
    publishDate: '2015-10-29', llmScore: { score: 80 },
    wrongProductionOverride: true, wrongProductionManualClear: true,
  };
  const production = { id: 'therese-raquin-2015', category: 'broadway', openingDate: '2015-10-29' };
  assert.equal(reason(data, production), 'crossMarket');
  assert.equal(reason({ ...data, allowCrossMarket: true }, production), null);
});

test('dual-market outlets, early-date overrides and non-NYC shows retain exemptions', () => {
  for (const data of [{ ...review, outletId: 'guardian' }, { ...review, allowEarlyDate: true }, { ...review, allowCrossMarket: true }]) {
    assert.equal(reverse(data).exclude, false);
  }
  assert.equal(reverse(review, { ...show, category: 'west-end' }).exclude, false);
  assert.equal(reverse(review, { ...show, category: 'off-broadway' }).exclude, true);
});

test('a declared prior UK run bypasses the reverse market gate', () => {
  assert.equal(reverse(review, { ...show, priorRuns: [{
    venue: 'Harold Pinter Theatre, London', openingDate: '2020-01-01', closingDate: '2020-03-01',
  }] }).exclude, false);
});

test('CV can exempt a .com UK outlet but cannot override a UK host', () => {
  const data = { ...review, contentVerification: { isValid: true, wrongProduction: false, confidence: 'high' } };
  assert.equal(reverse(data).exclude, true);
  assert.equal(reverse({ ...data, url: 'https://britishtheatre.com/review' }).exclude, false);
});

test('UK-host fallback only applies to outlets without a registered region', () => {
  assert.equal(reverse({ ...review, outletId: 'unregistered' }).exclude, true);
  assert.equal(reverseCrossMarketExclusion({
    data: review, show, canonicalOutlet: 'london-theatre', rawOutlet: 'london-theatre',
    ...marketContext, outletRegionMap: { 'london-theatre': 'us' },
  }).exclude, false);
});
