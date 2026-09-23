// Pure I/O tests for scripts/lib/linear-gate-bypass-ledger.js (BRO-3435).
// Uses a real temp file — this module's whole job is disk I/O, so a mock
// filesystem would test nothing the module doesn't already assert about
// itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { appendBypassRow, readBypassRows } = require('./linear-gate-bypass-ledger.js');

function tmpLedgerPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-bypass-')), 'ledger.jsonl');
}

test('appendBypassRow creates the file and directory on first write', () => {
  const p = tmpLedgerPath();
  assert.equal(fs.existsSync(p), false);
  appendBypassRow({ identifier: 'BRO-1', gate: 'done', mechanism: 'force', reason: 'a real reason here' }, p);
  assert.equal(fs.existsSync(p), true);
});

test('appendBypassRow records the shape readBypassRows expects back', () => {
  const p = tmpLedgerPath();
  appendBypassRow(
    { identifier: 'BRO-2', gate: 'done', mechanism: 'force', reason: 'skipping verify, already checked by hand' },
    p
  );
  const [row] = readBypassRows(p);
  assert.equal(row.identifier, 'BRO-2');
  assert.equal(row.gate, 'done');
  assert.equal(row.mechanism, 'force');
  assert.equal(row.reason, 'skipping verify, already checked by hand');
  assert.equal(typeof row.at, 'string');
  assert.ok(!Number.isNaN(Date.parse(row.at)), 'at must be a parseable ISO timestamp');
});

test('appendBypassRow: env-disabled mechanism carries no reason', () => {
  const p = tmpLedgerPath();
  appendBypassRow({ identifier: 'BRO-3', gate: 'cancel', mechanism: 'env-disabled', targetState: 'Canceled' }, p);
  const [row] = readBypassRows(p);
  assert.equal(row.mechanism, 'env-disabled');
  assert.equal(row.reason, null);
  assert.equal(row.targetState, 'Canceled');
});

test('multiple appends interleave as separate readable rows, oldest first', () => {
  const p = tmpLedgerPath();
  appendBypassRow({ identifier: 'BRO-4', gate: 'done', mechanism: 'force', reason: 'first bypass reason here' }, p);
  appendBypassRow({ identifier: 'BRO-5', gate: 'done', mechanism: 'force', reason: 'second bypass reason here' }, p);
  const rows = readBypassRows(p);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].identifier, 'BRO-4');
  assert.equal(rows[1].identifier, 'BRO-5');
});

test('readBypassRows on a missing file returns an empty array, not a throw', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-bypass-')), 'never-written.jsonl');
  assert.deepEqual(readBypassRows(p), []);
});

test('readBypassRows tolerates a torn line without losing the well-formed rows around it', () => {
  const p = tmpLedgerPath();
  appendBypassRow({ identifier: 'BRO-6', gate: 'done', mechanism: 'force', reason: 'valid reason before the tear' }, p);
  fs.appendFileSync(p, '{"identifier":"BRO-7","gate":"done"\n'); // torn mid-write
  appendBypassRow({ identifier: 'BRO-8', gate: 'done', mechanism: 'force', reason: 'valid reason after the tear' }, p);
  const rows = readBypassRows(p);
  assert.deepEqual(
    rows.map((r) => r.identifier),
    ['BRO-6', 'BRO-8']
  );
});
