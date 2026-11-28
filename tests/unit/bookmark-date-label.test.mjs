import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { toLocalYMD, isPastPlannedDate, formatBookmarkDate, spokenBookmarkDate, buildPlannedDateMap } =
  require('../../src/lib/bookmark-date-label');

const TODAY = '2026-11-04';

test('upcoming and today print month + day', () => {
  assert.equal(formatBookmarkDate('2026-11-17', TODAY), 'NOV 17');
  assert.equal(formatBookmarkDate('2026-11-04', TODAY), 'NOV 4');
  assert.equal(isPastPlannedDate('2026-11-04', TODAY), false);
});

test('past prints month + short year', () => {
  assert.equal(formatBookmarkDate('2026-10-26', TODAY), "OCT '26");
  assert.equal(isPastPlannedDate('2026-11-03', TODAY), true);
});

test('spoken form never reads as a day number', () => {
  assert.equal(spokenBookmarkDate('2026-10-26', TODAY), 'October 2026');
  assert.equal(spokenBookmarkDate('2026-11-17', TODAY), 'November 17');
});

test('malformed or empty dates are ignored', () => {
  for (const bad of [null, undefined, '', 'soon', '2026-13-01', '2026-00-10']) {
    assert.equal(formatBookmarkDate(bad, TODAY), null);
    assert.equal(spokenBookmarkDate(bad, TODAY), null);
  }
  assert.equal(isPastPlannedDate('nope', TODAY), false);
});

test('toLocalYMD uses local fields, not UTC', () => {
  assert.equal(toLocalYMD(new Date(2026, 10, 4, 23, 30)), '2026-11-04');
  assert.equal(toLocalYMD(new Date(2026, 0, 2, 0, 5)), '2026-01-02');
});

test('buildPlannedDateMap keeps only dated entries', () => {
  const m = buildPlannedDateMap([
    { show_id: 'a', planned_date: '2026-11-17' },
    { show_id: 'b', planned_date: null },
  ]);
  assert.deepEqual([...m], [['a', '2026-11-17']]);
});

// Wiring pin: the component must use the real helper and the iOS stub geometry.
test('ShowPageBookmark wires the shared helper and iOS stub colors/path', () => {
  const src = readFileSync(new URL('../../src/components/user/ShowPageBookmark.tsx', import.meta.url), 'utf8');
  assert.match(src, /@\/lib\/bookmark-date-label/);
  assert.match(src, /#F3EBDD/);
  assert.match(src, /#2A2114/);
  assert.match(src, /M3 1 H33 Q35 1 35 3 V17 A3\.5 3\.5 0 0 0 35 24/);
});
