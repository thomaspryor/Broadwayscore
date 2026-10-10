/**
 * health-check-hours-ago.test.mjs — BRO-3349 prevent-class guard.
 *
 * The provider-spend-ledger false alarm (see
 * provider-spend-ledger-freshness-row.test.mjs) was one instance of a class:
 * health-check.js's hoursAgo() fed to `new Date()` a value that may be a BARE
 * "YYYY-MM-DD", which resolves to that day's MIDNIGHT — its start — so the
 * reported age is inflated by up to 24h. Two live FRESHNESS_CHECKS fields are
 * day-shaped (data/cast-changes.json's `lastUpdated`, data/commercial.json's
 * `_meta.lastUpdated`); cast-changes has a 72h warn bar and a Wed+Sat writer,
 * so a Saturday write checked on Tuesday read 83h against a true 59h.
 *
 * These tests require() the REAL exported hoursAgo (CLAUDE.md §15) and also
 * assert the invariant against the REAL data files, so a producer that starts
 * emitting a bare day into a tight-threshold check is covered automatically.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { hoursAgo } = require('../health-check.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = new Date('2026-09-22T11:39:00Z').getTime();

test('BRO-3349: a bare YYYY-MM-DD is measured from the END of that day, not its start', () => {
  // 2026-09-20T23:59:59.999Z -> 2026-09-22T11:39:00Z is 35.65h.
  const age = hoursAgo('2026-09-20', NOW);
  assert.ok(Math.abs(age - 35.65) < 0.02, `expected ~35.65h, got ${age}`);
  // The pre-fix start-of-day reading was 59.65h — a full extra day.
  assert.ok((NOW - new Date('2026-09-20').getTime()) / 3600000 - age > 23.9,
    'regression guard: start-of-day math on this same input is ~24h older');
});

test('BRO-3349: a bare day is never reported as older than it can possibly be', () => {
  // Written at ANY instant during 2026-09-20, the file is at most this old.
  const latestPossibleAge = (NOW - new Date('2026-09-20T00:00:00Z').getTime()) / 3600000;
  const earliestPossibleAge = (NOW - new Date('2026-09-21T00:00:00Z').getTime()) / 3600000;
  const age = hoursAgo('2026-09-20', NOW);
  assert.ok(age <= latestPossibleAge, 'must not over-report (that is what caused the false alarm)');
  assert.ok(age >= earliestPossibleAge, 'must not under-report past the end of the day either');
});

test('BRO-3349: full ISO timestamps are untouched', () => {
  const iso = '2026-09-22T09:45:33.929Z';
  assert.equal(hoursAgo(iso, NOW), (NOW - new Date(iso).getTime()) / 3600000);
});

test('BRO-3349: unparseable values are still Infinity (maximally stale, never "fresh by default")', () => {
  for (const bad of ['zzz', '', null, undefined, '2026-99-99']) {
    assert.equal(hoursAgo(bad, NOW), Infinity, `expected Infinity for ${JSON.stringify(bad)}`);
  }
});

test('BRO-3349: every day-shaped FRESHNESS_CHECKS field in the REAL data reads as its true age', () => {
  // Reads the live data files rather than a fixture: if a producer starts
  // emitting a bare day into a tight-threshold check, this covers it with no
  // edit here (the cast-changes.json case that motivated the fix).
  const fields = [
    ['cast-changes.json', ['lastUpdated']],
    ['commercial.json', ['_meta', 'lastUpdated']],
    ['reviews.json', ['_meta', 'lastUpdated']],
    ['shows.json', ['_meta', 'lastUpdated']],
  ];
  let checked = 0;
  for (const [file, keyPath] of fields) {
    const p = path.join(REPO, 'data', file);
    if (!fs.existsSync(p)) continue;
    let value;
    try { value = keyPath.reduce((o, k) => o && o[k], JSON.parse(fs.readFileSync(p, 'utf8'))); } catch { continue; }
    if (typeof value !== 'string') continue;
    checked++;
    const age = hoursAgo(value, NOW);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) continue;
    const latestPossible = (NOW - new Date(`${value}T00:00:00Z`).getTime()) / 3600000;
    assert.ok(age <= latestPossible,
      `${file}:${keyPath.join('.')} = "${value}" reported ${age.toFixed(1)}h old, but it cannot be older than ${latestPossible.toFixed(1)}h`);
  }
  assert.ok(checked > 0, 'expected at least one real data file to be present to check');
});
