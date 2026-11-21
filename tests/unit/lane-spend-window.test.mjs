import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { paidCallsInWindow, isPaidCall, parseLedger } = require('../../scripts/lib/lane-spend-window.js');
const { main } = require('../../scripts/lane-preembargo-spend-check.js');

const W = 'Opening-night lane (live)';
const row = (ts, extra = {}) => ({ ts, provider: 'scrapingbee', workflow: W, fn: 'fetch', success: true, credits: 5, showId: 's', ...extra });

test('only paid lane calls inside [from, to) count', () => {
  const rows = [
    row('2026-11-10T01:00:00Z'), // paid, inside
    row('2026-11-10T03:00:00Z'), // at `to`: outside
    row('2026-11-10T02:00:00Z', { workflow: 'Gather Review Data' }), // not the lane
    row('2026-11-10T02:00:00Z', { fn: 'run-memo-skip' }), // free
    row('2026-11-10T02:00:00Z', { success: false, credits: 0 }), // free failure
  ];
  const r = paidCallsInWindow(rows, { from: '2026-11-10T00:00:00Z', to: '2026-11-10T03:00:00Z' });
  assert.equal(r.paid.length, 1);
  assert.equal(r.credits, 5);
  assert.deepEqual(r.byProvider, { scrapingbee: 5 });
  assert.equal(isPaidCall(rows[3]), false);
});

test('showId filter, corrupt lines skipped, bad window throws', () => {
  const rows = parseLedger(`${JSON.stringify(row('2026-11-10T01:00:00Z', { showId: 'a' }))}\n{broken\n${JSON.stringify(row('2026-11-10T01:00:00Z', { showId: 'b' }))}\n`);
  assert.equal(rows.length, 2);
  assert.equal(paidCallsInWindow(rows, { from: '2026-11-10T00:00:00Z', to: '2026-11-10T02:00:00Z', showId: 'a' }).paid.length, 1);
  assert.throws(() => paidCallsInWindow(rows, { from: '2026-11-10T02:00:00Z', to: '2026-11-10T01:00:00Z' }));
});

test('CLI exits 1 on a paid call in the window, 0 when clean, 2 on bad usage', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spend-')), 'l.jsonl');
  fs.writeFileSync(f, `${JSON.stringify(row('2026-11-10T01:00:00Z'))}\n`);
  const log = console.log; const err = console.error; console.log = () => {}; console.error = () => {};
  try {
    assert.equal(main(['--from=2026-11-10T00:00:00Z', '--to=2026-11-10T02:00:00Z', `--ledger=${f}`]), 1);
    assert.equal(main(['--from=2026-11-10T02:00:00Z', '--to=2026-11-10T03:00:00Z', `--ledger=${f}`]), 0);
    assert.equal(main([]), 2);
  } finally { console.log = log; console.error = err; }
});
