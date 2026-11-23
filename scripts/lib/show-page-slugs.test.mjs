import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveShowSlugs, slugsForCli } = require('./show-page-slugs.js');

const shows = [
  { id: 'hamilton-west-end-2021', slug: 'hamilton-west-end' },
  { id: 'hamilton-2015', slug: 'hamilton' },
  { id: 'wicked-2003', slug: 'wicked-2003' },
];

test('a show id becomes its page slug (BRO-8085)', () => {
  assert.deepEqual(resolveShowSlugs(['hamilton-west-end-2021'], shows), { slugs: ['hamilton-west-end'], unknown: [] });
});

test('a slug passes through, and duplicates collapse', () => {
  assert.deepEqual(resolveShowSlugs(['hamilton-west-end', 'hamilton-west-end-2021', ' wicked-2003 '], shows).slugs,
    ['hamilton-west-end', 'wicked-2003']);
});

test('an unknown token is reported and never submitted', () => {
  const warned = [];
  const out = slugsForCli(['nope-1999', 'hamilton-2015'], shows, { warn: m => warned.push(m) });
  assert.deepEqual(out, ['hamilton']);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /nope-1999/);
});

test('without shows.json the tokens are used unchanged, with a warning', () => {
  const warned = [];
  assert.deepEqual(slugsForCli(['a', ' b ', ''], null, { warn: m => warned.push(m) }), ['a', 'b']);
  assert.equal(warned.length, 1);
});
