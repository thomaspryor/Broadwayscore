/**
 * check-provider-spend.test.mjs — colocated tests for the freshness/
 * continuity guard (BRO-3227) added to check-provider-spend.js.
 *
 * require()s the real functions (CLAUDE.md §15) rather than reimplementing
 * the date math here — a regression to the guard itself fails this test, not
 * just a copy of its logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ledgerFreshnessHours, missingLedgerDays, STALE_HOURS_THRESHOLD, CONTINUITY_WINDOW_DAYS,
} = require('./check-provider-spend.js');

test('STALE_HOURS_THRESHOLD is 48h (the acceptance-criteria value)', () => {
  assert.equal(STALE_HOURS_THRESHOLD, 48);
});

test('ledgerFreshnessHours: empty ledger is maximally stale (Infinity)', () => {
  assert.equal(ledgerFreshnessHours([], new Date('2026-09-20T06:45:00Z')), Infinity);
});

test('ledgerFreshnessHours: entry for yesterday is fresh (well under 48h)', () => {
  const now = new Date('2026-09-20T06:45:00Z');
  const hours = ledgerFreshnessHours([{ day: '2026-09-19' }], now);
  assert.ok(hours < STALE_HOURS_THRESHOLD, `expected < ${STALE_HOURS_THRESHOLD}h, got ${hours}`);
  assert.ok(hours > 0);
});

test('ledgerFreshnessHours: 9-day-old entry (the reported incident) is far past the threshold', () => {
  const now = new Date('2026-09-13T00:00:00Z');
  const hours = ledgerFreshnessHours([{ day: '2026-09-04' }], now);
  assert.ok(hours > STALE_HOURS_THRESHOLD, `expected > ${STALE_HOURS_THRESHOLD}h, got ${hours}`);
});

test('ledgerFreshnessHours: uses the MOST RECENT day, not array order', () => {
  const now = new Date('2026-09-20T06:45:00Z');
  const records = [{ day: '2026-08-01' }, { day: '2026-09-19' }, { day: '2026-09-01' }];
  const hours = ledgerFreshnessHours(records, now);
  assert.ok(hours < STALE_HOURS_THRESHOLD, `expected < ${STALE_HOURS_THRESHOLD}h (from 2026-09-19), got ${hours}`);
});

test('ledgerFreshnessHours: exactly at the 48h boundary is not > threshold', () => {
  // Day ends 2026-09-18T23:59:59.999Z; now = +48h puts us just under the
  // "> 48h" comparator's trip point.
  const now = new Date(new Date('2026-09-18T23:59:59.999Z').getTime() + 48 * 3600000);
  const hours = ledgerFreshnessHours([{ day: '2026-09-18' }], now);
  assert.ok(hours <= STALE_HOURS_THRESHOLD, `expected <= ${STALE_HOURS_THRESHOLD}h, got ${hours}`);
});

test('missingLedgerDays: fully continuous trailing 7 days returns []', () => {
  const now = new Date('2026-09-20T06:45:00Z');
  const records = [];
  for (let i = 1; i <= CONTINUITY_WINDOW_DAYS; i++) {
    records.push({ day: new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10) });
  }
  assert.deepEqual(missingLedgerDays(records, now), []);
});

test('missingLedgerDays: empty ledger is missing all 7 trailing days', () => {
  const now = new Date('2026-09-20T06:45:00Z');
  const missing = missingLedgerDays([], now);
  assert.equal(missing.length, CONTINUITY_WINDOW_DAYS);
});

test('missingLedgerDays: reports exactly the gap days (the reported degraded cadence)', () => {
  const now = new Date('2026-08-31T06:45:00Z');
  // Mirrors BRO-3227's observed gaps: 08-18, 08-23, 08-29, 08-30 present;
  // everything else in the trailing 7-day window (08-24..08-30) absent
  // except 08-29/08-30.
  const records = [
    { day: '2026-08-18' }, { day: '2026-08-23' }, { day: '2026-08-29' }, { day: '2026-08-30' },
  ];
  const missing = missingLedgerDays(records, now);
  assert.deepEqual(missing, ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28']);
});

test('missingLedgerDays: never includes the current (incomplete) day', () => {
  const now = new Date('2026-09-20T06:45:00Z');
  const missing = missingLedgerDays([], now, 1);
  assert.deepEqual(missing, ['2026-09-19']);
});
