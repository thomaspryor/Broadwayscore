// S4-T5 (2026 data audit, BRO-4204): the shared per-source last-success
// marker helper (scripts/lib/source-last-success.js) that the OLT,
// Theatremonkey and Lortel parse sites require(). Exercises the REAL
// functions (CLAUDE.md §15) against a scratch dir so nothing under
// data/audit/ is touched, then checks the three call sites are wired.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');
const {
  DEFAULT_EMPTY_STREAK_THRESHOLD,
  markerPath,
  readLastSuccess,
  writeLastSuccess,
  recordEmptyParse,
  emptyStreakWarning,
  recordParseResult,
} = require('../../scripts/lib/source-last-success.js');

function scratchDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'source-last-success-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('threshold is three consecutive empty parses (S4-T5)', () => {
  assert.equal(DEFAULT_EMPTY_STREAK_THRESHOLD, 3);
});

test('writeLastSuccess writes {source, at, count, emptyStreak: 0} to <dir>/<source>-last-success.json', (t) => {
  const dir = scratchDir(t);
  const marker = writeLastSuccess('olt', 98, { dir, now: '2026-09-28T22:00:00.000Z' });
  assert.deepEqual(marker, { source: 'olt', at: '2026-09-28T22:00:00.000Z', count: 98, emptyStreak: 0, lastEmptyAt: null });
  const file = markerPath('olt', { dir });
  assert.equal(file, join(dir, 'olt-last-success.json'));
  assert.ok(existsSync(file));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), marker);
  assert.deepEqual(readLastSuccess('olt', { dir }), marker);
});

test('writeLastSuccess: `now` accepts a Date; count must be a non-negative number', (t) => {
  const dir = scratchDir(t);
  const marker = writeLastSuccess('theatremonkey', 12, { dir, now: new Date('2026-01-02T03:04:05.000Z') });
  assert.equal(marker.at, '2026-01-02T03:04:05.000Z');
  assert.throws(() => writeLastSuccess('theatremonkey', -1, { dir }), /non-negative/);
  assert.throws(() => writeLastSuccess('theatremonkey', 'lots', { dir }), /non-negative/);
});

test('readLastSuccess: missing file → null, corrupt file → null (never throws)', (t) => {
  const dir = scratchDir(t);
  assert.equal(readLastSuccess('lortel', { dir }), null);
  writeFileSync(join(dir, 'lortel-last-success.json'), '{not json');
  assert.equal(readLastSuccess('lortel', { dir }), null);
  writeFileSync(join(dir, 'lortel-last-success.json'), '[1,2]');
  assert.equal(readLastSuccess('lortel', { dir }), null);
});

test('recordEmptyParse bumps emptyStreak and keeps the last success at/count', (t) => {
  const dir = scratchDir(t);
  writeLastSuccess('olt', 98, { dir, now: '2026-09-20T00:00:00.000Z' });
  const first = recordEmptyParse('olt', { dir, now: '2026-09-21T00:00:00.000Z' });
  assert.deepEqual(first, { source: 'olt', at: '2026-09-20T00:00:00.000Z', count: 98, emptyStreak: 1, lastEmptyAt: '2026-09-21T00:00:00.000Z' });
  const second = recordEmptyParse('olt', { dir, now: '2026-09-22T00:00:00.000Z' });
  assert.equal(second.emptyStreak, 2);
  assert.equal(second.at, '2026-09-20T00:00:00.000Z');
  assert.equal(second.lastEmptyAt, '2026-09-22T00:00:00.000Z');
  assert.deepEqual(readLastSuccess('olt', { dir }), second);
});

test('recordEmptyParse with no prior marker starts at streak 1 with a null last success', (t) => {
  const dir = scratchDir(t);
  const marker = recordEmptyParse('lortel', { dir, now: '2026-09-28T00:00:00.000Z' });
  assert.deepEqual(marker, { source: 'lortel', at: null, count: null, emptyStreak: 1, lastEmptyAt: '2026-09-28T00:00:00.000Z' });
});

test('a non-empty parse after empties resets the streak', (t) => {
  const dir = scratchDir(t);
  recordEmptyParse('olt', { dir });
  recordEmptyParse('olt', { dir });
  const marker = writeLastSuccess('olt', 5, { dir, now: '2026-09-28T00:00:00.000Z' });
  assert.equal(marker.emptyStreak, 0);
  assert.equal(marker.lastEmptyAt, null);
  assert.equal(readLastSuccess('olt', { dir }).emptyStreak, 0);
});

