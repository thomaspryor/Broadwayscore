// BRO-4251: a show's hero image must be that show's art.
//
// Found live: Shucked's hero was a photo from SIX, Hangmen and The Cripple of
// Inishmaan shared one file, four unrelated shows (Here Lies Love, Once Upon a
// Mattress, The Minutes, Phantom) shared another, and Hangmen's hero was a
// "FINAL WEEK / ENDS JUNE 18" banner with no show art at all.
//
// Identical hero bytes are fine across productions of the same show (revivals,
// transfers, regional stops share key art), so this groups hero files by md5
// and requires every group to share a base slug. Different titles sharing one
// file means one of them is showing another show's picture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SHOWS_DIR = path.join(process.cwd(), 'public/images/shows');

// Hero files that must never come back (md5 → why).
const BANNED_HEROES = {
  '9c56c7ac3efb321f8e84a2d09da928b6': 'Hangmen "FINAL WEEK / ENDS JUNE 18" banner, no show art',
};

// Different slugs that are the same production under another name.
const SAME_SHOW = [
  ['wanted', 'gun-and-powder'], // Gun & Powder transferred to Broadway as Wanted
];

function baseSlug(dir) {
  return dir.replace(/^(the|a|an)-/, '').split('-')[0];
}

function sameShow(a, b) {
  if (baseSlug(a) === baseSlug(b)) return true;
  return SAME_SHOW.some(names =>
    names.some(n => a.startsWith(n)) && names.some(n => b.startsWith(n)));
}

function heroGroups() {
  const byHash = new Map();
  for (const dir of fs.readdirSync(SHOWS_DIR)) {
    const d = path.join(SHOWS_DIR, dir);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) {
      if (!/^hero\./.test(f)) continue;
      const md5 = crypto.createHash('md5').update(fs.readFileSync(path.join(d, f))).digest('hex');
      if (!byHash.has(md5)) byHash.set(md5, []);
      byHash.get(md5).push(dir);
    }
  }
  return byHash;
}

test('no banned hero file is present', () => {
  for (const [md5, dirs] of heroGroups()) {
    assert.ok(!BANNED_HEROES[md5], `${dirs.join(', ')}: ${BANNED_HEROES[md5]}`);
  }
});

test('identical hero files are only shared by productions of the same show', () => {
  const bad = [];
  for (const dirs of heroGroups().values()) {
    if (dirs.length < 2) continue;
    if (!dirs.every(d => sameShow(dirs[0], d))) bad.push(dirs.join(' = '));
  }
  assert.deepEqual(bad, [], `unrelated shows share a hero file:\n${bad.join('\n')}`);
});

test('baseSlug/sameShow catch the BRO-4251 cases', () => {
  assert.equal(sameShow('hangmen-2022', 'the-cripple-of-inishmaan-2014'), false);
  assert.equal(sameShow('here-lies-love-2023', 'the-phantom-of-the-opera-1988'), false);
  assert.equal(sameShow('les-miserables-2014', 'les-miserables-1987'), true);
  assert.equal(sameShow('the-choir-of-man-west-end-2026', 'the-choir-of-man-off-west-end-2026'), true);
  assert.equal(sameShow('wanted-2022', 'gun-and-powder-regional-2020'), true);
});
