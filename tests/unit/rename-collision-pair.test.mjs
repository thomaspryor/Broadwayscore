import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isRenameCollisionPair } = require('../../scripts/lib/syndication-pairs.js');
const { safeWriteReview } = require('../../scripts/lib/review-write-guard.js');

const text = 'The revival opens with a long paragraph about the production and its cast '.repeat(6);
const base = { showId: 'a-soldiers-play-2020', outletId: 'variety', outlet: 'Variety', criticName: 'Marilyn Stasio', fullText: text, contentTier: 'complete' };

test('isRenameCollisionPair: only the collision reason + same critic + same opening text', () => {
  const a = { ...base, duplicateReason: 'criticName-override-collided-at-rename' };
  assert.equal(isRenameCollisionPair(a, { ...base }), true);
  assert.equal(isRenameCollisionPair({ ...a, duplicateReason: 'other' }, { ...base }), false);
  assert.equal(isRenameCollisionPair(a, { ...base, criticName: 'Someone Else' }), false);
  assert.equal(isRenameCollisionPair(a, { ...base, outletId: 'nytimes' }), false, 'cross-outlet is not this case');
  assert.equal(isRenameCollisionPair(a, { ...base, duplicateOf: 'variety--x.json' }), false, 'a mutual pointer would loop');
  assert.equal(isRenameCollisionPair(a, { ...base, fullText: 'A different article entirely. '.repeat(20) }), false);
});

test('the write guard keeps a rename-collision duplicateOf across url forms (it used to clear it)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-collision-'));
  try {
    const show = path.join(dir, 'a-soldiers-play-2020'); fs.mkdirSync(show);
    fs.writeFileSync(path.join(show, 'variety--marilyn-stasio.json'), JSON.stringify({ ...base, url: 'https://variety.com/2020/legit/reviews/a-soldiers-play-1234567890/' }));
    const dupPath = path.join(show, 'variety--aramide-tinubu.json');
    const dup = { ...base, url: 'https://variety.com/2020/legit/reviews/a-soldiers-play-review-1234567890/', duplicateOf: 'variety--marilyn-stasio.json', duplicateReason: 'criticName-override-collided-at-rename' };
    const w = console.warn; console.warn = () => {};
    try { safeWriteReview(dupPath, dup, {}); } finally { console.warn = w; }
    assert.equal(JSON.parse(fs.readFileSync(dupPath, 'utf8')).duplicateOf, 'variety--marilyn-stasio.json');
    // an ordinary mismatch (no collision reason) is still cleared
    const plain = path.join(show, 'variety--plain.json');
    const w2 = console.warn; console.warn = () => {};
    try { safeWriteReview(plain, { ...dup, url: 'https://variety.com/2020/legit/reviews/other-thing-999/', duplicateReason: 'url-collision-detected-at-write', criticName: 'Plain Critic' }, {}); } finally { console.warn = w2; }
    assert.equal(JSON.parse(fs.readFileSync(plain, 'utf8')).duplicateOf ?? null, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
