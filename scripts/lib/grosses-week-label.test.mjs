import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { grossesWeekLabel } = require('./grosses-week-label.js');

test('Sunday key labels that Sunday (2026-10-25 draft printed 10/17)', () => {
  assert.equal(grossesWeekLabel('2026-10-18', 'x'), '10/18/2026');
});

test('legacy Monday key labels the Sunday before', () => {
  assert.equal(grossesWeekLabel('2026-06-29', 'x'), '6/28/2026');
});

test('no key or a bad key falls back', () => {
  assert.equal(grossesWeekLabel(null, '10/18/2026'), '10/18/2026');
  assert.equal(grossesWeekLabel('nope', '10/18/2026'), '10/18/2026');
});
