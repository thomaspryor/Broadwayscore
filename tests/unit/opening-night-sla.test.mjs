import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateSlaForReviews } = require('../../scripts/lib/opening-night-sla.js');

const MS_MIN = 60 * 1000;

function makeEntry(showId, reviewKey, stage, minsAgo, now) {
  return {
    showId,
    reviewKey,
    stage,
    at: new Date(now - minsAgo * MS_MIN).toISOString(),
  };
}

test('clean — no in-flight reviews produces empty warnings and pages', () => {
  const now = new Date('2026-04-15T22:00:00Z');
  const entries = [
    makeEntry('show-a', 'nytimes:brantley:https://x.com', 'review-first-seen', 45, now),
    makeEntry('show-a', 'nytimes:brantley:https://x.com', 'deployed-live', 10, now),
  ];
  const { warnings, pages } = evaluateSlaForReviews(entries, { now });
  assert.equal(warnings.length, 0);
  assert.equal(pages.length, 0);
});

test('one-warn — review in-flight 35 min produces one warning', () => {
  const now = new Date('2026-04-15T22:00:00Z');
  const entries = [
    makeEntry('show-b', 'guardian:akbar:https://g.com', 'review-first-seen', 35, now),
    // no deployed-live
  ];
  const { warnings, pages } = evaluateSlaForReviews(entries, { warningMinutes: 30, pageMinutes: 60, now });
  assert.equal(warnings.length, 1);
  assert.equal(pages.length, 0);
  assert.equal(warnings[0].showId, 'show-b');
  assert.equal(warnings[0].outletId, 'guardian');
  assert.equal(warnings[0].elapsedMin, 35);
});

test('one-page — review in-flight 70 min produces one page (not in warnings)', () => {
  const now = new Date('2026-04-15T22:00:00Z');
  const entries = [
    makeEntry('show-c', 'nypost:bloom:https://p.com', 'review-first-seen', 70, now),
  ];
  const { warnings, pages } = evaluateSlaForReviews(entries, { warningMinutes: 30, pageMinutes: 60, now });
  assert.equal(warnings.length, 0);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].elapsedMin, 70);
});

test('one-of-each — mixed bag: clean, warn, page', () => {
  const now = new Date('2026-04-15T22:00:00Z');
  const entries = [
    // clean (deployed)
    makeEntry('show-a', 'nytimes:brantley:https://x.com', 'review-first-seen', 50, now),
    makeEntry('show-a', 'nytimes:brantley:https://x.com', 'deployed-live', 5, now),
    // warning (35 min in-flight)
    makeEntry('show-a', 'guardian:akbar:https://g.com', 'review-first-seen', 35, now),
    // page (75 min in-flight)
    makeEntry('show-a', 'nypost:bloom:https://p.com', 'review-first-seen', 75, now),
  ];
  const { warnings, pages } = evaluateSlaForReviews(entries, { warningMinutes: 30, pageMinutes: 60, now });
  assert.equal(warnings.length, 1, 'one warning');
  assert.equal(pages.length, 1, 'one page');
});

test('entries without reviewKey or showId are ignored', () => {
  const now = new Date('2026-04-15T22:00:00Z');
  const entries = [
    // rebuilt summary — no reviewKey
    { showId: 'show-a', reviewKey: null, stage: 'rebuilt', at: new Date(now - 10 * MS_MIN).toISOString() },
    // deployed-live — no showId
    { showId: null, reviewKey: null, stage: 'deployed-live', at: new Date(now - 5 * MS_MIN).toISOString() },
    // valid in-flight review — should still be caught
    makeEntry('show-a', 'variety:jones:https://v.com', 'review-first-seen', 40, now),
  ];
  const { warnings, pages } = evaluateSlaForReviews(entries, { warningMinutes: 30, pageMinutes: 60, now });
  assert.equal(warnings.length, 1);
  assert.equal(pages.length, 0);
});
