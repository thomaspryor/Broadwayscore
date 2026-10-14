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

test('ledgerFreshnessHours: corrupt day values are ignored, not date-parsed into NaN', () => {
  const now = new Date('2026-09-20T06:45:00Z');
  const hours = ledgerFreshnessHours([{ day: 'zzz' }, { day: null }, { day: '2026-09-19' }], now);
  assert.ok(Number.isFinite(hours) && hours > 0, `expected a finite positive number from the one valid day, got ${hours}`);
});

test('ledgerFreshnessHours: all-corrupt ledger is maximally stale (Infinity), not NaN', () => {
  const now = new Date('2026-09-20T06:45:00Z');
  const hours = ledgerFreshnessHours([{ day: 'zzz' }, { day: null }, { day: undefined }], now);
  assert.equal(hours, Infinity);
});

test('ledgerFreshnessHours: a future day (clock skew) reads as fresher, never masks real staleness', () => {
  // Documents intentional behavior (ship-check finding): a future `day` can
  // only ever make freshness look MORE fresh, never less — the safe
  // direction for a staleness alarm to be wrong in (same principle as
  // provider-spend-core.js's BB_OVERAGE pricing comment).
  const now = new Date('2026-09-20T06:45:00Z');
  const hours = ledgerFreshnessHours([{ day: '2026-09-25' }], now);
  assert.ok(hours < 0, 'a future day computes as negative hours-stale, i.e. "fresher than now"');
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
  // i=2..8: the window this function validates (i=1 is DAY, see below).
  for (let i = 2; i <= CONTINUITY_WINDOW_DAYS + 1; i++) {
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
  // Mirrors BRO-3227's observed gaps: 08-18, 08-23, 08-29, 08-30 present.
  // Window (i=2..8, ending 2 days before `now`) is 08-23..08-29.
  const records = [
    { day: '2026-08-18' }, { day: '2026-08-23' }, { day: '2026-08-29' }, { day: '2026-08-30' },
  ];
  const missing = missingLedgerDays(records, now);
  assert.deepEqual(missing, ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28']);
});

test('missingLedgerDays: never flags "today" or "DAY" (yesterday, the day THIS run is about to write)', () => {
  // Regression test for a confirmed bug (Codex adversarial ship-check review,
  // BRO-3227): the window used to start at i=1 ("yesterday" relative to
  // `now`), which is exactly utcYesterday(now) — the day THIS reconciliation
  // run is about to write. Checked pre-write, that day can never be present
  // yet, so every single healthy run reported a false gap. Verified live via
  // `check-provider-spend.js --dry-run` against the real ledger before the
  // fix. The window must start at i=2.
  const now = new Date('2026-09-20T06:45:00Z'); // "today" = 09-20, DAY = 09-19
  const missing = missingLedgerDays([], now, 1);
  assert.deepEqual(missing, ['2026-09-18']);
  assert.ok(!missing.includes('2026-09-19'), 'must never flag DAY (yesterday) as missing pre-write');
  assert.ok(!missing.includes('2026-09-20'), 'must never flag today (incomplete) as missing');
});

test('missingLedgerDays: corrupt day values (non-YYYY-MM-DD) are ignored, not treated as present', () => {
  const now = new Date('2026-09-20T06:45:00Z');
  const records = [{ day: 'zzz' }, { day: null }, { day: '2026-09-18' }];
  const missing = missingLedgerDays(records, now, 1);
  assert.deepEqual(missing, [], '2026-09-18 (the only valid, in-window day) is present');
});

test('missingLedgerDays: duplicate day entries and out-of-order records do not affect the result', () => {
  const now = new Date('2026-09-20T06:45:00Z');
  const records = [
    { day: '2026-09-18' }, { day: '2026-09-16' }, { day: '2026-09-18' }, { day: '2026-09-17' },
  ];
  assert.deepEqual(missingLedgerDays(records, now, 3), []);
});

test('missingLedgerDays: a future day (clock skew / bad --day backfill) cannot fill a real gap', () => {
  const now = new Date('2026-09-20T06:45:00Z');
  const missing = missingLedgerDays([{ day: '2026-09-25' }], now, 1);
  assert.deepEqual(missing, ['2026-09-18'], 'a future record must not be mistaken for the in-window day');
});
