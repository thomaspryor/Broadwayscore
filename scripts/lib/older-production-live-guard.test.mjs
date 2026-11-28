import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  urlOwnDate,
  staleWrongVerdictTierReason,
  urlDateContradictionReason,
  olderProductionLiveReason,
} = require('./older-production-live-guard.js');

// Show shapes copied from shows.json as of 2026-09-30 (BRO-4432).
const AYLI_GLOBE_2026 = {
  id: 'as-you-like-it-globe-west-end-2026', category: 'off-west-end',
  previewsStartDate: '2026-08-14', openingDate: '2026-08-21', closingDate: '2026-10-25',
};
const OLIVER_2024 = {
  id: 'oliver-west-end-2024', category: 'west-end',
  previewsStartDate: '2024-05-02', openingDate: '2024-12-14', closingDate: null,
};
const SPIES_2026 = {
  id: 'the-comedy-about-spies-west-end-2026', category: 'west-end',
  previewsStartDate: '2026-08-01', openingDate: '2026-08-06', closingDate: '2026-09-26',
  priorRuns: [{ openingDate: '2025-04-14', closingDate: '2025-08-03', venue: 'Noël Coward Theatre' }],
};

test('urlOwnDate reads a Guardian word-month path', () => {
  assert.deepEqual(
    urlOwnDate('https://www.theguardian.com/stage/2022/dec/15/as-you-like-it-review-josie-rourke-sohoplace-martha-plimpton'),
    { date: '2022-12-15', source: 'path' });
});

test('urlOwnDate reads a numeric /YYYY/MM/DD/ path', () => {
  assert.deepEqual(
    urlOwnDate('https://newyorktheater.me/2026/06/13/rosie-odonnells-common-knowledge-coming-to-nyc/'),
    { date: '2026-06-13', source: 'path' });
});

test('urlOwnDate decodes a Times version-1 article UUID', () => {
  assert.deepEqual(
    urlOwnDate('https://www.thetimes.com/article/b5d6bd62-4c17-11ee-a041-9c691fc04ff2'),
    { date: '2023-09-05', source: 'times-uuid-v1' });
  // Checked against a Times review whose publishDate is known: funny-girl-2022, 2022-04-25.
  assert.deepEqual(
    urlOwnDate('https://www.thetimes.co.uk/article/cdc50c76-c6df-11ec-81c0-e8eabc9951c2'),
    { date: '2022-04-28', source: 'times-uuid-v1' });
});

test('urlOwnDate ignores version-4 UUIDs, month-only paths and non-URLs', () => {
  assert.equal(urlOwnDate('https://www.thetimes.com/article/462f55ef-cabe-4abf-bc74-bb2463a7a80f'), null);
  assert.equal(urlOwnDate('https://everything-theatre.co.uk/2024/09/review-abigails-party-stratford-east/'), null);
  assert.equal(urlOwnDate('https://www.thestage.co.uk/reviews/oliver-review-gielgud-theatre-london'), null);
  assert.equal(urlOwnDate(null), null);
  assert.equal(urlOwnDate('https://x/2026/02/31/impossible-day/'), null);
});

test('stale tier: Oliver! Stage file of The Other Place (flag gone, reason left) is reported', () => {
  const r = staleWrongVerdictTierReason({
    url: 'https://www.thestage.co.uk/reviews/the-other-place-review-lyttelton-theatre-national-theatre-london-alexander-zeldin-antigone-emma-darcy-alison-oliver-nina-sosanya-tobias-menzies',
    contentTier: 'invalid', contentTierReason: 'Wrong production',
  });
  assert.match(r, /Wrong production/);
  assert.match(staleWrongVerdictTierReason({ contentTierReason: 'Wrong show', wrongShow: false }), /Wrong show/);
});

test('stale tier: flagged files, human clears and other reasons are not reported', () => {
  assert.equal(staleWrongVerdictTierReason({ contentTierReason: 'Wrong production', wrongProduction: true }), null);
  assert.equal(staleWrongVerdictTierReason({ contentTierReason: 'Wrong show', wrongShow: true }), null);
  assert.equal(staleWrongVerdictTierReason({ contentTierReason: 'Wrong production', wrongProductionManualClear: true }), null);
  assert.equal(staleWrongVerdictTierReason({ contentTierReason: 'Wrong production', humanReviewedWrongProduction: false }), null);
  assert.equal(staleWrongVerdictTierReason({ contentTierReason: 'Wrong show', wrongShowManualClear: true }), null);
  assert.equal(staleWrongVerdictTierReason({ contentTierReason: 'Full review text' }), null);
  assert.equal(staleWrongVerdictTierReason({}), null);
});

