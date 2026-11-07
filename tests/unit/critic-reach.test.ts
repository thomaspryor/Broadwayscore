/** BRO-6984: owner-only reach stat, rounded and hidden when small. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundReach, reachPhrase, showPathsFor, REACH_MIN_PEOPLE } from '../../src/lib/critic-reach';

test('rounds to the nearest 10 under 1,000 and the nearest 100 from 1,000', () => {
  assert.equal(roundReach(54), 50);
  assert.equal(roundReach(55), 60);
  assert.equal(roundReach(994), 990);
  assert.equal(roundReach(996), 1000);
  assert.equal(roundReach(1000), 1000);
  assert.equal(roundReach(2764), 2800);
  assert.equal(roundReach(12_349), 12_300);
});

test('hidden under the minimum or without a real number', () => {
  assert.equal(roundReach(REACH_MIN_PEOPLE - 1), null);
  assert.equal(roundReach(0), null);
  assert.equal(roundReach(null), null);
  assert.equal(roundReach(undefined), null);
  assert.equal(roundReach('900'), null);
  assert.equal(roundReach(NaN), null);
  assert.equal(reachPhrase(12), null);
});

test('wording says show pages featuring your reviews, never that people read the review', () => {
  const p = reachPhrase(2764)!;
  assert.equal(p, 'About 2,800 people visited show pages featuring your reviews in the last 30 days');
  assert.ok(!/\bread\b|readers/i.test(p));
});

test('show paths: one per show, safe slugs only', () => {
  assert.deepEqual(showPathsFor([{ showSlug: 'wicked' }, { showSlug: 'hamilton' }, { showSlug: 'wicked' }, { showSlug: "x') OR 1=1 --" }]), ['/show/hamilton', '/show/wicked']);
});
