import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeReviewsJson, keyOf, urlKeyOf, resolveConflict, snapshotIsNewer, tierRank } from './merge-reviews-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function review(overrides = {}) {
  // Default URL is derived from the (possibly overridden) criticName so two
  // fixtures with different critics don't accidentally collide via the URL
  // fallback match — tests that DO want a shared-URL/different-byline
  // conflict pass a matching `url` override explicitly.
  const critic = overrides.criticName || 'A Critic';
  const slug = critic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    showId: 'anansi-the-spider-west-end-2026',
    outlet: 'The Stage',
    outletId: 'the-stage',
    criticName: 'A Critic',
    assignedScore: 70,
    contentTier: 'complete',
    publishDate: '2026-08-01',
    url: `https://example.com/review-${slug}`,
    ...overrides,
  };
}

test('keyOf: showId + outlet(lower/trim) + criticKey(criticName)', () => {
  const r = review({ outlet: '  The Stage  ', criticName: 'A CRITIC ' });
  assert.equal(keyOf(r), 'anansi-the-spider-west-end-2026|the stage|a critic');
});

test('keyOf: punctuation/diacritic drift in criticName collapses to the same key (manual-entry-merge.js criticKey semantics)', () => {
  const a = review({ criticName: 'R. Scott Reedy' });
  const b = review({ criticName: 'R Scott Reedy' });
  assert.equal(keyOf(a), keyOf(b));
});

test('keyOf: returns null for a review with no showId (keyless)', () => {
  assert.equal(keyOf({ outlet: 'x', criticName: 'y' }), null);
});

