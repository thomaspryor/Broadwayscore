// BRO-7139: freshness alarm for the report-only board-dispatch ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { evaluateBoardDispatchFreshness, lastCiRow, BOARD_DISPATCH_FRESHNESS_ROW, FIRST_ROW_DUE } = require('./board-dispatch-freshness.js');
const { checkBoardDispatchFreshness, getPlaybookEntry } = require('../health-check.js');

const NOW = Date.parse('2026-11-08T12:00:00Z');
const at = (h) => new Date(NOW - h * 3600e3).toISOString();
const row = (o) => JSON.stringify({ v: 1, mode: 'report-only', ...o });

const LATER = Date.parse(FIRST_ROW_DUE) + 3600e3;
test('missing ledger passes before the first row is due, errors after', () => {
  assert.equal(evaluateBoardDispatchFreshness({ ledgerText: null, nowMs: NOW }).status, 'pass');
  assert.equal(evaluateBoardDispatchFreshness({ ledgerText: null, nowMs: LATER }).status, 'error');
});
test('only local rows count as no row (hand runs do not hide a dead cron)', () => {
  const t = row({ ts: new Date(LATER - 3600e3).toISOString(), source: 'local' });
  assert.equal(evaluateBoardDispatchFreshness({ ledgerText: t, nowMs: LATER }).status, 'error');
});
test('fresh ci row passes, even with a newer local row after it', () => {
  const t = [row({ ts: at(20), source: 'ci' }), row({ ts: at(1), source: 'local' })].join('\n') + '\n';
  const r = evaluateBoardDispatchFreshness({ ledgerText: t, nowMs: NOW });
  assert.equal(r.status, 'pass');
  assert.equal(r.name, BOARD_DISPATCH_FRESHNESS_ROW);
});
test('37h warns, 61h errors', () => {
  assert.equal(evaluateBoardDispatchFreshness({ ledgerText: row({ ts: at(37), source: 'ci' }), nowMs: NOW }).status, 'warn');
  assert.equal(evaluateBoardDispatchFreshness({ ledgerText: row({ ts: at(61), source: 'ci' }), nowMs: NOW }).status, 'error');
});
test('disabled passes regardless of age', () => {
  assert.equal(evaluateBoardDispatchFreshness({ ledgerText: null, nowMs: NOW, disabled: true }).status, 'pass');
});
test('bad JSON lines are skipped', () => {
  const t = row({ ts: at(5), source: 'ci' }) + '\n{not json\n\n';
  assert.equal(lastCiRow(t).ts, at(5));
});
test('fresh error row (as board-dispatch.js writes it) warns', () => {
  const r = evaluateBoardDispatchFreshness({ ledgerText: row({ ts: at(2), source: 'ci', error: 'Linear 500' }), nowMs: NOW });
  assert.equal(r.status, 'warn');
  assert.match(r.message, /Linear 500/);
});
test('unparseable ts errors', () => {
  assert.equal(evaluateBoardDispatchFreshness({ ledgerText: row({ ts: 'nope', source: 'ci' }), nowMs: NOW }).status, 'error');
});
test('health-check wrapper reads the file and the kill switch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdf-'));
  const p = path.join(dir, 'board-dispatch.jsonl');
  assert.equal(checkBoardDispatchFreshness({ ledgerPath: p, now: LATER, env: {} })[0].status, 'error');
  fs.writeFileSync(p, row({ ts: at(3), source: 'ci' }) + '\n');
  assert.equal(checkBoardDispatchFreshness({ ledgerPath: p, now: NOW, env: {} })[0].status, 'pass');
  fs.writeFileSync(p, row({ ts: at(100), source: 'ci' }) + '\n');
  assert.equal(checkBoardDispatchFreshness({ ledgerPath: p, now: NOW, env: { BOARD_DISPATCH_DISABLED: 'true' } })[0].status, 'pass');
});
test('playbook routes the row to a this-week human action', () => {
  const e = getPlaybookEntry(BOARD_DISPATCH_FRESHNESS_ROW);
  assert.ok(e, 'playbook entry exists');
  assert.equal(e.urgency, 'this-week');
  assert.ok(e.humanAction);
});
