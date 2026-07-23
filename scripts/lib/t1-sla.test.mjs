import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isPublishDateSuspect, classifyMeasurability, computeSla } = require('./t1-sla.js');

test('isPublishDateSuspect: Newsday-backfill class (pub == fetch date, no source) → suspect', () => {
  assert.equal(isPublishDateSuspect({ publishDate: '2026-04-20', firstSeenAt: '2026-04-20T14:00:00Z' }), true);
  assert.equal(isPublishDateSuspect({ publishDate: null, firstSeenAt: '2026-04-20T14:00:00Z' }), true, 'no date');
  assert.equal(isPublishDateSuspect({ publishDate: '2026-04-18', firstSeenAt: '2026-04-20T14:00:00Z' }), false, 'real earlier pub date');
  assert.equal(isPublishDateSuspect({ publishDate: '2026-04-20', firstSeenAt: '2026-04-20T14:00:00Z', publishDateSource: 'json-ld' }), false, 'explicit metadata clears suspicion');
});

test('classifyMeasurability: suspect review is unmeasurable with a reason; real one gets a clock', () => {
  const susp = classifyMeasurability({ publishDate: '2026-04-20', firstSeenAt: '2026-04-20T00:00:00Z' }, '2026-04-01');
  assert.equal(susp.measurable, false);
  assert.equal(susp.reason, 'publish-eq-fetch-date');
  assert.equal(susp.clockStart, null);

  const good = classifyMeasurability({ publishDate: '2026-04-18', firstSeenAt: '2026-04-20T00:00:00Z' }, '2026-04-01');
  assert.equal(good.measurable, true);
  assert.equal(good.clockStart.slice(0, 10), '2026-04-18', 'clock = publishDate when it is after showCreatedAt');
});

test('clockStart = max(publishDate, showCreatedAt) — late catalog add moves the clock forward', () => {
  // Review published 2026-01-01 but the show wasn't in our catalog until 2026-04-01.
  const m = classifyMeasurability({ publishDate: '2026-01-01', firstSeenAt: '2026-04-05T00:00:00Z' }, '2026-04-01');
  assert.equal(m.clockStart.slice(0, 10), '2026-04-01', 'showCreatedAt wins when it is later than publishDate');
});

test('computeSla: unmeasurable reviews are excluded from the denominator (never inflate/deflate)', () => {
  const reviews = [
    // measurable (pub 04-18, first seen next day), scored 16h after clock → within SLA
    { tier: 1, showId: 's1', outletId: 'nytimes', publishDate: '2026-04-18T18:00:00Z', firstSeenAt: '2026-04-19T02:00:00Z', scoredAt: '2026-04-19T10:00:00Z', showCreatedAt: '2026-04-01' },
    // measurable, scored 3 days after clock → breaches SLA
    { tier: 1, showId: 's2', outletId: 'variety', publishDate: '2026-04-18T18:00:00Z', firstSeenAt: '2026-04-19T02:00:00Z', scoredAt: '2026-04-21T20:00:00Z', showCreatedAt: '2026-04-01' },
    // Newsday-backfill class (pub == fetch date) → unmeasurable, NOT in denominator
    { tier: 1, showId: 's3', outletId: 'newsday', publishDate: '2026-04-20', firstSeenAt: '2026-04-20T00:00:00Z', scoredAt: '2026-04-20T01:00:00Z', showCreatedAt: '2026-04-01' },
    // T2 → filtered out entirely
    { tier: 2, showId: 's4', outletId: 'nypost', publishDate: '2026-04-18T10:00:00Z', firstSeenAt: '2026-04-19T02:00:00Z', scoredAt: '2026-04-19T05:00:00Z', showCreatedAt: '2026-04-01' },
  ];
  const r = computeSla(reviews);
  assert.equal(r.measured, 2, 'only the two measurable T1 reviews count');
  assert.equal(r.withinSla, 1);
  assert.equal(r.pct, 50);
  assert.equal(r.unmeasurable, 1, 'the Newsday-backfill review lands in the unmeasurable bucket');
  assert.equal(r.unmeasurableSample[0].outletId, 'newsday');
});
