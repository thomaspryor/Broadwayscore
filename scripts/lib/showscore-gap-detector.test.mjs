import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findShowScoreGaps } = require('./showscore-gap-detector.js');

const NOW = Date.parse('2026-10-15T12:00:00Z');
const show = (o = {}) => ({ id: 'a', status: 'open', category: 'broadway', openingDate: '2026-09-28', ...o });
const urls = { a: 'https://www.show-score.com/broadway-shows/a' };

test('flags an opened show with a cached URL and showScore == null', () => {
  const hits = findShowScoreGaps([show()], urls, { a: { sources: { showScore: null } } }, NOW);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'a');
});

test('flags when audience-buzz has no entry or no showScore key at all', () => {
  assert.equal(findShowScoreGaps([show()], urls, {}, NOW).length, 1);
  assert.equal(findShowScoreGaps([show()], urls, { a: { sources: {} } }, NOW).length, 1);
});

test('passes when showScore is populated', () => {
  const buzz = { a: { sources: { showScore: { score: 92, reviewCount: 414 } } } };
  assert.equal(findShowScoreGaps([show()], urls, buzz, NOW).length, 0);
});

test('off-broadway is covered', () => {
  assert.equal(findShowScoreGaps([show({ category: 'off-broadway' })], urls, {}, NOW).length, 1);
});

test('not flagged: opened under seven days ago, not open, other market, or no cached URL', () => {
  assert.equal(findShowScoreGaps([show({ openingDate: '2026-10-10' })], urls, {}, NOW).length, 0);
  assert.equal(findShowScoreGaps([show({ status: 'closed' })], urls, {}, NOW).length, 0);
  assert.equal(findShowScoreGaps([show({ status: 'previews' })], urls, {}, NOW).length, 0);
  assert.equal(findShowScoreGaps([show({ category: 'west-end' })], urls, {}, NOW).length, 0);
  assert.equal(findShowScoreGaps([show()], {}, {}, NOW).length, 0);
  assert.equal(findShowScoreGaps([show({ openingDate: undefined })], urls, {}, NOW).length, 0);
});

test('exactly seven days after opening counts', () => {
  assert.equal(findShowScoreGaps([show({ openingDate: '2026-10-08' })], urls, {}, Date.parse('2026-10-15T00:00:00Z')).length, 1);
});

test('off-off-broadway URLs are skipped (scraper rejects them by design)', () => {
  const u = { a: 'https://www.show-score.com/off-off-broadway-shows/a' };
  assert.equal(findShowScoreGaps([show({ category: 'off-broadway' })], u, {}, NOW).length, 0);
});

test('tolerates null inputs', () => {
  assert.deepEqual(findShowScoreGaps(null, null, null, NOW), []);
});

test('a cleanly stamped attempt gets a 21-day grace, then is flagged', () => {
  const buzz = { a: { sources: {}, showScoreLastAttempted: '2026-10-14T16:00:00Z' } };
  assert.equal(findShowScoreGaps([show({ openingDate: '2026-09-27' })], urls, buzz, NOW).length, 0);
  assert.equal(findShowScoreGaps([show({ openingDate: '2026-09-20' })], urls, buzz, NOW).length, 1);
});

// BRO-7023: Midnight (off-Broadway) sits on London's page until Show Score makes a NYC page.
test('London page served and re-checked recently: not a gap (marker, or tombstone plus fresh attempt)', () => {
  const old = { openingDate: '2026-09-01' };
  const marker = { a: { sources: {}, showScoreUkPageAt: '2026-10-08T14:00:00Z' } }; // 6.9 days old, weekly cadence
  const tomb = { a: { sources: {}, sourcesRemoved: { showScore: 'Show Score page is a UK production page (canonical /uk/london/...) (BRO-5499)' }, showScoreLastAttempted: '2026-10-14T02:00:00Z' } };
  assert.equal(findShowScoreGaps([show(old)], urls, marker, NOW).length, 0);
  assert.equal(findShowScoreGaps([show(old)], urls, tomb, NOW).length, 0);
});

test('London-page state goes loud again when the scraper stops confirming it', () => {
  const old = { openingDate: '2026-09-01' };
  const stale = { a: { sources: {}, showScoreUkPageAt: '2026-10-04T02:00:00Z' } }; // 11 days
  const tombStale = { a: { sources: {}, sourcesRemoved: { showScore: 'Show Score page is a UK production page' }, showScoreLastAttempted: '2026-10-01T02:00:00Z' } };
  const tombOnly = { a: { sources: {}, sourcesRemoved: { showScore: 'Show Score page is a UK production page' } } };
  assert.equal(findShowScoreGaps([show(old)], urls, stale, NOW).length, 1);
  assert.equal(findShowScoreGaps([show(old)], urls, tombStale, NOW).length, 1);
  assert.equal(findShowScoreGaps([show(old)], urls, tombOnly, NOW).length, 1);
});