test('stale tier: a machine auto-clear does not hide it (the leak path itself)', () => {
  const r = staleWrongVerdictTierReason({
    contentTierReason: 'Wrong production', wrongProduction: true, wrongProductionAutoCleared: true,
  });
  assert.match(r, /no human clear/);
});

test('url contradiction: Guardian 2022 Sohoplace review stamped with the 2026 date is reported', () => {
  const r = urlDateContradictionReason({
    url: 'https://www.theguardian.com/stage/2022/dec/15/as-you-like-it-review-josie-rourke-sohoplace-martha-plimpton',
    publishDate: '2026-08-23',
  }, AYLI_GLOBE_2026);
  assert.match(r, /2022-12-15/);
  assert.match(r, /publishDate 2026-08-23/);
});

test('url contradiction: undated 2023 Times review on the 2026 Globe run is reported', () => {
  const r = urlDateContradictionReason({
    url: 'https://www.thetimes.com/article/b5d6bd62-4c17-11ee-a041-9c691fc04ff2', publishDate: null,
  }, AYLI_GLOBE_2026);
  assert.match(r, /2023-09-05 \(times-uuid-v1\)/);
  assert.match(r, /no publishDate/);
});

test('url contradiction: current-run review is not reported', () => {
  assert.equal(urlDateContradictionReason({
    url: 'https://www.theguardian.com/stage/2026/aug/23/as-you-like-it-review-shakespeares-globe-london',
    publishDate: '2026-08-23',
  }, AYLI_GLOBE_2026), null);
  // Same, with the date missing: the URL date is in window, so nothing to say.
  assert.equal(urlDateContradictionReason({
    url: 'https://www.theguardian.com/stage/2026/aug/23/as-you-like-it-review-shakespeares-globe-london',
  }, AYLI_GLOBE_2026), null);
});

test('url contradiction: a declared priorRuns window (same production transferring) is allowed', () => {
  assert.equal(urlDateContradictionReason({
    url: 'https://www.theguardian.com/stage/2025/may/14/the-comedy-about-spies-review-rapid-fire-gags-in-a-delightfully-silly-show',
    publishDate: null,
  }, SPIES_2026), null);
});

test('url contradiction: an old publishDate that agrees with the URL is left to validate-data CHECK 0', () => {
  assert.equal(urlDateContradictionReason({
    url: 'https://www.theguardian.com/stage/2022/dec/15/as-you-like-it-review-josie-rourke-sohoplace-martha-plimpton',
    publishDate: '2022-12-15',
  }, AYLI_GLOBE_2026), null);
});

test('olderProductionLiveReason names the shape, stale tier first', () => {
  assert.equal(olderProductionLiveReason({
    url: 'https://www.thestage.co.uk/reviews/the-other-place-review-lyttelton-theatre',
    contentTierReason: 'Wrong production', publishDate: '2024-10-09',
  }, OLIVER_2024)?.kind, 'stale-wrong-verdict-tier');
  assert.equal(olderProductionLiveReason({
    url: 'https://www.theguardian.com/stage/2022/dec/15/as-you-like-it-review-josie-rourke-sohoplace-martha-plimpton',
    publishDate: '2026-08-23',
  }, AYLI_GLOBE_2026)?.kind, 'url-date-contradiction');
  assert.equal(olderProductionLiveReason({
    url: 'https://www.thestage.co.uk/reviews/oliver-review-gielgud-theatre-london', publishDate: '2025-01-15',
  }, OLIVER_2024), null);
});

test('olderProductionLiveReason skips files already excluded by an effective flag', () => {
  assert.equal(olderProductionLiveReason({
    url: 'https://www.theguardian.com/stage/2022/dec/15/as-you-like-it-review-josie-rourke-sohoplace-martha-plimpton',
    publishDate: '2026-08-23', wrongProduction: true,
  }, AYLI_GLOBE_2026), null);
  assert.equal(olderProductionLiveReason({
    url: 'https://www.thetimes.com/article/b5d6bd62-4c17-11ee-a041-9c691fc04ff2', wrongShow: true,
  }, AYLI_GLOBE_2026), null);
});
