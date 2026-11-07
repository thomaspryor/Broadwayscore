/**
 * BRO-395: data/audit/dispatch-ledger.jsonl carried future-dated 'launch'
 * rows for taskId 1233 (up to 2026-10-01, ~45 days ahead of the wall clock
 * when found). Every `now - t < window` freshness idiom in this codebase is
 * defeated by a future ts — `now - t` is negative, always < any positive
 * window, so the row reads as "recent" forever. This is exactly what gave
 * the overnight P1 backstop check three consecutive false "still alive"
 * readings while the real dispatch flow had gone silent.
 *
 * Requires the real scripts/lib/dispatch-ledger.js functions (CLAUDE.md rule
 * 15) — this file proves the fix, it does not reimplement the logic.
 *
 * Run: node --test tests/unit/ledger-future-timestamp.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { appendEntry, countRecentLaunches } = require('../../scripts/lib/dispatch-ledger.js');

function tmpLedger() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-future-ts-test-')), 'ledger.jsonl');
}

test('countRecentLaunches never counts a future-dated launch entry as recent, however wide the window', () => {
  const now = Date.parse('2026-08-26T12:00:00.000Z');
  const futureTs = new Date(now + 45 * 24 * 60 * 60 * 1000).toISOString(); // ~the real incident's 2026-10-01 shape
  const entries = [
    { event: 'launch', taskId: '1233', ts: futureTs },
  ];
  assert.equal(
    countRecentLaunches(entries, { now, windowMs: 45 * 60 * 1000 }),
    0,
    'a future-dated row must not count as recent inside a normal window'
  );
  assert.equal(
    countRecentLaunches(entries, { now, windowMs: 365 * 24 * 60 * 60 * 1000 }),
    0,
    'nor inside a window wide enough that only the missing upper bound could rescue it'
  );
});

test('countRecentLaunches still counts a genuinely recent launch alongside a future-dated one', () => {
  const now = Date.parse('2026-08-26T12:00:00.000Z');
  const futureTs = new Date(now + 45 * 24 * 60 * 60 * 1000).toISOString();
  const recentTs = new Date(now - 10 * 60 * 1000).toISOString();
  const entries = [
    { event: 'launch', taskId: '1233', ts: futureTs },
    { event: 'launch', taskId: '1234', ts: recentTs },
  ];
  assert.equal(countRecentLaunches(entries, { now, windowMs: 45 * 60 * 1000 }), 1);
});

test('appendEntry rejects a future-dated ts at the append boundary instead of storing it silently', () => {
  const ledgerPath = tmpLedger();
  const futureTs = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString();
  assert.throws(
    () => appendEntry({ event: 'launch', taskId: '1233', ts: futureTs }, ledgerPath),
    /future ts/,
    'the append path must fail loudly on corrupt future-dated input'
  );
  assert.equal(
    fs.existsSync(ledgerPath),
    false,
    'a rejected entry must leave no row in the ledger — nothing downstream can be poisoned by it'
  );
});
