import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { parseLedger, decideCooldown, shouldAlertStale, appendRow, readLedger } = require('./reddit-dispatch-cooldown.js');

const H = 3600000;
const NOW = Date.parse('2026-10-22T12:00:00Z');
const row = (hoursAgo, outcome) => ({ ts: new Date(NOW - hoursAgo * H).toISOString(), outcome });

test('empty or healthy ledger never skips', () => {
  assert.equal(decideCooldown([], NOW).skip, false);
  assert.equal(decideCooldown([row(5, 'unavailable'), row(2, 'ok')], NOW).skip, false);
});

test('below threshold does not skip', () => {
  const d = decideCooldown([row(3, 'unavailable'), row(2, 'unavailable')], NOW);
  assert.equal(d.skip, false);
  assert.equal(d.consecutiveUnavailable, 2);
});

test('3 consecutive unavailable runs skip while recent (the BRO-5916 case)', () => {
  const rows = [row(4, 'unavailable'), row(3, 'unavailable'), row(1, 'unavailable')];
  const d = decideCooldown(rows, NOW);
  assert.equal(d.skip, true);
  assert.match(d.reason, /cooldown/);
});

test('cooldown lets a probe through after probeAfterHours', () => {
  const rows = [row(30, 'unavailable'), row(20, 'unavailable'), row(7, 'unavailable')];
  assert.equal(decideCooldown(rows, NOW).skip, false);
});

test('first success clears the cooldown', () => {
  const rows = [row(8, 'unavailable'), row(7, 'unavailable'), row(6, 'unavailable'), row(1, 'ok')];
  assert.equal(decideCooldown(rows, NOW).skip, false);
});

test('alerted rows do not break the unavailable streak', () => {
  const rows = [row(4, 'unavailable'), row(3, 'unavailable'), row(2, 'alerted'), row(1, 'unavailable')];
  assert.equal(decideCooldown(rows, NOW).skip, true);
});

test('stale alert fires once after 48h without success', () => {
  const rows = [row(60, 'ok'), row(40, 'unavailable'), row(10, 'unavailable')];
  assert.equal(shouldAlertStale(rows, NOW).alert, true);
  assert.equal(shouldAlertStale([...rows, row(1, 'alerted')], NOW).alert, false);
});

test('no stale alert under 48h, or when last run was fine', () => {
  assert.equal(shouldAlertStale([row(40, 'ok'), row(10, 'unavailable')], NOW).alert, false);
  assert.equal(shouldAlertStale([row(100, 'ok')], NOW).alert, false);
  assert.equal(shouldAlertStale([], NOW).alert, false);
});

test('a new outage after a success re-arms the alert', () => {
  const rows = [row(200, 'unavailable'), row(190, 'alerted'), row(100, 'ok'), row(60, 'unavailable')];
  assert.equal(shouldAlertStale(rows, NOW).alert, true);
});

test('ledger round-trips and ignores corrupt lines', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rcd-')), 'l.jsonl');
  appendRow(row(2, 'unavailable'), f);
  fs.appendFileSync(f, 'not json\n{"ts":"bad","outcome":"ok"}\n');
  appendRow(row(1, 'ok'), f);
  assert.equal(readLedger(f).length, 2);
  assert.equal(parseLedger('').length, 0);
});
