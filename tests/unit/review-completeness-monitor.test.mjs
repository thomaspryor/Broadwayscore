/**
 * review-completeness-monitor.test.mjs — BRO-1618 acceptance test.
 *
 * Guards the review-completeness measurement layer against the failure that kept the
 * T1 retrieval SLA reading a flat "SLA: 0%" for months while the pipeline underneath
 * it was actually fast.
 *
 * The bug was never in retrieval. It was in the CLOCK:
 *   • publishDate is day-resolution for effectively the whole corpus, so clockStart
 *     was midnight UTC. Reviews drop in the evening, so a review published ~21:00 ET
 *     on opening night and scored 22:28 ET the SAME EVENING measured 26.5h — a
 *     "breach". Every row landed in a tight band just above the threshold
 *     (26.5/31.3/33.0/37.9/38.9h): a fixed offset, not a slow pipeline.
 *   • Unparseable dates ("undefined", "August 25, 2026") produced NaN, and
 *     `NaN <= 24h` is false, so garbage was silently counted as a breach too.
 *   • The HH:MM timestamps that DO exist are 24.3% roundup bleed (450 of 1,853
 *     corpus-wide): one aggregator page's datePublished copied onto every review
 *     extracted from it, up to 26 outlets sharing a single second.
 *
 * The rule these tests enforce: a review whose publication instant we do not actually
 * know is UNMEASURABLE, never a breach. Reporting a fabricated failure is worse than
 * admitting the metric is blind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyMeasurability,
  computeSla,
  hasPrecisePublishTime,
  findSharedPublishTimestamps,
} = require('../../scripts/lib/t1-sla.js');

const PRECISE = '2026-08-25T20:51:56-04:00';

test('hasPrecisePublishTime: only an HH:MM clock counts as precise', () => {
  assert.equal(hasPrecisePublishTime(PRECISE), true);
  assert.equal(hasPrecisePublishTime('2026-08-25'), false);
  // 14 characters long, but carries no time of day — a length check would pass it.
  assert.equal(hasPrecisePublishTime('August 25, 2026'), false);
  assert.equal(hasPrecisePublishTime(undefined), false);
  assert.equal(hasPrecisePublishTime('undefined'), false);
});

test('a day-resolution publishDate is unmeasurable, NOT a breach', () => {
  // The paranormal-activity-2026 NYT row: published on the evening of 8/25 ET and
  // scored 02:28Z on 8/26 (22:28 ET the same night). Measured from midnight UTC that
  // read as 26.5h late; the pipeline had in fact turned it round in ~90 minutes.
  const m = classifyMeasurability(
    { showId: 'paranormal-activity-2026', outletId: 'nytimes', publishDate: '2026-08-25', firstSeenAt: '2026-08-26T02:28:23.671Z' },
    '2026-08-14',
  );
  assert.equal(m.measurable, false);
  assert.equal(m.reason, 'date-only-publish-date');
  assert.equal(m.clockStart, null);
});

test('an unparseable publishDate is unmeasurable, not a silent NaN breach', () => {
  for (const bad of ['undefined', 'not a date', '']) {
    const m = classifyMeasurability(
      { showId: 's', outletId: 'o', publishDate: bad, firstSeenAt: '2026-08-26T02:00:00Z' },
      '2026-08-14',
    );
    assert.equal(m.measurable, false, `expected ${JSON.stringify(bad)} to be unmeasurable`);
    assert.notEqual(m.clockStart, 'Invalid Date');
  }
});

test('a genuine per-article timestamp IS measurable and starts the clock at publication', () => {
  const m = classifyMeasurability(
    { showId: 'paranormal-activity-2026', outletId: 'variety', publishDate: PRECISE, firstSeenAt: '2026-08-26T02:28:42.418Z' },
    '2026-08-14',
  );
  assert.equal(m.measurable, true);
  assert.equal(m.clockStart, new Date(PRECISE).toISOString());
});

test('findSharedPublishTimestamps flags an instant shared across outlets of one show', () => {
  const rows = [
    { showId: 'paranormal-activity-2026', outletId: 'variety', publishDate: PRECISE },
    { showId: 'paranormal-activity-2026', outletId: 'vulture', publishDate: PRECISE },
    { showId: 'paranormal-activity-2026', outletId: 'ew', publishDate: PRECISE },
    // Same instant, DIFFERENT show — not evidence of bleed within a show.
    { showId: 'other-show-2026', outletId: 'variety', publishDate: PRECISE },
    // A genuinely unique per-article time must stay trusted.
    { showId: 'paranormal-activity-2026', outletId: 'nytimes', publishDate: '2026-08-25T21:04:11-04:00' },
  ];
  const shared = findSharedPublishTimestamps(rows);
  assert.equal(shared.has(`paranormal-activity-2026|${PRECISE}`), true);
  assert.equal(shared.has(`other-show-2026|${PRECISE}`), false);
  assert.equal(shared.has('paranormal-activity-2026|2026-08-25T21:04:11-04:00'), false);
});

test('a roundup-bled timestamp is rejected as a clock even though it looks precise', () => {
  const shared = findSharedPublishTimestamps([
    { showId: 'paranormal-activity-2026', outletId: 'variety', publishDate: PRECISE },
    { showId: 'paranormal-activity-2026', outletId: 'vulture', publishDate: PRECISE },
  ]);
  const m = classifyMeasurability(
    { showId: 'paranormal-activity-2026', outletId: 'variety', publishDate: PRECISE, firstSeenAt: '2026-08-26T02:28:42.418Z' },
    '2026-08-14',
    shared,
  );
  assert.equal(m.measurable, false);
  assert.equal(m.reason, 'shared-roundup-timestamp');
});

test('computeSla never reports a fabricated 0% from clockless rows', () => {
  // Exactly the shape that produced the long-standing "SLA: 0%": every row scored
  // promptly, none with a usable clock.
  const rows = [
    { showId: 'x', outletId: 'nytimes', tier: 1, publishDate: '2026-08-25', firstSeenAt: '2026-08-26T02:28:00Z', scoredAt: '2026-08-26T02:28:00Z', showCreatedAt: '2026-08-14' },
    { showId: 'x', outletId: 'variety', tier: 1, publishDate: '2026-08-25', firstSeenAt: '2026-08-26T02:29:00Z', scoredAt: '2026-08-26T02:29:00Z', showCreatedAt: '2026-08-14' },
  ];
  const sla = computeSla(rows, { withinHours: 24, tierFilter: (t) => t === 1 });
  assert.equal(sla.measured, 0);
  assert.equal(sla.withinSla, 0);
  assert.equal(sla.pct, null, 'pct must be null (n/a), never 0 — 0% asserts a failure we did not observe');
  assert.equal(sla.unmeasurable, 2);
  assert.equal(sla.unmeasurableByReason['date-only-publish-date'], 2);
});

test('computeSla still measures rows that have a real clock', () => {
  const rows = [
    // Published 20:51 ET, scored 22:28 ET the same night → ~1.6h, comfortably inside.
    { showId: 'x', outletId: 'variety', tier: 1, publishDate: PRECISE, firstSeenAt: '2026-08-26T02:28:42Z', scoredAt: '2026-08-26T02:28:42Z', showCreatedAt: '2026-08-14' },
    // Published 20:51 ET, scored three days later → a real breach.
    { showId: 'x', outletId: 'nytimes', tier: 1, publishDate: '2026-08-25T20:51:00-04:00', firstSeenAt: '2026-08-29T02:00:00Z', scoredAt: '2026-08-29T02:00:00Z', showCreatedAt: '2026-08-14' },
  ];
  const sla = computeSla(rows, { withinHours: 24, tierFilter: (t) => t === 1 });
  assert.equal(sla.measured, 2);
  assert.equal(sla.withinSla, 1);
  assert.equal(sla.pct, 50);
});

test('contamination is detected across tiers, not just within the reported tier', () => {
  // A T3 blog sharing the instant is what proves the T1 stamp came off a roundup page.
  // Narrowing to tier 1 before the scan would hide exactly that evidence.
  const rows = [
    { showId: 'x', outletId: 'variety', tier: 1, publishDate: PRECISE, firstSeenAt: '2026-08-26T02:28:42Z', scoredAt: '2026-08-26T02:28:42Z', showCreatedAt: '2026-08-14' },
    { showId: 'x', outletId: 'someblog', tier: 3, publishDate: PRECISE, firstSeenAt: '2026-08-26T02:28:42Z', scoredAt: '2026-08-26T02:28:42Z', showCreatedAt: '2026-08-14' },
  ];
  const sla = computeSla(rows, { withinHours: 24, tierFilter: (t) => t === 1 });
  assert.equal(sla.measured, 0);
  assert.equal(sla.unmeasurableByReason['shared-roundup-timestamp'], 1);
});