test('emptyStreakWarning: null below the threshold, ::warning:: at and above it, names the last success', () => {
  assert.equal(emptyStreakWarning('olt', 0), null);
  assert.equal(emptyStreakWarning('olt', 2), null);
  const atThreshold = emptyStreakWarning('olt', 3);
  assert.match(atThreshold, /^::warning::olt: 0 entries parsed for 3 consecutive runs \(threshold 3\)/);
  assert.match(atThreshold, /soft-404/);
  assert.match(atThreshold, /no non-empty parse on record/);
  const withLast = emptyStreakWarning('lortel', 7, 3, { at: '2026-05-21T00:00:00.000Z', count: 11 });
  assert.match(withLast, /7 consecutive runs/);
  assert.match(withLast, /last non-empty parse 2026-05-21T00:00:00\.000Z \(11 entries\)/);
  // Custom threshold honoured.
  assert.equal(emptyStreakWarning('olt', 3, 5), null);
  assert.ok(emptyStreakWarning('olt', 5, 5));
});

test('recordParseResult: non-empty → success marker, no warning; empties warn on the third consecutive run', (t) => {
  const dir = scratchDir(t);
  const logged = [];
  const log = (msg) => logged.push(msg);

  const ok = recordParseResult('theatremonkey', 14, { dir, now: '2026-09-25T00:00:00.000Z', log });
  assert.equal(ok.warning, null);
  assert.equal(ok.marker.count, 14);
  assert.equal(ok.marker.emptyStreak, 0);

  const e1 = recordParseResult('theatremonkey', 0, { dir, now: '2026-09-26T00:00:00.000Z', log });
  const e2 = recordParseResult('theatremonkey', 0, { dir, now: '2026-09-27T00:00:00.000Z', log });
  assert.equal(e1.warning, null);
  assert.equal(e2.warning, null);
  assert.deepEqual(logged, []);

  const e3 = recordParseResult('theatremonkey', 0, { dir, now: '2026-09-28T00:00:00.000Z', log });
  assert.equal(e3.marker.emptyStreak, 3);
  assert.match(e3.warning, /^::warning::theatremonkey: 0 entries parsed for 3 consecutive runs/);
  assert.match(e3.warning, /last non-empty parse 2026-09-25T00:00:00\.000Z \(14 entries\)/);
  assert.deepEqual(logged, [e3.warning]);

  // A rejected fetch reports as 0 too — undefined/NaN counts are empties, not crashes.
  const e4 = recordParseResult('theatremonkey', undefined, { dir, now: '2026-09-29T00:00:00.000Z', log });
  assert.equal(e4.marker.emptyStreak, 4);
  assert.equal(logged.length, 2);

  // The marker on disk is the streak's source of truth across processes.
  assert.equal(readLastSuccess('theatremonkey', { dir }).emptyStreak, 4);
});

test('markerPath rejects anything that is not a plain source slug', () => {
  assert.throws(() => markerPath('https://lortel.org/currently-playing/'), /invalid source id/);
  assert.throws(() => markerPath('Official London Theatre'), /invalid source id/);
  assert.throws(() => markerPath(''), /invalid source id/);
  assert.throws(() => markerPath(undefined), /invalid source id/);
  assert.match(markerPath('playbill-ob'), /playbill-ob-last-success\.json$/);
});

test('default marker dir is data/audit/ (SOURCE_LAST_SUCCESS_DIR overrides it)', () => {
  const prev = process.env.SOURCE_LAST_SUCCESS_DIR;
  delete process.env.SOURCE_LAST_SUCCESS_DIR;
  try {
    assert.equal(markerPath('olt'), join(ROOT, 'data', 'audit', 'olt-last-success.json'));
    process.env.SOURCE_LAST_SUCCESS_DIR = '/tmp/some-scratch';
    assert.equal(markerPath('olt'), join('/tmp/some-scratch', 'olt-last-success.json'));
  } finally {
    if (prev === undefined) delete process.env.SOURCE_LAST_SUCCESS_DIR;
    else process.env.SOURCE_LAST_SUCCESS_DIR = prev;
  }
});

test('the three S4-T5 sources record through the shared helper (wiring, §15)', () => {
  const discover = readFileSync(join(ROOT, 'scripts', 'discover-new-shows.js'), 'utf8');
  assert.match(discover, /require\(['"]\.\/lib\/source-last-success['"]\)/, 'discover-new-shows.js must require() the helper');
  assert.match(discover, /recordParseResult\('olt',\s*oltShows\.length\)/, 'OLT marker written from the parsed candidate count');
  assert.match(discover, /recordParseResult\('theatremonkey',\s*tmShows\.length\)/, 'Theatremonkey marker written from the parsed candidate count');

  const promote = readFileSync(join(ROOT, 'scripts', 'promote-ob-venue-candidates.js'), 'utf8');
  assert.match(promote, /require\(['"]\.\/lib\/source-last-success['"]\)/, 'promote-ob-venue-candidates.js must require() the helper');
  assert.match(promote, /recordParseResult\('lortel',\s*lortelEntries\.length\)/, 'Lortel marker written after the cross-validation fetch');
});
