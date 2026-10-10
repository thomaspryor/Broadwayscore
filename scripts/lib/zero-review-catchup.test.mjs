// BRO-3389 — pure-function coverage for the catch-up selection logic
// extracted from update-show-status.yml's catchup-zero-review-shows job
// (CLAUDE.md §15: extract, export, test the real function).
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { selectCatchupCandidates, hasGivenUp } = require('./zero-review-catchup.js');

const NOW = new Date('2026-09-15T00:00:00.000Z').getTime();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);

function show(id, overrides = {}) {
  return { id, status: 'open', openingDate: daysAgo(10), ...overrides };
}

test('selectCatchupCandidates: excludes shows with reviews', () => {
  const shows = [show('a'), show('b')];
  const reviews = [{ showId: 'a' }];
  const { batch } = selectCatchupCandidates(shows, reviews, {}, { now: NOW });
  assert.deepStrictEqual(batch, ['b']);
});

test('selectCatchupCandidates: excludes shows within the initial grace window', () => {
  const shows = [show('fresh', { openingDate: daysAgo(1) })];
  const { batch } = selectCatchupCandidates(shows, [], {}, { now: NOW });
  assert.deepStrictEqual(batch, []);
});

test('selectCatchupCandidates: a show older than the age bound is reported as tooOld, not dispatched', () => {
  const shows = [show('ancient', { openingDate: daysAgo(400) })];
  const { batch, tooOld } = selectCatchupCandidates(shows, [], {}, { now: NOW, ageBoundDays: 90 });
  assert.deepStrictEqual(batch, []);
  assert.deepStrictEqual(tooOld, ['ancient']);
});

test('selectCatchupCandidates: noReviewsExpected shows are exempt, never dispatched', () => {
  const shows = [show('rep-show', { openingDate: daysAgo(400), noReviewsExpected: true })];
  const { batch, tooOld, exempt } = selectCatchupCandidates(shows, [], {}, { now: NOW });
  assert.deepStrictEqual(batch, []);
  assert.deepStrictEqual(tooOld, []);
  assert.deepStrictEqual(exempt, ['rep-show']);
});

test('selectCatchupCandidates: attempt memory gives up after maxAttempts', () => {
  const shows = [show('retried')];
  const attempts = { retried: { attempts: 3, firstAt: daysAgo(5) } };
  const { batch, givenUp } = selectCatchupCandidates(shows, [], attempts, { now: NOW, maxAttempts: 3 });
  assert.deepStrictEqual(batch, []);
  assert.deepStrictEqual(givenUp, ['retried']);
});

test('selectCatchupCandidates: attempt memory gives up after maxAttemptDays even under the attempt cap', () => {
  const shows = [show('stale-attempt')];
  const attempts = { 'stale-attempt': { attempts: 1, firstAt: daysAgo(45) } };
  const { batch, givenUp } = selectCatchupCandidates(shows, [], attempts, { now: NOW, maxAttemptDays: 30 });
  assert.deepStrictEqual(batch, []);
  assert.deepStrictEqual(givenUp, ['stale-attempt']);
});

test('selectCatchupCandidates: a recent attempt under both thresholds is still dispatched', () => {
  const shows = [show('retrying')];
  const attempts = { retrying: { attempts: 1, firstAt: daysAgo(5) } };
  const { batch } = selectCatchupCandidates(shows, [], attempts, { now: NOW });
  assert.deepStrictEqual(batch, ['retrying']);
});

test('selectCatchupCandidates: caps the batch at batchSize', () => {
  const shows = ['a', 'b', 'c'].map((id) => show(id));
  const { batch } = selectCatchupCandidates(shows, [], {}, { now: NOW, batchSize: 2 });
  assert.strictEqual(batch.length, 2);
});

test('selectCatchupCandidates: ignores non-open shows', () => {
  const shows = [show('closed-show', { status: 'closed' })];
  const { batch } = selectCatchupCandidates(shows, [], {}, { now: NOW });
  assert.deepStrictEqual(batch, []);
});

test('hasGivenUp: no entry means never given up', () => {
  assert.strictEqual(hasGivenUp(undefined, NOW), false);
});

test('hasGivenUp: exactly at the attempt cap gives up', () => {
  assert.strictEqual(hasGivenUp({ attempts: 3, firstAt: daysAgo(1) }, NOW, { maxAttempts: 3 }), true);
});
