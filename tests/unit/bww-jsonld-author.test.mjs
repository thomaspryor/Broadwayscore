/**
 * BRO-3345: BWW JSON-LD author parsing is ONE shared lib, used by all 3 scripts.
 * Pure-function tests on scripts/lib/bww-jsonld-author.js plus a wiring guard
 * that fails if a script re-forks the parser inline.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');
const { parseBwwPostingAuthor } = require('../../scripts/lib/bww-jsonld-author.js');

const REGISTERED = new Set(['Blogcritics', 'New York Theater', 'NY Post']);
const isReg = (s) => REGISTERED.has(s);
const parse = (posting) => parseBwwPostingAuthor(posting, isReg);

describe('parseBwwPostingAuthor', () => {
  test('"Outlet - Critic"', () => {
    assert.deepStrictEqual(parse({ author: { name: 'Blogcritics - Jon Sobel' } }),
      { outletRaw: 'Blogcritics', criticName: 'Jon Sobel' });
  });
  test('array author uses first entry', () => {
    assert.deepStrictEqual(parse({ author: [{ name: 'NY Post - Johnny O' }] }),
      { outletRaw: 'NY Post', criticName: 'Johnny O' });
  });
  test('comma format, both orders', () => {
    assert.deepStrictEqual(parse({ author: { name: 'Mandell, New York Theater' } }),
      { outletRaw: 'New York Theater', criticName: 'Mandell' });
    assert.deepStrictEqual(parse({ author: { name: 'NY Post, Johnny O' } }),
      { outletRaw: 'NY Post', criticName: 'Johnny O' });
  });
  test('colon format, both orders', () => {
    assert.deepStrictEqual(parse({ author: { name: 'NY Post: Johnny Oleksinski' } }),
      { outletRaw: 'NY Post', criticName: 'Johnny Oleksinski' });
    assert.deepStrictEqual(parse({ author: { name: 'Jane Doe: NY Post' } }),
      { outletRaw: 'NY Post', criticName: 'Jane Doe' });
  });
  test('bare critic name + registered headline outlet: no phantom outlet', () => {
    assert.deepStrictEqual(
      parse({ author: { name: 'Jon Sobel' }, headline: 'Blogcritics - Theater Review: Safe House' }),
      { outletRaw: 'Blogcritics', criticName: 'Jon Sobel' });
  });
  test('bare author that IS a registered outlet stays the outlet', () => {
    assert.deepStrictEqual(
      parse({ author: { name: 'Blogcritics' }, headline: 'Blogcritics - Safe House' }),
      { outletRaw: 'Blogcritics', criticName: null });
  });
  test('shape gate: delimiter-bearing / long unregistered authors are not demoted', () => {
    for (const name of ['Mandell, Some Unregistered Blog', 'Some Zine: Jane Doe',
      'Some Long Winded Unregistered Blog Name Here']) {
      const r = parse({ author: { name }, headline: 'Blogcritics - Safe House' });
      assert.strictEqual(r.outletRaw, 'Blogcritics', name);
      assert.strictEqual(r.criticName, null, name);
    }
  });
  test('unregistered headline outlet is not promoted over author', () => {
    const r = parse({ author: { name: 'Jon Sobel' }, headline: 'Some Zine - Safe House' });
    assert.deepStrictEqual(r, { outletRaw: 'Jon Sobel', criticName: null });
  });
  test('no author: headline outlet, rejected when 6+ words', () => {
    assert.deepStrictEqual(parse({ headline: 'Blogcritics - Safe House' }),
      { outletRaw: 'Blogcritics', criticName: null });
    assert.strictEqual(parse({ headline: 'a b c d e f - Safe House' }).outletRaw, null);
  });
  test('nothing usable -> null outlet', () => {
    assert.deepStrictEqual(parse({}), { outletRaw: null, criticName: null });
  });
});

describe('default predicate (what the cousin scripts use)', () => {
  test('real registry: bare critic + registered headline outlet -> no phantom', () => {
    const r = parseBwwPostingAuthor({ author: { name: 'Jon Sobel' }, headline: 'Blogcritics - Theater Review: Safe House' });
    assert.deepStrictEqual(r, { outletRaw: 'Blogcritics', criticName: 'Jon Sobel' });
  });
});

describe('all three scripts route through the shared lib (no re-fork)', () => {
  for (const f of ['gather-reviews.js', 'backfill-bww-thumbs.js', 're-extract-aggregator-reviews.js']) {
    test(f, () => {
      const src = fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8');
      assert.match(src, /require\('\.\/lib\/bww-jsonld-author'\)/);
      assert.match(src, /parseBwwPostingAuthor\(/);
      assert.doesNotMatch(src, /authorName\.includes\(' - '\)|author\[0\]\?\.name/,
        'inline author-delimiter parsing must live only in the lib');
    });
  }
});
