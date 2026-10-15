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

test('not flagged: opened under a day ago, not open, other market, or no cached URL', () => {
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
