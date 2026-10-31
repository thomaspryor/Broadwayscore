/**
 * Run: node --test scripts/lib/audit-publisher-domain-live.test.mjs
 * BRO-4411: the audit must flag NYT reviews live as About Entertainment even
 * though the heal rule skips them, and stay quiet on legitimate rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { findMisattributions } = createRequire(import.meta.url)('../audit-publisher-domain-live.js');

const NYT = 'http://theater.nytimes.com/2009/03/10/theater/reviews/10thir.html';

test('flags a live nytimes URL filed as about-entertainment', () => {
  const r = findMisattributions([{ showId: 's', outletId: 'about-entertainment', criticName: 'Ben Brantley', url: NYT, contentTier: 'complete' }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].shouldBe, 'nytimes');
});

test('ignores correct labels, sister-paper pairs, unscored invalid rows and rows without a url', () => {
  assert.deepEqual(findMisattributions([
    { showId: 's', outletId: 'nytimes', criticName: 'Ben Brantley', url: 'https://www.nytimes.com/2009/a.html' },
    { showId: 's', outletId: 'observer', criticName: 'X', url: 'https://www.theguardian.com/stage/x' },
    { showId: 's', outletId: 'about-entertainment', criticName: 'Ben Brantley', url: NYT, contentTier: 'invalid' },
    { showId: 's', outletId: 'about-entertainment', criticName: 'Chris Caggiano', url: null },
  ]), []);
});
