import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeReviewsJson, keyOf, urlKeyOf, resolveConflict, snapshotIsNewer, tierRank, isUnknownByline } from './merge-reviews-json.js';

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

test('mergeReviewsJson: byline swap on the same article — manual-entry URL rescue resolves it, not a duplicate union (iceboy-regional-2026 shape)', () => {
  const wrongByline = review({ criticName: 'Christopher Borrelli', assignedScore: 75, url: 'https://chicago.suntimes.com/review-a' });
  const corrected = review({ criticName: 'Steven Oxman', assignedScore: 65, manualEntry: true, url: 'https://chicago.suntimes.com/review-a' });
  const { merged, stats } = mergeReviewsJson({ reviews: [wrongByline] }, { reviews: [corrected] });
  assert.equal(merged.reviews.length, 1, 'must resolve to one review, not two duplicate critics for the same article');
  assert.equal(merged.reviews[0].criticName, 'Steven Oxman');
  assert.equal(stats.urlRescueConflicts, 1);
});

test('mergeReviewsJson: byline swap works regardless of which side (ours/remote) carries the manual entry', () => {
  const wrongByline = review({ criticName: 'Christopher Borrelli', assignedScore: 75, url: 'https://chicago.suntimes.com/review-a' });
  const corrected = review({ criticName: 'Steven Oxman', assignedScore: 65, manualEntry: true, url: 'https://chicago.suntimes.com/review-a' });
  const { merged, stats } = mergeReviewsJson({ reviews: [corrected] }, { reviews: [wrongByline] });
  assert.equal(merged.reviews.length, 1);
  assert.equal(merged.reviews[0].criticName, 'Steven Oxman');
  assert.equal(stats.urlRescueConflicts, 1);
});

