// BRO-7167: observed embargo from exact publish times (grading only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { observedEmbargo } = require('./observed-embargo.js');
const afgm = require('./__fixtures__/observed-embargo/afgm.json');
const rhs = require('./__fixtures__/observed-embargo/rhs.json');
const ms = (s) => Date.parse(s);

test('A Few Good Men: recorded 02:00Z, real lift 03:00Z (later)', () => {
  const r = observedEmbargo({ estimateMs: ms('2026-10-30T02:00:00Z'), publishTimes: afgm });
  assert.equal(r.source, 'observed-cluster');
  assert.equal(r.at, '2026-10-30T03:00:00.000Z');
  assert.equal(r.shiftMin, 60);
  assert.ok(r.n >= 3);
});

test('Rocky Horror: estimated 02:00Z, real lift 01:30Z (earlier, which the lane rule cannot see)', () => {
  const r = observedEmbargo({ estimateMs: ms('2026-04-24T02:00:00Z'), publishTimes: rhs });
  assert.equal(r.at, '2026-04-24T01:30:00.000Z');
  assert.equal(r.shiftMin, -30);
});

test('a lone early post (Talkin Broadway a day early, Culture Sauce 2h early) is not the embargo', () => {
  const rows = [
    { outlet: "Talkin' Broadway", publishedTime: '2026-10-29T02:00:00Z' },
    { outlet: 'Culture Sauce', publishedTime: '2026-10-30T01:00:00Z' },
    ...afgm,
  ];
  assert.equal(observedEmbargo({ estimateMs: ms('2026-10-30T02:00:00Z'), publishTimes: rows }).at, '2026-10-30T03:00:00.000Z');
});

test('one outlet posting several times counts once; zone-less or date-only times are ignored', () => {
  const rows = [
    { outlet: 'A', publishedTime: '2026-05-01T01:00:00Z' }, { outlet: 'A', publishedTime: '2026-05-01T01:01:00Z' },
    { outlet: 'A', publishedTime: '2026-05-01T01:02:00Z' }, { outlet: 'B', publishedTime: '2026-05-01T01:00:00' },
    { outlet: 'C', publishedTime: '2026-05-01' },
  ];
  const r = observedEmbargo({ estimateMs: ms('2026-05-01T02:00:00Z'), publishTimes: rows });
  assert.equal(r.source, 'estimate');
  assert.equal(r.at, '2026-05-01T02:00:00.000Z');
});

test('no estimate and no cluster gives none; off-quarter clusters are not snapped', () => {
  assert.equal(observedEmbargo({ publishTimes: [] }).source, 'none');
  const rows = ['X', 'Y', 'Z'].map((o, i) => ({ outlet: o, publishedTime: `2026-05-01T01:0${7 + i}:00Z` }));
  assert.equal(observedEmbargo({ estimateMs: ms('2026-05-01T02:00:00Z'), publishTimes: rows }).at, '2026-05-01T01:07:00.000Z');
});

test('lane code never loads this helper (would change the lane hash and disarm the lane)', () => {
  const { laneCodeFiles } = require('./opening-night-lane/rehearsal.js');
  const files = laneCodeFiles();
  assert.ok(files.length > 50);
  assert.equal(files.filter((f) => /observed-embargo|test-bench/.test(f)).length, 0);
});

test('an outlet whose second critic posted early still counts in the real cluster', () => {
  const est = Date.parse('2026-10-30T02:00:00Z');
  const rows = [
    { outlet: 'Stage Review', publishedTime: '2026-10-29T23:10:00Z' },
    { outlet: 'Stage Review', publishedTime: '2026-10-30T03:00:30Z' },
    { outlet: 'Variety', publishedTime: '2026-10-30T03:00:00Z' },
    { outlet: 'Vulture', publishedTime: '2026-10-30T03:01:00Z' },
  ];
  const r = observedEmbargo({ estimateMs: est, publishTimes: rows });
  assert.equal(r.source, 'observed-cluster');
  assert.equal(r.at, '2026-10-30T03:00:00.000Z');
  assert.equal(r.n, 3);
});
