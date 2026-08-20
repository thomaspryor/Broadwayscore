import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeReviewsJson, keyOf, resolveConflict, tierRank } from './merge-reviews-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function review(overrides = {}) {
  return {
    showId: 'anansi-the-spider-west-end-2026',
    outlet: 'The Stage',
    outletId: 'the-stage',
    criticName: 'A Critic',
    assignedScore: 70,
    contentTier: 'complete',
    publishDate: '2026-08-01',
    url: 'https://example.com/review',
    ...overrides,
  };
}

test('keyOf: mirrors rebuild-all-reviews.js pass-2 dedup key shape (showId|outlet|critic, lower/trim)', () => {
  const r = review({ outlet: '  The Stage  ', criticName: 'A CRITIC ' });
  assert.equal(keyOf(r), 'anansi-the-spider-west-end-2026|the stage|a critic');
});

test('keyOf: returns null for a review with no showId (keyless)', () => {
  assert.equal(keyOf({ outlet: 'x', criticName: 'y' }), null);
});

test('mergeReviewsJson: union of disjoint reviews — both sides additions survive', () => {
  const a = review({ criticName: 'Critic A' });
  const b = review({ criticName: 'Critic B' });
  const ours = { reviews: [a] };
  const remote = { reviews: [b] };
  const { merged, stats } = mergeReviewsJson(ours, remote);
  assert.equal(merged.reviews.length, 2);
  assert.deepEqual(new Set(merged.reviews.map(r => r.criticName)), new Set(['Critic A', 'Critic B']));
  assert.equal(stats.added, 1);
  assert.equal(stats.conflicts, 0);
});

test('mergeReviewsJson: same-key conflict resolved by higher contentTier, regardless of side', () => {
  const oursReview = review({ contentTier: 'stub', assignedScore: 40 });
  const remoteReview = review({ contentTier: 'complete', assignedScore: 65 });
  const { merged, stats } = mergeReviewsJson({ reviews: [oursReview] }, { reviews: [remoteReview] });
  assert.equal(merged.reviews.length, 1);
  assert.equal(merged.reviews[0].assignedScore, 65);
  assert.equal(stats.conflicts, 1);
  assert.equal(stats.conflictsResolvedToRemote, 1);
});

test('mergeReviewsJson: same-key conflict — ours wins when ours has the higher tier', () => {
  const oursReview = review({ contentTier: 'complete', assignedScore: 65 });
  const remoteReview = review({ contentTier: 'stub', assignedScore: 40 });
  const { merged, stats } = mergeReviewsJson({ reviews: [oursReview] }, { reviews: [remoteReview] });
  assert.equal(merged.reviews[0].assignedScore, 65);
  assert.equal(stats.conflictsResolvedToRemote, 0);
});

test('mergeReviewsJson: manualEntry always wins over a non-manual twin, even at a lower contentTier', () => {
  const manual = review({ manualEntry: true, contentTier: 'stub', assignedScore: 55 });
  const pipeline = review({ contentTier: 'complete', assignedScore: 30 });
  const { merged } = mergeReviewsJson({ reviews: [manual] }, { reviews: [pipeline] });
  assert.equal(merged.reviews.length, 1);
  assert.equal(merged.reviews[0].manualEntry, true);
  assert.equal(merged.reviews[0].assignedScore, 55);

  // Same conflict, sides swapped — manual entry still wins regardless of which side it's on.
  const { merged: merged2 } = mergeReviewsJson({ reviews: [pipeline] }, { reviews: [manual] });
  assert.equal(merged2.reviews[0].manualEntry, true);
  assert.equal(merged2.reviews[0].assignedScore, 55);
});

test('mergeReviewsJson: both sides manualEntry — keeps ours (matches -X ours rebase default)', () => {
  const oursManual = review({ manualEntry: true, assignedScore: 50 });
  const remoteManual = review({ manualEntry: true, assignedScore: 60 });
  const { merged } = mergeReviewsJson({ reviews: [oursManual] }, { reviews: [remoteManual] });
  assert.equal(merged.reviews[0].assignedScore, 50);
});

test('mergeReviewsJson: same tier — newer publishDate wins', () => {
  const older = review({ publishDate: '2026-01-01', assignedScore: 40 });
  const newer = review({ publishDate: '2026-06-01', assignedScore: 72 });
  const { merged } = mergeReviewsJson({ reviews: [older] }, { reviews: [newer] });
  assert.equal(merged.reviews[0].assignedScore, 72);
});

test('mergeReviewsJson: same tier, same publishDate — keeps ours (final tiebreak)', () => {
  const oursReview = review({ assignedScore: 40 });
  const remoteReview = review({ assignedScore: 72 });
  const { merged } = mergeReviewsJson({ reviews: [oursReview] }, { reviews: [remoteReview] });
  assert.equal(merged.reviews[0].assignedScore, 40);
});

