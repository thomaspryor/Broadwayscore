import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseShowFilter, selectShowsById } = require('./gap-audit-show-filter.js');

test('parseShowFilter: single id and comma list keep order, drop duplicates', () => {
  assert.deepEqual(parseShowFilter('a-2026'), ['a-2026']);
  assert.deepEqual(parseShowFilter('b-2026, a-2026,b-2026,,c'), ['b-2026', 'a-2026', 'c']);
});

test('parseShowFilter: empty input gives an empty list', () => {
  assert.deepEqual(parseShowFilter(''), []);
  assert.deepEqual(parseShowFilter(undefined), []);
  assert.deepEqual(parseShowFilter('  '), []);
});

test('parseShowFilter: rejects ids that are not show slugs', () => {
  assert.throws(() => parseShowFilter('ok-1,Bad Id'), /Invalid show id/);
  assert.throws(() => parseShowFilter('a;rm -rf /'), /Invalid show id/);
});

test('selectShowsById: targets follow the requested order, missing ids are reported', () => {
  const all = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const { targets, missing } = selectShowsById(all, ['c', 'zzz', 'a']);
  assert.deepEqual(targets.map(s => s.id), ['c', 'a']);
  assert.deepEqual(missing, ['zzz']);
});
