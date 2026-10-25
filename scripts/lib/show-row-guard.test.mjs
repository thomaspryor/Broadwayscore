import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateShowRow, partitionShowRows, formatSkipped } = require('./show-row-guard.js');

const good = { id: 'a-2026', title: 'A', slug: 'a', category: 'broadway', status: 'open', venue: 'Hudson Theatre' };

test('good row passes', () => assert.deepEqual(validateShowRow(good), []));
test('null venue on an open show is malformed', () => {
  assert.match(validateShowRow({ ...good, venue: null })[0], /venue is null/);
});
test('null venue on announced/upcoming rows is legitimate (BRO-5814)', () => {
  assert.deepEqual(validateShowRow({ ...good, status: 'announced', venue: null }), []);
  assert.deepEqual(validateShowRow({ ...good, status: 'upcoming', venue: null }), []);
});
test('null title / non-string venue / non-object rows are malformed', () => {
  assert.ok(validateShowRow({ ...good, title: null }).length);
  assert.ok(validateShowRow({ ...good, venue: 42 }).length);
  assert.ok(validateShowRow(null).length);
});
test('one bad row is skipped and named; the rest survive', () => {
  const rows = [good, { ...good, id: 'bad-2026', venue: null }, { ...good, id: 'b-2026', title: 'B' }];
  const { valid, skipped } = partitionShowRows(rows);
  assert.equal(valid.length, 2);
  assert.equal(skipped.length, 1);
  assert.match(formatSkipped(skipped)[0], /^bad-2026: venue is null/);
});
test('partition never throws on junk input', () => {
  assert.deepEqual(partitionShowRows(undefined), { valid: [], skipped: [] });
  assert.equal(partitionShowRows([null, 3]).skipped.length, 2);
});
