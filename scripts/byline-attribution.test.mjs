/**
 * BRO-2367: one Vulture article on queen-versailles-2025 was stored under two
 * bylines (Sara Holdren / David Fox), tripping validate-data.js's same-URL gate.
 * Requires the real helper (CLAUDE.md §15). The live-corpus check is
 * validate-data.js (same key, baseline-gated); not duplicated here because
 * bot-edited data in the unit batch turns main red with no code change.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { sameUrlDuplicateKey } = require('./lib/review-url-collision.js');

const SHOW = 'queen-versailles-2025';

function dupes(reviews) {
  const seen = new Map();
  const out = [];
  for (const r of reviews) {
    const key = sameUrlDuplicateKey(r.showId, r.url);
    if (key === null) continue;
    if (seen.has(key)) out.push({ key, critics: [seen.get(key).criticName, r.criticName] });
    else seen.set(key, r);
  }
  return out;
}

test('same URL under two bylines is detected as one key (the BRO-2367 shape)', () => {
  const url = 'https://www.vulture.com/article/theater-review-the-queen-of-versailles.html';
  const found = dupes([
    { showId: SHOW, outletId: 'vulture', criticName: 'Sara Holdren', url },
    { showId: SHOW, outletId: 'vulture', criticName: 'David Fox', url },
  ]);
  assert.strictEqual(found.length, 1);
});

test('distinct URLs are not flagged', () => {
  assert.deepStrictEqual(dupes([
    { showId: SHOW, outletId: 'vulture', criticName: 'A', url: 'https://www.vulture.com/a.html' },
    { showId: SHOW, outletId: 'vulture', criticName: 'B', url: 'https://www.vulture.com/b.html' },
  ]), []);
});

test('key ignores byline and outlet id, so drifted attributions still collide', () => {
  const url = 'https://www.vulture.com/article/x.html';
  assert.notStrictEqual(sameUrlDuplicateKey(SHOW, url), sameUrlDuplicateKey('other-show-2025', url));
  assert.strictEqual(sameUrlDuplicateKey(SHOW, 12345), null);
  assert.strictEqual(dupes([
    { showId: SHOW, outletId: 'vulture', criticName: 'Sara Holdren', url },
    { showId: SHOW, outletId: 'vulture-provisional', criticName: 'Sara Holdren and Jesse David Fox', url },
  ]).length, 1);
});
