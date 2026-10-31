// BRO-4051. Shared by the unit manifest and the card's acceptance entrypoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  castWebSkipReason, validateCastSourceUrl, validateCastPageContext,
  scoreSerpResult, SERP_MIN_SCORE,
} = require('../../scripts/lib/cast-extraction-guards.js');
const { processShow } = require('../../scripts/backfill-cast-web.js');

const target = {
  id: 'macbeth-off-broadway-2026', title: 'Macbeth', type: 'opera',
  openingDate: '2026-09-22', venue: 'Metropolitan Opera House', category: 'off-broadway',
};
const prior = { id: 'macbeth-2022', title: 'Macbeth', openingDate: '2022-04-28', venue: 'Longacre Theatre' };
const badUrl = 'https://www.broadway.com/shows/macbeth-2022/cast/';
const wrongCast = [{ name: 'Daniel Craig', role: 'Macbeth' }, { name: 'Ruth Negga', role: 'Lady Macbeth' }];
const shows = [target, prior];

test('macbeth-2022 is rejected for the 2026 production even with strong SERP bonuses', () => {
  assert.equal(validateCastSourceUrl(badUrl, target, shows).ok, false);
  for (const domain of ['www.broadway.com', 'www.broadwayworld.com', 'lortel.org']) {
    const hit = { url: `https://${domain}/show/macbeth-2022/cast/`, title: 'Macbeth cast starring stars' };
    assert.ok(scoreSerpResult(hit, target, shows).score < SERP_MIN_SCORE);
  }
});

test('adjacent production years are rejected; a query year cannot hide the mismatch', () => {
  for (const year of [2025, 2027]) {
    assert.equal(validateCastSourceUrl(`https://example.com/production/macbeth-${year}/cast?season=2026`, target).ok, false);
    assert.equal(validateCastSourceUrl(`https://example.com/macbeth-${year}/cast`, target).ok, false);
  }
  assert.equal(validateCastSourceUrl('https://example.com/shows/macbeth-2026/cast', target).ok, true);
  assert.equal(validateCastSourceUrl(badUrl, prior, shows).ok, true);
});

test('another known production id is rejected even in the same year', () => {
  const other = { ...prior, id: 'macbeth-west-end-2026', openingDate: '2026-01-01' };
  assert.equal(validateCastSourceUrl('https://example.com/shows/macbeth-west-end-2026/cast', target, [...shows, other]).ok, false);
});

test('numeric listing ids and article publication dates are not production-year vetoes', () => {
  for (const url of [
    'https://www.broadwayworld.com/shows/Macbeth-335789/cast',
    'https://playbill.com/article/macbeth-cast-announced-2025',
    'https://example.com/2025/12/31/macbeth-cast-announced',
  ]) assert.equal(validateCastSourceUrl(url, target).ok, true);
  for (const url of [null, 'not a url', 'file:///shows/macbeth-2026/cast']) {
    assert.equal(validateCastSourceUrl(url, target).ok, false);
  }
});

test('opera/special types and the Met venue are skipped without mistaking musical titles for opera', () => {
  assert.ok(castWebSkipReason(target));
  assert.ok(castWebSkipReason({ ...target, type: 'special' }));
  assert.ok(castWebSkipReason({ ...target, type: 'play' }));
  assert.equal(castWebSkipReason({ title: 'The Phantom of the Opera', type: 'musical', venue: 'Majestic Theatre' }), null);
  assert.equal(castWebSkipReason({ title: 'The Snow Goose', type: 'musical', venue: 'Goodspeed Opera House, East Haddam, CT' }), null);
  assert.equal(castWebSkipReason({ title: 'The Last Ship', type: 'musical', venue: 'Metropolitan Opera House' }), null);
});

test('same-title pages need both the catalogue year and venue in text', () => {
  assert.equal(validateCastPageContext('Macbeth 2026 Metropolitan Opera House', target, shows).ok, true);
  assert.equal(validateCastPageContext('Macbeth 2026 Metropolitan\nOpera\tHouse', target, shows).ok, true);
  assert.equal(validateCastPageContext('Macbeth 2026 Longacre Theatre', target, shows).ok, false);
  assert.equal(validateCastPageContext('Macbeth 2022 Metropolitan Opera House', target, shows).ok, false);
  assert.equal(validateCastPageContext('Macbeth Metropolitan Opera House', target, shows).ok, false);
  assert.equal(validateCastPageContext('Macbeth 2026', { ...target, venue: null }, shows).ok, false);
});

test('opera processing performs no paid calls and does not mutate existing cast data', async () => {
  const show = { ...target, cast: [{ name: 'Existing singer', role: 'Macbeth' }] };
  const before = structuredClone(show);
  const unexpected = async () => assert.fail('skipped opera must not search, fetch or extract');
  const result = await processShow(show, shows, {
    searchCast: unexpected, fetchPageText: unexpected, extractCastWithLLM: unexpected,
  });
  assert.equal(result.skipped, true);
  assert.deepEqual(result.cast, []);
  assert.deepEqual(show, before);
});

test('the real processing path vetoes old cast URLs before fetching even for theatre shows', async () => {
  const theatre = { ...target, type: 'play', venue: 'Albion Theatre', cast: [{ name: 'Existing actor' }] };
  const before = structuredClone(theatre);
  const result = await processShow(theatre, [theatre, prior], {
    searchCast: async () => [{ url: badUrl, title: 'Macbeth cast' }],
    fetchPageText: async () => assert.fail('wrong production must not be fetched'),
    extractCastWithLLM: async () => wrongCast,
    sleep: async () => {},
  });
  assert.deepEqual(result.cast, []);
  assert.deepEqual(theatre, before);
});

test('uncorroborated same-title pages are rejected without tombstoning; matching pages still extract', async () => {
  const theatre = { ...target, type: 'play', venue: 'Albion Theatre' };
  const candidates = [theatre, prior];
  const services = {
    searchCast: async () => [{ url: 'https://example.com/shows/macbeth-2026/cast', title: 'Macbeth cast' }],
    sleep: async () => {},
  };
  const rejected = await processShow(theatre, candidates, {
    ...services,
    fetchPageText: async () => 'Macbeth 2026 Longacre Theatre. '.repeat(10),
    extractCastWithLLM: async () => assert.fail('unconfirmed venue must not reach the LLM'),
  });
  assert.deepEqual(rejected, { fetchFailed: true, cast: [] });
  const cast = [{ name: 'New actor', role: 'Macbeth' }];
  const accepted = await processShow(theatre, candidates, {
    ...services,
    fetchPageText: async () => 'Macbeth 2026 Albion Theatre. '.repeat(10),
    extractCastWithLLM: async () => cast,
  });
  assert.deepEqual(accepted.cast, cast);
});
