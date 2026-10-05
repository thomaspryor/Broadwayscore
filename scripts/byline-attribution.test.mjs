/**
 * BRO-2367: one Vulture article on queen-versailles-2025 was stored under two
 * bylines (Sara Holdren / David Fox), tripping validate-data.js's same-URL gate.
 * Requires the real helper (CLAUDE.md §15) and checks the real corpus.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { sameUrlDuplicateKey } = require('./lib/review-url-collision.js');

const SHOW = 'queen-versailles-2025';

function loadReviews() {
  const p = resolve(root, 'data/reviews.json');
  if (!fs.existsSync(p)) return null;
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const list = Array.isArray(j) ? j : (j.reviews || Object.values(j).flat());
  return list.filter(r => r && typeof r === 'object');
}

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

test('queen-versailles-2025 has no duplicate URLs and one Vulture record per article', (t) => {
  const reviews = loadReviews();
  if (!reviews) return t.skip('data/reviews.json not present');
  const qv = reviews.filter(r => r.showId === SHOW);
  assert.deepStrictEqual(dupes(qv), []);
});
