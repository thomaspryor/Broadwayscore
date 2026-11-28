// BRO-8268: weekly report prices Browserbase from billed daily records, not sessions x $0.10.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { weekCost, windowDays } = require('../../scripts/lib/browserbase-week-cost.js');

const NOW = new Date('2026-11-24T14:00:00Z');
const row = (day, cost, status = 'ok', minutes = 60) => JSON.stringify({ day, providers: { browserbase: { status, cost, sessions: 100, minutes } } });
const oldRow = (day, cost) => JSON.stringify({ day, providers: { browserbase: { status: 'ok', cost, sessions: 100 } } });

test('window is the 7 complete UTC days before now', () => {
  assert.deepEqual(windowDays(NOW), ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23']);
});

test('sums billed days in the window, ignores days outside it', () => {
  const text = [row('2026-11-16', 99), ...windowDays(NOW).map(d => row(d, 1)), row('2026-11-24', 99)].join('\n');
  assert.deepEqual(weekCost(text, { sessions: 971, now: NOW }), { cost: 7, source: 'billed', days: 7 });
});

test('scales up when a day or two is missing', () => {
  const text = windowDays(NOW).slice(0, 6).map(d => row(d, 1)).join('\n');
  assert.deepEqual(weekCost(text, { sessions: 971, now: NOW }), { cost: 7, source: 'billed', days: 6 });
});

test('falls back to the labelled $0.10/session estimate when billed data is thin, broken or missing', () => {
  const thin = windowDays(NOW).slice(0, 4).map(d => row(d, 1)).join('\n');
  assert.deepEqual(weekCost(thin, { sessions: 971, now: NOW }), { cost: 97.1, source: 'estimate', days: 4 });
  const errored = windowDays(NOW).map(d => row(d, 1, 'error')).join('\n') + '\nnot json\n';
  assert.equal(weekCost(errored, { sessions: 10, now: NOW }).source, 'estimate');
  assert.deepEqual(weekCost('', { sessions: 'junk', now: NOW }), { cost: 0, source: 'estimate', days: 0 });
});

test('a real spike still shows: billed overage passes the $50 alert line', () => {
  const text = windowDays(NOW).map(d => row(d, 12.5)).join('\n');
  assert.ok(weekCost(text, { now: NOW }).cost > 50);
});

test('CLI prints cost|source|days, missing file falls back', () => {
  const f = path.join(os.tmpdir(), `bbwc-${process.pid}.jsonl`);
  fs.writeFileSync(f, windowDays(new Date()).map(d => row(d, 0.8)).join('\n'));
  try {
    const out = execFileSync('node', ['scripts/lib/browserbase-week-cost.js', '--sessions=971', `--file=${f}`], { encoding: 'utf8' }).trim();
    assert.equal(out, '5.60|billed|7');
  } finally { fs.unlinkSync(f); }
  const miss = execFileSync('node', ['scripts/lib/browserbase-week-cost.js', '--sessions=971', '--file=/nonexistent'], { encoding: 'utf8' }).trim();
  assert.equal(miss, '97.10|estimate|0');
});

test('pre-BRO-3240 rows (no minutes, cost = sessions x $0.10) are not counted as billed', () => {
  const text = windowDays(NOW).map(d => oldRow(d, 15)).join('\n');
  assert.equal(weekCost(text, { sessions: 971, now: NOW }).source, 'estimate');
});
