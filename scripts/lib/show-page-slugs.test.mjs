import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveShowSlugs, slugsForCli, loadShowsForSlugs } = require('./show-page-slugs.js');

const shows = [
  { id: 'hamilton-west-end-2021', slug: 'hamilton-west-end', category: 'west-end' },
  { id: 'hamilton-2015', slug: 'hamilton', category: 'broadway' },
  { id: 'wicked-2003', slug: 'wicked-2003', category: 'broadway', aliases: ['wicked-old-2003'] },
  { id: 'secret-2026', slug: 'secret', category: 'broadway', _devOnly: true },
];
const quiet = { warn() {} };

test('a show id becomes its page slug (BRO-8085)', () => {
  assert.deepEqual(resolveShowSlugs(['hamilton-west-end-2021'], shows).slugs, ['hamilton-west-end']);
});

test('slug wins, an alias resolves, duplicates collapse', () => {
  assert.deepEqual(resolveShowSlugs(['hamilton-west-end', 'hamilton-west-end-2021', ' wicked-old-2003 '], shows).slugs,
    ['hamilton-west-end', 'wicked-2003']);
});

test('unknown and unpublished tokens are reported and never submitted', () => {
  const warned = [];
  assert.deepEqual(slugsForCli(['nope-1999', 'secret-2026', 'hamilton-2015'], shows, { warn: m => warned.push(m) }), ['hamilton']);
  assert.equal(warned.length, 2);
  assert.match(warned.join('\n'), /nope-1999[\s\S]*secret-2026/);
});

test('nothing usable left is an error, not a green run', () => {
  assert.throws(() => slugsForCli(['nope-1999', ''], shows, quiet), /none of the 2 token/);
});

test('a missing or corrupt shows.json fails closed with the cause', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slugs-'));
  const scripts = path.join(dir, 'scripts');
  fs.mkdirSync(scripts); fs.mkdirSync(path.join(dir, 'data'));
  assert.throws(() => loadShowsForSlugs(fs, path, scripts), /ENOENT/);
  fs.writeFileSync(path.join(dir, 'data/shows.json'), '{not json');
  assert.throws(() => loadShowsForSlugs(fs, path, scripts), /could not be read/);
  fs.writeFileSync(path.join(dir, 'data/shows.json'), JSON.stringify({ shows }));
  assert.equal(loadShowsForSlugs(fs, path, scripts).length, 4);
});

test('every open London show in the real data resolves to its own slug', () => {
  const real = loadShowsForSlugs(fs, path, path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
  const london = real.filter(s => s.status === 'open' && (s.category === 'west-end' || s.category === 'off-west-end') && !s._devOnly);
  if (!london.length) return; // stub data in a keyless container
  const { slugs, unknown } = resolveShowSlugs(london.map(s => s.id), real);
  assert.deepEqual(unknown, []);
  assert.deepEqual(slugs, london.map(s => s.slug));
});
