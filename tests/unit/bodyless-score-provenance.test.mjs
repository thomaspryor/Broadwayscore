// BRO-3135: body-less review-texts stubs may only be scored when the star was
// page-parsed, or when the file's own text corroborates the production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  explainExclusion, isIncludableForRebuild, bodylessScoreProvenance,
  isBodylessAggregatorScoreUncorroborated,
} = require('../../scripts/lib/review-guards.js');

const show = {
  id: 'jane-eyre-off-west-end-2026', title: 'Jane Eyre', venue: 'Southwark Playhouse Elephant',
  category: 'off-west-end', market: 'west-end', openingDate: '2026-09-08', status: 'open', cast: [],
};

// thestage--tom-wicker.json as it stood on 2026-09-09 (paywalled, 0-char, star read off the page).
const stagePaywalled = {
  showId: show.id, outletId: 'thestage', outlet: 'The Stage', criticName: 'Tom Wicker',
  url: 'https://www.thestage.co.uk/reviews/jane-eyre-a-musical-review-southwark-playhouse',
  source: 'submit-review-form', originalScore: '3/5 stars', originalScoreNormalized: 60,
  originalScoreSource: 'stage-star-svg', scoreExtractedFrom: 'scraped-html',
  contentTier: 'stub', publishDate: '2026-09-09',
};

// london-box-office--stacey-tyler.json as it stood when monitor pass 44 caught it:
// no body, excerpt from the BRISTOL Old Vic production, star relayed by the LBO roundup.
const lboTylerStub = {
  showId: show.id, outletId: 'london-box-office', outlet: 'London Box Office', criticName: 'Stacey Tyler',
  url: 'https://www.londonboxoffice.co.uk/news/post/jane-eyre-southwark-playhouse-elephant-review',
  source: 'lbo-individual', firstSeenAt: '2026-09-09T09:31:54.587Z', fullText: '', contentTier: 'stub', publishDate: '2026-09-09',
  lboRoundupExcerpt: 'Based on the original novel by Charlotte Brontë, Bristol Old Vic’s adaptation of Jane Eyre',
  aggregatorStars: '4/5', aggregatorStarsNormalized: 80, originalScoreNormalized: 80,
  scoreSource: 'lbo-css-stars',
};

test('page-parsed body-less Stage file stays scoreable', () => {
  assert.equal(bodylessScoreProvenance(stagePaywalled), 'page-parsed');
  assert.equal(isBodylessAggregatorScoreUncorroborated(stagePaywalled, show), false);
  assert.notEqual(explainExclusion(stagePaywalled, show, 'x/thestage--tom-wicker.json'), 'bodylessAggregatorScoreUncorroborated');
});

test('page-parsed Stage star carried in aggregatorStars slot stays scoreable', () => {
  const d = { ...stagePaywalled, originalScore: null, originalScoreNormalized: null, originalScoreSource: undefined,
    aggregatorStars: '3/5', aggregatorStarsSource: 'stage-star-svg' };
  assert.equal(bodylessScoreProvenance(d), 'page-parsed');
});

test('aggregator-inherited body-less LBO stub is rejected', () => {
  assert.equal(bodylessScoreProvenance(lboTylerStub), 'aggregator-inherited');
  assert.equal(explainExclusion(lboTylerStub, show, 'x/london-box-office--stacey-tyler.json'), 'bodylessAggregatorScoreUncorroborated');
  assert.equal(isIncludableForRebuild(lboTylerStub, show, 'x/london-box-office--stacey-tyler.json'), false);
});

test('aggregator-inherited stub is scoreable once the excerpt names the venue', () => {
  const d = { ...lboTylerStub, lboRoundupExcerpt: 'At Southwark Playhouse Elephant, Charlie Burn leads this Jane Eyre' };
  assert.equal(isBodylessAggregatorScoreUncorroborated(d, show), false);
});

test('explicit scoreProvenance stamp overrides inference', () => {
  assert.equal(bodylessScoreProvenance({ ...lboTylerStub, scoreProvenance: 'page-parsed' }), 'page-parsed');
  assert.equal(bodylessScoreProvenance({ ...stagePaywalled, scoreProvenance: 'aggregator-inherited' }), 'aggregator-inherited');
});

test('files with a body, or humanReviewScore, are untouched', () => {
  const body = { ...lboTylerStub, fullText: 'x'.repeat(400) };
  assert.equal(bodylessScoreProvenance(body), null);
  assert.equal(isBodylessAggregatorScoreUncorroborated({ ...lboTylerStub, humanReviewScore: 70 }, show), false);
});

test('legacy unstamped stub (no firstSeenAt / pre-rollout) is grandfathered; a stamp still applies', () => {
  const { firstSeenAt, ...legacy } = lboTylerStub;
  assert.equal(isBodylessAggregatorScoreUncorroborated(legacy, show), false);
  assert.equal(isBodylessAggregatorScoreUncorroborated({ ...lboTylerStub, firstSeenAt: '2026-05-01T00:00:00Z' }, show), false);
  assert.equal(isBodylessAggregatorScoreUncorroborated({ ...legacy, scoreProvenance: 'aggregator-inherited' }, show), true);
});

test('venue match normalises both sides; walled-page headline counts as production evidence', () => {
  const hs = { ...show, venue: 'Hampstead Theatre Downstairs' };
  const d = { ...lboTylerStub, lboRoundupExcerpt: 'A tense night at Hampstead Theatre Downstairs' };
  assert.equal(isBodylessAggregatorScoreUncorroborated(d, hs), false);
  const h = { ...lboTylerStub, lboRoundupExcerpt: undefined, outletHeadline: 'Jane Eyre review, Southwark Playhouse Elephant' };
  assert.equal(isBodylessAggregatorScoreUncorroborated(h, show), false);
});
