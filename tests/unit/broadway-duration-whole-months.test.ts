/**
 * getBroadwayDuration counts whole months elapsed. It used to subtract month
 * numbers, so a tour that launched Sept 19 read "1 month on tour" on Oct 4
 * (BRO-4601). Calls the real exported function (CLAUDE.md rule 15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getBroadwayDuration } from '../../src/lib/date-utils';

function at(now: string, fn: () => void) {
  test.mock.timers.enable({ apis: ['Date'], now: new Date(now) });
  try { fn(); } finally { test.mock.timers.reset(); }
}

test('15 days in is "Just opened", not "1 month"', () => {
  at('2026-10-04T12:00:00Z', () => assert.equal(getBroadwayDuration('2026-09-19', 'on tour'), 'Just opened'));
});

test('a month is reached on the same day of the next month', () => {
  at('2026-10-19T12:00:00Z', () => assert.equal(getBroadwayDuration('2026-09-19', 'on tour'), '1 month on tour'));
  at('2026-10-18T12:00:00Z', () => assert.equal(getBroadwayDuration('2026-09-19', 'on tour'), 'Just opened'));
});

test('years still roll over on whole months', () => {
  at('2026-10-04T12:00:00Z', () => assert.equal(getBroadwayDuration('2024-09-26'), '2 years on Broadway'));
  at('2026-10-04T12:00:00Z', () => assert.equal(getBroadwayDuration('2025-10-01'), '1 year on Broadway'));
  at('2026-10-04T12:00:00Z', () => assert.equal(getBroadwayDuration('2024-08-01'), '2+ years on Broadway'));
});
