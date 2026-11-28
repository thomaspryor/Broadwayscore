import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { countByCity } = createRequire(import.meta.url)('../lib/signup-city-counts.js');
test('counts tagged signups by city and ignores blanks', () => {
  const r = countByCity([{ city: 'chicago-il' }, { city: 'chicago-il' }, { city: 'washington-dc' }, { city: '' }, {}, null]);
  assert.deepEqual(r, { total: 6, tagged: 3, byCity: { 'chicago-il': 2, 'washington-dc': 1 } });
});
test('empty input is zero, never throws', () => {
  assert.deepEqual(countByCity(undefined), { total: 0, tagged: 0, byCity: {} });
});
