// BRO-7884: lane rows published a full timestamp as publishDate; the app showed "Invalid Date".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { toCalendarDay } = require('./publish.js');

test('press-night timestamp becomes the New York day', () => {
  assert.equal(toCalendarDay({ publishDate: '2026-11-20T03:00:43.000Z' }).publishDate, '2026-11-19');
});
test('London lane uses the London day', () => {
  assert.equal(toCalendarDay({ publishDate: '2026-11-20T03:00:00Z' }, 'Europe/London').publishDate, '2026-11-20');
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