test('mergeReviewsJson: duplicate detection — a real multi-critic-outlet corpus shape does not collapse distinct critics', () => {
  const a = review({ outlet: 'The Stage', criticName: 'Alice' });
  const b = review({ outlet: 'The Stage', criticName: 'Bob' });
  // Same showId+outletId, distinct critics — the exact shape that produces
  // 723 showId::outletId collisions in the real corpus (see module comment).
  const { merged, stats } = mergeReviewsJson({ reviews: [a] }, { reviews: [b] });
  assert.equal(merged.reviews.length, 2);
  assert.equal(stats.conflicts, 0);
});

test('mergeReviewsJson: keyless entries on either side are kept verbatim, never lost or deduped', () => {
  const keyless = { outlet: 'Mystery Outlet', criticName: 'Unknown', assignedScore: 10 };
  const normal = review();
  const { merged } = mergeReviewsJson({ reviews: [keyless] }, { reviews: [normal] });
  assert.equal(merged.reviews.length, 2);
  assert.ok(merged.reviews.some(r => r === keyless));
});

test('mergeReviewsJson: _meta.lastUpdated — newer side wins and totalReviews is corrected to the merged count', () => {
  const ours = {
    reviews: [review({ criticName: 'Critic A' })],
    _meta: { lastUpdated: '2026-01-01T00:00:00.000Z', stats: { totalReviews: 1 } },
  };
  const remote = {
    reviews: [review({ criticName: 'Critic B' })],
    _meta: { lastUpdated: '2026-06-01T00:00:00.000Z', stats: { totalReviews: 1 } },
  };
  const { merged } = mergeReviewsJson(ours, remote);
  assert.equal(merged._meta.lastUpdated, '2026-06-01T00:00:00.000Z');
  assert.equal(merged._meta.stats.totalReviews, 2);
});

test('mergeReviewsJson: idempotent — merging a snapshot against itself produces no duplication', () => {
  const reviews = [review({ criticName: 'Critic A' }), review({ criticName: 'Critic B', outlet: 'Vulture' })];
  const snapshot = { reviews, _meta: { lastUpdated: '2026-01-01T00:00:00.000Z' } };
  const { merged, stats } = mergeReviewsJson(snapshot, snapshot);
  assert.equal(merged.reviews.length, 2);
  assert.equal(stats.added, 0);
  assert.equal(stats.conflicts, 2);
});

test('mergeReviewsJson: missing/empty reviews arrays on either side degrade gracefully', () => {
  const normal = { reviews: [review()] };
  assert.equal(mergeReviewsJson({}, normal).merged.reviews.length, 1);
  assert.equal(mergeReviewsJson(normal, {}).merged.reviews.length, 1);
  assert.equal(mergeReviewsJson(null, normal).merged.reviews.length, 1);
  assert.equal(mergeReviewsJson(normal, null).merged.reviews.length, 1);
});

test('tierRank: untiered/unknown contentTier ranks lowest, below invalid', () => {
  assert.ok(tierRank({ contentTier: 'invalid' }) > tierRank({}));
  assert.ok(tierRank({ contentTier: 'complete' }) > tierRank({ contentTier: 'invalid' }));
});

test('resolveConflict: manual > tier > date > ours, composed in order', () => {
  // Tier beats date.
  assert.equal(
    resolveConflict(
      review({ contentTier: 'stub', publishDate: '2026-06-01' }),
      review({ contentTier: 'complete', publishDate: '2026-01-01' })
    ),
    'remote'
  );
  // Manual beats tier.
  assert.equal(
    resolveConflict(
      review({ manualEntry: true, contentTier: 'stub' }),
      review({ contentTier: 'complete' })
    ),
    'ours'
  );
});

// Corpus sanity check: the key must actually be unique across the real,
// live reviews.json — this is the exact invariant the module comment claims
// ("verified unique across the full production corpus"). Skips quietly if
// the file isn't present (e.g. a minimal CI checkout without core data).
test('keyOf: unique across the real data/reviews.json corpus (no accidental key collisions)', () => {
  const reviewsPath = path.join(__dirname, '..', '..', 'data', 'reviews.json');
  if (!fs.existsSync(reviewsPath)) return;
  const data = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
  const reviews = Array.isArray(data.reviews) ? data.reviews : [];
  if (reviews.length === 0) return;
  const keys = new Map();
  const collisions = [];
  for (const r of reviews) {
    const k = keyOf(r);
    if (!k) continue;
    if (keys.has(k)) collisions.push(k);
    keys.set(k, true);
  }
  assert.deepEqual(collisions, [], `keyOf collisions found in real corpus: ${collisions.slice(0, 5).join(', ')}`);
});