test('mergeReviewsJson: legitimate same-URL/different-critic pairs with NO manual entry involved are never collapsed (anastasia-2017 WSJ shape — real corpus case)', () => {
  const isherwood = review({ criticName: 'Charles Isherwood', outlet: 'The Wall Street Journal', assignedScore: 60, url: 'https://www.wsj.com/articles/anastasia-review-the-real-thing-1493152968' });
  const rothstein = review({ criticName: 'Edward Rothstein', outlet: 'The Wall Street Journal', assignedScore: 80, url: 'https://www.wsj.com/articles/anastasia-review-the-real-thing-1493152968' });
  const { merged, stats } = mergeReviewsJson({ reviews: [isherwood] }, { reviews: [rothstein] });
  assert.equal(merged.reviews.length, 2, 'both distinct critics must survive — a bare same-URL rule would wrongly collapse them');
  assert.equal(stats.urlRescueConflicts, 0);
  assert.equal(stats.conflicts, 0);
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

test('mergeReviewsJson: duplicate keys within the OURS side alone must not silently drop a real remote-only entry (independent-review P1 finding)', () => {
  // Regression: before the fix, each `ours` duplicate independently
  // "consumed" the SAME single remote match, so the second consumer's
  // resolution silently won and remote's genuinely distinct r1 vanished —
  // never unioned, never counted anywhere.
  const oursA = review({ assignedScore: 1 });
  const oursB = review({ assignedScore: 2 }); // same identity as oursA
  const r1 = review({ criticName: 'Someone Else', assignedScore: 3 }); // distinct identity, must survive
  const { merged, stats } = mergeReviewsJson({ reviews: [oursA, oursB] }, { reviews: [r1] });
  assert.equal(stats.oursDuplicateKeysSkipped, 1);
  assert.ok(merged.reviews.some(r => r.assignedScore === 1), 'first ours duplicate must survive');
  assert.ok(merged.reviews.some(r => r.assignedScore === 3), 'the distinct remote-only review must not be dropped');
  assert.equal(merged.reviews.length, 2);
});

test('mergeReviewsJson: same-side dedup keeps a manualEntry record over its non-manual pipeline twin, regardless of array order (codex 4th-pass finding)', () => {
  const pipelineTwin = review({ assignedScore: 30 }); // same identity as the manual record below
  const manualCorrection = review({ manualEntry: true, assignedScore: 85 });
  // Pipeline twin listed FIRST — blind first-occurrence-wins would silently
  // discard the manual correction before resolveConflict ever sees it.
  const { merged: mergedA } = mergeReviewsJson({ reviews: [pipelineTwin, manualCorrection] }, { reviews: [] });
  assert.equal(mergedA.reviews.length, 1);
  assert.equal(mergedA.reviews[0].manualEntry, true);
  assert.equal(mergedA.reviews[0].assignedScore, 85);

  // Order reversed — must still keep the manual one.
  const { merged: mergedB } = mergeReviewsJson({ reviews: [manualCorrection, pipelineTwin] }, { reviews: [] });
  assert.equal(mergedB.reviews.length, 1);
  assert.equal(mergedB.reviews[0].manualEntry, true);
});

test('mergeReviewsJson: _meta baseMeta stays consistent with lastUpdated when ONE side is unparseable, not just on an exact tie (codex 4th-pass finding)', () => {
  const ours = {
    reviews: [review({ criticName: 'Critic A' })],
    _meta: { lastUpdated: 'not-a-date', stats: { source: 'ours' } },
  };
  const remote = {
    reviews: [review({ criticName: 'Critic B' })],
    _meta: { lastUpdated: '2026-01-01T00:00:00.000Z', stats: { source: 'remote' } },
  };
  const { merged } = mergeReviewsJson(ours, remote);
  // newerIso falls back to remote (the only parseable side) — baseMeta must
  // track that, not silently default to ours' stats.
  assert.equal(merged._meta.lastUpdated, '2026-01-01T00:00:00.000Z');
  assert.equal(merged._meta.stats.source, 'remote');
});

test('mergeReviewsJson: two DIFFERENT manualEntry records for the same URL (independent-review P1 finding) resolve to one, not a permanent duplicate', () => {
  // e.g. two independent human corrections to the same article landing
  // with different critic names (different primary keys) — previously the
  // URL rescue explicitly skipped any candidate that was itself
  // manualEntry, so neither ever got reconciled against the other.
  const correctionV1 = review({ manualEntry: true, criticName: 'First Correction', assignedScore: 40, url: 'https://example.com/twice-corrected' });
  const correctionV2 = review({ manualEntry: true, criticName: 'Second Correction', assignedScore: 90, url: 'https://example.com/twice-corrected' });
  const { merged, stats } = mergeReviewsJson({ reviews: [correctionV1] }, { reviews: [correctionV2] });
  assert.equal(merged.reviews.length, 1, 'must not leave two live manualEntry records for the same article');
  assert.equal(merged.reviews[0].manualEntry, true);
  assert.equal(stats.urlRescueConflicts, 1);
});

test('mergeReviewsJson: _meta baseMeta on an exact-timestamp tie is internally consistent with lastUpdated (ties toward ours, matching newerIso)', () => {
  const ours = {
    reviews: [review({ criticName: 'Critic A' })],
    _meta: { lastUpdated: '2026-01-01T00:00:00.000Z', stats: { source: 'ours' } },
  };
  const remote = {
    reviews: [review({ criticName: 'Critic B' })],
    _meta: { lastUpdated: '2026-01-01T00:00:00.000Z', stats: { source: 'remote' } },
  };
  const { merged } = mergeReviewsJson(ours, remote);
  assert.equal(merged._meta.lastUpdated, '2026-01-01T00:00:00.000Z');
  assert.equal(merged._meta.stats.source, 'ours'); // must match whichever side lastUpdated came from
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
test('keyOf: unique across the real data/reviews.json corpus (no accidental key collisions)', (t) => {
  // An absent corpus must read as SKIPPED, not as a pass. A bare `return` here
  // is reported by node:test as a PASSING test, so this assertion went green in
  // every checkout without core data — an isolated worktree, for one, where
  // data/reviews.json is not present at all (crown rule 8).
  const reviewsPath = path.join(__dirname, '..', '..', 'data', 'reviews.json');
  if (!fs.existsSync(reviewsPath)) return t.skip('data/reviews.json not present in this checkout');
  const data = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
  const reviews = Array.isArray(data.reviews) ? data.reviews : [];
  if (reviews.length === 0) return t.skip('data/reviews.json carries no reviews');
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

// ---------------------------------------------------------------------------
// BRO-2916: Unknown-byline fossil rescue.
// A review first collected without a byline is written as criticName 'Unknown';
// a later pass resolves the real byline. keyOf treats those as two identities,
// so the disjoint-identity union preserves the sentinel row forever and
// validate-data.js reds main on "duplicate URL(s) within same show+outlet".
// ---------------------------------------------------------------------------

const SHARED_URL = 'https://www.radiotimes.com/going-out/going-out-reviews/into-the-woods-review/';

test('isUnknownByline: only the no-byline sentinel, never a real name that contains it', () => {
  for (const v of [null, undefined, '', '   ', 'Unknown', 'unknown', '  UNKNOWN  ']) {
    assert.equal(isUnknownByline(v), true, `expected sentinel: ${JSON.stringify(v)}`);
  }
  // A real byline must stay a distinct identity even when the word appears in it.
  for (const v of ['Unknown Theatre Collective', 'Olivia Garrett', 'Unknowne Smith', 'A. Unknown Jr']) {
    assert.equal(isUnknownByline(v), false, `expected real byline: ${JSON.stringify(v)}`);
  }
});

test('mergeReviewsJson: Unknown-byline fossil sharing a URL with a bylined row is dropped (BRO-2916)', () => {
  // The exact live shape: bylined complete review on ours, sentinel stub only on remote.
  const bylined = review({ criticName: 'Olivia Garrett', url: SHARED_URL, contentTier: 'complete', assignedScore: 97 });
  const fossil = review({ criticName: 'Unknown', url: SHARED_URL, contentTier: 'stub', assignedScore: 100 });
  const { merged, stats } = mergeReviewsJson(
    { _meta: { lastUpdated: '2026-09-06T09:00:00Z' }, reviews: [bylined] },
    { _meta: { lastUpdated: '2026-09-05T09:00:00Z' }, reviews: [fossil] },
  );
  const names = merged.reviews.map(r => r.criticName);
  assert.deepEqual(names, ['Olivia Garrett'], 'the sentinel row must not survive the union');
  assert.equal(stats.unknownBylineFossilsDropped, 1);
  // _meta.stats.totalReviews must track the post-drop count, not the pre-drop one.
  assert.equal(stats.totalReviews, 1);
});

test('mergeReviewsJson: fossil is dropped regardless of which side carries it', () => {
  const bylined = review({ criticName: 'Olivia Garrett', url: SHARED_URL, contentTier: 'complete' });
  const fossil = review({ criticName: 'Unknown', url: SHARED_URL, contentTier: 'stub' });
  const { merged, stats } = mergeReviewsJson(
    { _meta: { lastUpdated: '2026-09-06T09:00:00Z' }, reviews: [fossil] },
    { _meta: { lastUpdated: '2026-09-05T09:00:00Z' }, reviews: [bylined] },
  );
  assert.deepEqual(merged.reviews.map(r => r.criticName), ['Olivia Garrett']);
  assert.equal(stats.unknownBylineFossilsDropped, 1);
});

test('mergeReviewsJson: two REAL bylines on one URL are never collapsed (anastasia-2017 WSJ shape)', () => {
  // The 6 legitimate live pairs. If this ever starts failing, the fossil pass
  // has widened past the sentinel and is eating real reviews.
  const a = review({ criticName: 'Charles Isherwood', url: SHARED_URL, contentTier: 'complete' });
  const b = review({ criticName: 'Edward Rothstein', url: SHARED_URL, contentTier: 'complete' });
  const { merged, stats } = mergeReviewsJson(
    { _meta: { lastUpdated: '2026-09-06T09:00:00Z' }, reviews: [a] },
    { _meta: { lastUpdated: '2026-09-05T09:00:00Z' }, reviews: [b] },
  );
  assert.equal(merged.reviews.length, 2, 'two genuine co-bylines must both survive');
  assert.equal(stats.unknownBylineFossilsDropped, 0);
});

test('mergeReviewsJson: two sentinel rows with NO bylined twin are both kept (nothing to prefer)', () => {
  // Different outlets, same URL, both unbylined — the pass has no real byline to
  // anchor on, so it must not pick a winner arbitrarily.
  const a = review({ criticName: 'Unknown', outlet: 'Radio Times', url: SHARED_URL, contentTier: 'stub' });
  const b = review({ criticName: null, outlet: 'Time Out', url: SHARED_URL, contentTier: 'stub' });
  const { merged, stats } = mergeReviewsJson(
    { _meta: { lastUpdated: '2026-09-06T09:00:00Z' }, reviews: [a] },
    { _meta: { lastUpdated: '2026-09-05T09:00:00Z' }, reviews: [b] },
  );
  assert.equal(merged.reviews.length, 2);
  assert.equal(stats.unknownBylineFossilsDropped, 0);
});

test('mergeReviewsJson: a sentinel row on a DIFFERENT url is untouched', () => {
  const bylined = review({ criticName: 'Olivia Garrett', url: SHARED_URL, contentTier: 'complete' });
  const other = review({ criticName: 'Unknown', outlet: 'Time Out', url: 'https://www.timeout.com/london/other-review', contentTier: 'stub' });
  const { merged, stats } = mergeReviewsJson(
    { _meta: { lastUpdated: '2026-09-06T09:00:00Z' }, reviews: [bylined] },
    { _meta: { lastUpdated: '2026-09-05T09:00:00Z' }, reviews: [other] },
  );
  assert.equal(merged.reviews.length, 2);
  assert.equal(stats.unknownBylineFossilsDropped, 0);
});

// Corpus invariant: after this pass, no showId+URL may carry a sentinel row
// alongside a bylined one. Asserts its own setup so a missing/empty corpus
// FAILS loudly instead of passing as a silent no-op (crown rule 8).
test('no Unknown-byline fossil survives in the real data/reviews.json corpus', (t) => {
  const reviewsPath = path.join(__dirname, '..', '..', 'data', 'reviews.json');
  if (!fs.existsSync(reviewsPath)) return t.skip('data/reviews.json not present in this checkout');
  const data = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
  const reviews = Array.isArray(data.reviews) ? data.reviews : [];
  if (reviews.length === 0) return t.skip('data/reviews.json carries no reviews');
  const { merged } = mergeReviewsJson({ _meta: data._meta, reviews }, { _meta: data._meta, reviews: [] });
  assert.ok(merged.reviews.length > 1000, `setup check: expected a real corpus, got ${merged.reviews.length} reviews`);
  const bylinedUrls = new Set();
  for (const r of merged.reviews) if (!isUnknownByline(r.criticName)) { const k = urlKeyOf(r); if (k) bylinedUrls.add(k); }
  const fossils = merged.reviews
    .filter(r => isUnknownByline(r.criticName))
    .map(r => urlKeyOf(r))
    .filter(k => k && bylinedUrls.has(k));
  assert.deepEqual(fossils, [], `Unknown-byline fossils survived the merge: ${fossils.slice(0, 3).join(', ')}`);
});
