import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isFrozen, readFreezeRecord, isLedgerFrozenNow } = require('../freeze-ledgers.js');

const LEDGER = 'data/audit/arm-yield-ledger.jsonl';
const OTHER_LEDGER = 'data/audit/dispatch-ledger.jsonl';

const RECORD = {
  frozenAt: '2026-08-26',
  thawAt: '2026-09-25',
  ledgers: [LEDGER, OTHER_LEDGER],
};

const ms = (iso) => Date.parse(iso);

test('isFrozen: before frozenAt is not frozen', () => {
  assert.equal(isFrozen(LEDGER, ms('2026-08-25T23:59:59Z'), RECORD), false);
});

test('isFrozen: exactly on frozenAt is frozen', () => {
  assert.equal(isFrozen(LEDGER, ms('2026-08-26T00:00:00Z'), RECORD), true);
});

test('isFrozen: mid-window is frozen', () => {
  assert.equal(isFrozen(LEDGER, ms('2026-09-10T12:00:00Z'), RECORD), true);
});

test('isFrozen: exactly on thawAt is NOT frozen (thaw boundary exclusive)', () => {
  assert.equal(isFrozen(LEDGER, ms('2026-09-25T00:00:00Z'), RECORD), false);
});

test('isFrozen: after thawAt is not frozen', () => {
  assert.equal(isFrozen(LEDGER, ms('2026-09-26T00:00:00Z'), RECORD), false);
});

test('isFrozen: a ledger not named in the record is never frozen, even mid-window', () => {
  assert.equal(isFrozen('data/audit/some-other-ledger.jsonl', ms('2026-09-10T00:00:00Z'), RECORD), false);
});

test('isFrozen: null freeze record is fail-open (not frozen)', () => {
  assert.equal(isFrozen(LEDGER, ms('2026-09-10T00:00:00Z'), null), false);
});

test('isFrozen: freeze record missing a ledgers array is fail-open', () => {
  assert.equal(isFrozen(LEDGER, ms('2026-09-10T00:00:00Z'), { frozenAt: '2026-08-26', thawAt: '2026-09-25' }), false);
});

test('isFrozen: malformed date strings are fail-open, not a thrown/NaN comparison', () => {
  const bad = { frozenAt: 'not-a-date', thawAt: '2026-09-25', ledgers: [LEDGER] };
  assert.equal(isFrozen(LEDGER, ms('2026-09-10T00:00:00Z'), bad), false);
});

test('isFrozen: a genuine Date-derived epoch number (the real isLedgerFrozenNow call shape) still resolves correctly', () => {
  // Regression guard for the plan-review finding: passing a Date object
  // (instead of Date.getTime()) against string bounds silently evaluates to
  // false via NaN. isLedgerFrozenNow must hand isFrozen a number, not a Date.
  const nowMs = new Date('2026-09-01T12:00:00Z').getTime();
  assert.equal(typeof nowMs, 'number');
  assert.equal(isFrozen(LEDGER, nowMs, RECORD), true);
});

test('readFreezeRecord: returns null for a missing file', () => {
  assert.equal(readFreezeRecord(path.join(os.tmpdir(), 'bro-2603-does-not-exist.json')), null);
});

test('readFreezeRecord: returns null for unparseable JSON', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2603-')), 'bad.json');
  fs.writeFileSync(tmp, '{not json');
  assert.equal(readFreezeRecord(tmp), null);
});

test('readFreezeRecord: parses a real freeze record file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2603-'));
  const tmp = path.join(dir, 'freeze.json');
  fs.writeFileSync(tmp, JSON.stringify(RECORD));
  assert.deepEqual(readFreezeRecord(tmp), RECORD);
});

test('isLedgerFrozenNow: both directions against a real record file, using the real current clock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2603-'));
  const tmp = path.join(dir, 'freeze.json');

  // Window covering "now" -> frozen.
  const openWindow = {
    frozenAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    thawAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    ledgers: [LEDGER],
  };
  fs.writeFileSync(tmp, JSON.stringify(openWindow));
  assert.equal(isLedgerFrozenNow(LEDGER, tmp), true);
  assert.equal(isLedgerFrozenNow(OTHER_LEDGER, tmp), false, 'ledger not in this window\'s list stays unfrozen');

  // Window that already thawed -> not frozen.
  const closedWindow = {
    frozenAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    thawAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    ledgers: [LEDGER],
  };
  fs.writeFileSync(tmp, JSON.stringify(closedWindow));
  assert.equal(isLedgerFrozenNow(LEDGER, tmp), false);
});