test('urlKeyOf: same showId + canonicalized URL matches regardless of outlet/critic', () => {
  const a = review({ outlet: 'Chicago Sun-Times', criticName: 'Steven Oxman', url: 'https://suntimes.com/a?utm_source=x' });
  const b = review({ outlet: 'Sun-Times', criticName: 'S. Oxman', url: 'https://suntimes.com/a' });
  assert.equal(urlKeyOf(a), urlKeyOf(b));
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

test('mergeReviewsJson: same-key conflict — newer whole-snapshot _meta.lastUpdated wins its version, regardless of side', () => {
  const oursReview = review({ assignedScore: 40 });
  const remoteReview = review({ assignedScore: 65 });
  const ours = { reviews: [oursReview], _meta: { lastUpdated: '2026-01-01T00:00:00.000Z' } };
  const remote = { reviews: [remoteReview], _meta: { lastUpdated: '2026-06-01T00:00:00.000Z' } };
  const { merged, stats } = mergeReviewsJson(ours, remote);
  assert.equal(merged.reviews.length, 1);
  assert.equal(merged.reviews[0].assignedScore, 65);
  assert.equal(stats.conflicts, 1);
  assert.equal(stats.conflictsResolvedToRemote, 1);
});

test('mergeReviewsJson: same-key conflict — ours wins when ours snapshot is newer', () => {
  const oursReview = review({ assignedScore: 65 });
  const remoteReview = review({ assignedScore: 40 });
  const ours = { reviews: [oursReview], _meta: { lastUpdated: '2026-06-01T00:00:00.000Z' } };
  const remote = { reviews: [remoteReview], _meta: { lastUpdated: '2026-01-01T00:00:00.000Z' } };
  const { merged, stats } = mergeReviewsJson(ours, remote);
  assert.equal(merged.reviews[0].assignedScore, 65);
  assert.equal(stats.conflictsResolvedToRemote, 0);
});

test('mergeReviewsJson: manualEntry wins even when its snapshot carries a STALE _meta.lastUpdated (manual-review-direct.js never stamps _meta)', () => {
  const manual = review({ manualEntry: true, assignedScore: 55 });
  const pipeline = review({ assignedScore: 30 });
  // manual's snapshot timestamp is OLDER than pipeline's — a naive
  // snapshot-recency-only resolver would silently drop the human correction.
  const ours = { reviews: [manual], _meta: { lastUpdated: '2026-01-01T00:00:00.000Z' } };
  const remote = { reviews: [pipeline], _meta: { lastUpdated: '2026-06-01T00:00:00.000Z' } };
  const { merged } = mergeReviewsJson(ours, remote);
  assert.equal(merged.reviews.length, 1);
  assert.equal(merged.reviews[0].manualEntry, true);
  assert.equal(merged.reviews[0].assignedScore, 55);

  // Sides swapped — still wins.
  const { merged: merged2 } = mergeReviewsJson(remote, ours);
  assert.equal(merged2.reviews[0].manualEntry, true);
  assert.equal(merged2.reviews[0].assignedScore, 55);
});

test('mergeReviewsJson: both sides manualEntry — keeps ours (matches -X ours rebase default)', () => {
  const oursManual = review({ manualEntry: true, assignedScore: 50 });
  const remoteManual = review({ manualEntry: true, assignedScore: 60 });
  const { merged } = mergeReviewsJson({ reviews: [oursManual] }, { reviews: [remoteManual] });
  assert.equal(merged.reviews[0].assignedScore, 50);
});

test('mergeReviewsJson: byline swap on the same article — URL fallback resolves it as a CONFLICT, not a duplicate union (iceboy-regional-2026 shape)', () => {
  const wrongByline = review({ criticName: 'Christopher Borrelli', assignedScore: 75, url: 'https://chicago.suntimes.com/review-a' });
  const corrected = review({ criticName: 'Steven Oxman', assignedScore: 65, manualEntry: true, url: 'https://chicago.suntimes.com/review-a' });
  const { merged, stats } = mergeReviewsJson({ reviews: [wrongByline] }, { reviews: [corrected] });
  assert.equal(merged.reviews.length, 1, 'must resolve to one review, not two duplicate critics for the same article');
  assert.equal(merged.reviews[0].criticName, 'Steven Oxman');
  assert.equal(stats.conflicts, 1);
  assert.equal(stats.added, 0);
});

test('mergeReviewsJson: timestamps tied/unparseable — falls back to higher contentTier, then ours', () => {
  const oursReview = review({ contentTier: 'stub', assignedScore: 40 });
  const remoteReview = review({ contentTier: 'complete', assignedScore: 65 });
  const { merged } = mergeReviewsJson({ reviews: [oursReview] }, { reviews: [remoteReview] });
  assert.equal(merged.reviews[0].assignedScore, 65);

  const tiedTier = review({ assignedScore: 40 });
  const tiedTierOther = review({ assignedScore: 72 });
  const { merged: tied } = mergeReviewsJson({ reviews: [tiedTier] }, { reviews: [tiedTierOther] });
  assert.equal(tied.reviews[0].assignedScore, 40); // final fallback: ours
});

test('mergeReviewsJson: duplicate detection — distinct critics at the same show+outlet are never collapsed', () => {
  const a = review({ outlet: 'The Stage', criticName: 'Alice' });
  const b = review({ outlet: 'The Stage', criticName: 'Bob' });
  // Same showId+outlet, distinct critics — the exact shape that produces
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

test('mergeReviewsJson: duplicate keys within the remote side alone — first occurrence wins, counted, never crashes', () => {
  const remoteA = review({ assignedScore: 10 });
  const remoteB = review({ assignedScore: 20 }); // same identity as remoteA
  const { merged, stats } = mergeReviewsJson({ reviews: [] }, { reviews: [remoteA, remoteB] });
  assert.equal(merged.reviews.length, 1);
  assert.equal(merged.reviews[0].assignedScore, 10);
  assert.equal(stats.remoteDuplicateKeysSkipped, 1);
});

test('tierRank: untiered/unknown contentTier ranks lowest, below invalid', () => {
  assert.ok(tierRank({ contentTier: 'invalid' }) > tierRank({}));
  assert.ok(tierRank({ contentTier: 'complete' }) > tierRank({ contentTier: 'invalid' }));
});

test('snapshotIsNewer: true/false/null (tied or unparseable)', () => {
  const a = { _meta: { lastUpdated: '2026-01-01T00:00:00.000Z' } };
  const b = { _meta: { lastUpdated: '2026-06-01T00:00:00.000Z' } };
  assert.equal(snapshotIsNewer(a, b), false);
  assert.equal(snapshotIsNewer(b, a), true);
  assert.equal(snapshotIsNewer(a, a), null);
  assert.equal(snapshotIsNewer({}, {}), null);
});

test('resolveConflict: manual > snapshot-recency > tier > ours, composed in order', () => {
  // Snapshot recency beats tier when no manual entry is involved.
  assert.equal(
    resolveConflict(review({ contentTier: 'complete' }), review({ contentTier: 'stub' }), false),
    'remote'
  );
  // Manual beats snapshot recency.
  assert.equal(
    resolveConflict(review({ manualEntry: true }), review({ contentTier: 'complete' }), false),
    'ours'
  );
});

// Corpus sanity check: the key must actually be unique across the real,
// live reviews.json — this is the exact invariant the module comment claims
// ("verified collision-free across the full production corpus"). Skips
// quietly if the file isn't present (e.g. a minimal CI checkout without core
// data).
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
