// BRO-7884: lane rows published a full timestamp as publishDate; the app showed "Invalid Date".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { toCalendarDay } = require('../../scripts/lib/opening-night-lane/publish.js');

test('press-night timestamp becomes the New York day', () => {
  assert.equal(toCalendarDay({ publishDate: '2026-11-20T03:00:43.000Z' }).publishDate, '2026-11-19');
});
test('London lane uses the London day', () => {
  assert.equal(toCalendarDay({ publishDate: '2026-06-19T23:30:00Z' }, 'Europe/London').publishDate, '2026-06-20');
  assert.equal(toCalendarDay({ publishDate: '2026-06-19T23:30:00Z' }).publishDate, '2026-06-19');
});
test('never mutates the lane row', () => {
  const r = { publishDate: '2026-11-20T03:00:43.000Z' };
  const out = toCalendarDay(r);
  assert.notEqual(out, r);
  assert.equal(r.publishDate, '2026-11-20T03:00:43.000Z');
});
test('a plain day and a missing date are left alone; the same object is returned', () => {
  const r = { publishDate: '2026-11-19' };
  assert.equal(toCalendarDay(r), r);
  assert.equal(r.publishDate, '2026-11-19');
  assert.equal(toCalendarDay({ publishDate: null }).publishDate, null);
});
test('an unreadable value is left for the generator to handle', () => {
  assert.equal(toCalendarDay({ publishDate: 'Nov 19' }).publishDate, 'Nov 19');
});

test('a zoneless timestamp keeps its written day', () => {
  assert.equal(toCalendarDay({ publishDate: '2026-11-19T22:00:00' }).publishDate, '2026-11-19');
});

test('the runner dates the persisted file and the published row (wiring)', () => {
  const fs = require('fs');
  const runner = fs.readFileSync(new URL('../../scripts/lib/opening-night-lane/lane-runner.js', import.meta.url), 'utf8');
  assert.match(runner, /row = publish\.toCalendarDay\(row, timeZone\);\s*\n(\s*\/\/.*\n)*\s*if \(persistReview\)/);
  assert.match(runner, /publishLaneReviews\(\{[\s\S]{0,600}\.\.\.\(timeZone \? \{ timeZone \} : \{\}\)/);
  const pub = fs.readFileSync(new URL('../../scripts/lib/opening-night-lane/publish.js', import.meta.url), 'utf8');
  assert.match(pub, /rows\.map\(\(r\) => \{ const c = toCalendarDay\(r\.row, timeZone\)/);
});
