import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findShowByIdOrAlias } = require('./find-show-by-id.js');

const shows = [
  { id: 'the-snowman-off-west-end-2026', aliases: ['the-snowman-west-end-2026'] },
  { id: 'hangmen-2022' },
];

test('exact id wins', () => {
  assert.equal(findShowByIdOrAlias(shows, 'hangmen-2022').id, 'hangmen-2022');
});

test('a renamed id resolves through aliases', () => {
  assert.equal(findShowByIdOrAlias(shows, 'the-snowman-west-end-2026').id, 'the-snowman-off-west-end-2026');
});

test('an id an exact row owns is not shadowed by another row alias', () => {
  const rows = [{ id: 'b', aliases: ['a'] }, { id: 'a' }];
  assert.equal(findShowByIdOrAlias(rows, 'a').id, 'a');
});

test('unknown id returns null; accepts the { shows } wrapper', () => {
  assert.equal(findShowByIdOrAlias({ shows }, 'nope-2026'), null);
  assert.equal(findShowByIdOrAlias({ shows }, 'hangmen-2022').id, 'hangmen-2022');
});

test('empty id returns null instead of matching anything', () => {
  assert.equal(findShowByIdOrAlias(shows, ''), null);
  assert.equal(findShowByIdOrAlias(shows, undefined), null);
});
