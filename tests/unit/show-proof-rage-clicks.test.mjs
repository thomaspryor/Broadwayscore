// TESTS-VS-DERIVED-DATA-EXEMPT: structural key-uniqueness invariant over all of
// data/reviews.json (no hardcoded scores/dates asserted as ground truth); the one
// proof-2026/nysr fact is a precondition guard for the regression case, not a
// claim about source data, and no-ops safely (via assert.ok) if it stops holding.
// Task #64 — rage clicks on /show/proof.
// Root cause: ReviewsList.tsx keyed review cards by `${outletId}-${publishDate}`,
// which collides whenever an outlet runs multiple bylined critics on the same
// day (NY Stage Review published both Roma Torre and Steven Suskin's proof-2026
// reviews on 2026-04-16). React warned about duplicate keys and could misapply
// per-card UI state (expand/collapse) to the wrong card, presenting as an
// unresponsive click. Fix: scripts/lib/review-list-key.js's getReviewKey adds
// url + criticName to the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getReviewKey } = require('../../scripts/lib/review-list-key.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const reviewsPath = join(__dirname, '../../data/reviews.json');
// data/reviews.json lives in the private data repo and is gitignored — absent
// in CI runners / worktrees that don't check out core data.
const allReviews = existsSync(reviewsPath) ? JSON.parse(readFileSync(reviewsPath, 'utf8')).reviews : null;

test('getReviewKey is unique for the proof-2026 nysr same-day multi-critic collision', () => {
  if (!allReviews) return;
  const proofNysr = allReviews.filter(
    (r) => r.showId === 'proof-2026' && r.outletId === 'nysr' && r.publishDate === '2026-04-16'
  );
  assert.ok(proofNysr.length >= 2, 'expected the known same-day nysr collision to still be present in fixture data');
  const keys = proofNysr.map(getReviewKey);
  assert.equal(new Set(keys).size, keys.length, 'duplicate ReviewsList keys for proof-2026 nysr reviews');
});

test('getReviewKey has no collisions across all reviews for any single show', () => {
  if (!allReviews) return;
  const byShow = new Map();
  for (const r of allReviews) {
    if (!byShow.has(r.showId)) byShow.set(r.showId, []);
    byShow.get(r.showId).push(r);
  }
  const collisions = [];
  for (const [showId, reviews] of byShow) {
    const seen = new Map();
    for (const r of reviews) {
      const key = getReviewKey(r);
      if (seen.has(key)) collisions.push({ showId, key, a: seen.get(key), b: r });
      else seen.set(key, r);
    }
  }
  assert.deepEqual(collisions, [], `found ${collisions.length} ReviewsList key collision(s)`);
});

test('getReviewKey stays unique when url is missing', () => {
  const a = { outletId: 'x', publishDate: '2026-01-01', url: null, criticName: 'A Critic' };
  const b = { outletId: 'x', publishDate: '2026-01-01', url: null, criticName: 'B Critic' };
  assert.notEqual(getReviewKey(a), getReviewKey(b));
});
