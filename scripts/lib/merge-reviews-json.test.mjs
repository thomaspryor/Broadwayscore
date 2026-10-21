import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeReviewsJson, keyOf, outletKey, urlKeyOf, resolveConflict, snapshotIsNewer, tierRank, isUnknownByline, isMergeFossilAnchor } from './merge-reviews-json.js';

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

test('keyOf: showId + outlet slug + criticKey(criticName)', () => {
  const r = review({ outlet: '  The Stage  ', criticName: 'A CRITIC ' });
  assert.equal(keyOf(r), 'anansi-the-spider-west-end-2026|the-stage|a critic');
});

test('keyOf: outlet display name and its slug are one outlet (BRO-4829 Manic Mumdays duplicate)', () => {
  assert.equal(keyOf(review({ outlet: 'Manic Mumdays' })), keyOf(review({ outlet: 'manic-mumdays' })));
  assert.notEqual(keyOf(review({ outlet: 'The Stage' })), keyOf(review({ outlet: 'The Standard' })));
  assert.equal(outletKey(''), 'unknown');
  assert.equal(outletKey('Théâtre Café'), 'theatre-cafe');
});

test('mergeReviewsJson: concurrent writers stamping display name vs slug merge to ONE row (BRO-4829)', () => {
  const ours = { _meta: { lastUpdated: '2026-10-07T02:34:00Z' }, reviews: [review({ outlet: 'Manic Mumdays', outletId: undefined, criticName: 'Cassie' })] };
  const remote = { _meta: { lastUpdated: '2026-10-07T02:30:00Z' }, reviews: [review({ outlet: 'manic-mumdays', outletId: 'suntimes-style-drift', criticName: 'Cassie' })] };
  const { merged } = mergeReviewsJson(ours, remote);
  assert.equal(merged.reviews.length, 1);
  assert.equal(merged.reviews[0].outlet, 'Manic Mumdays');
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

test('mergeReviewsJson: both sides manualEntry with no recency or tier difference keep ours', () => {
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
  assert.equal(stats.totalReviews, 1, 'returned stats must report the post-drop count');
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

test('mergeReviewsJson: an outlet-as-critic row may not anchor a deletion (isPlaceholderByline needs the outlet argument)', () => {
  // placeholder-byline.js's `norm === normOutlet` branch is only reachable
  // when `outlet` is passed. Called with the name alone it can never fire, so
  // a record whose criticName is literally its outlet read as a real byline
  // and could evict a genuine sentinel row at that same outlet.
  const outletAsCritic = review({
    criticName: 'Radio Times', outlet: 'Radio Times', outletId: 'radio-times',
    url: SHARED_URL, contentTier: 'complete',
  });
  const sentinel = review({
    criticName: 'Unknown', outlet: 'Radio Times', outletId: 'radio-times',
    url: SHARED_URL, contentTier: 'complete',
  });
  const { merged, stats } = mergeReviewsJson(
    { _meta: { lastUpdated: '2026-09-06T09:00:00Z' }, reviews: [outletAsCritic] },
    { _meta: { lastUpdated: '2026-09-05T09:00:00Z' }, reviews: [sentinel] },
  );
  assert.equal(stats.unknownBylineFossilsDropped, 0, 'an outlet name is not a byline, so it may not anchor');
  assert.equal(merged.reviews.length, 2, 'the genuine sentinel row must survive');
});

test('mergeReviewsJson: a self-branded critic also declines to anchor (known, bounded cost of omitting defaultCritic)', () => {
  // Pinned rather than left silent. Some review sites are named after their one
  // critic (placeholder-byline.js:52-61); without opts.defaultCritic — which
  // this merge driver cannot resolve, having no I/O — such a byline reads as a
  // placeholder and will not anchor. The consequence is a surviving duplicate
  // for validate-data.js to flag, never a deleted review. If this ever starts
  // failing, defaultCritic plumbing has arrived and the comment should follow.
  const selfBranded = review({
    criticName: 'Carole Di Tosti', outlet: 'Carole Di Tosti', outletId: 'carole-di-tosti',
    url: SHARED_URL, contentTier: 'complete',
  });
  const sentinel = review({
    criticName: 'Unknown', outlet: 'Carole Di Tosti', outletId: 'carole-di-tosti',
    url: SHARED_URL, contentTier: 'complete',
  });
  const { merged, stats } = mergeReviewsJson(
    { _meta: { lastUpdated: '2026-09-06T09:00:00Z' }, reviews: [selfBranded] },
    { _meta: { lastUpdated: '2026-09-05T09:00:00Z' }, reviews: [sentinel] },
  );
  assert.equal(stats.unknownBylineFossilsDropped, 0);
  assert.equal(merged.reviews.length, 2, 'declining to anchor keeps both rows — no review is ever deleted');
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
  // Assert the surviving rows are the two ORIGINAL sentinel rows, not just that
  // two of something survived — the title claims both are kept, so check both.
  assert.deepEqual(
    merged.reviews.map(r => r.outlet).sort(),
    ['Radio Times', 'Time Out'],
  );
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


test('mergeReviewsJson: a bylined scored pipeline row beats a stale unbylined manual row (BRO-2919)', () => {
  const bylined = review({ criticName: 'Olivia Garrett', url: SHARED_URL, contentTier: 'complete' });
  const manualUnbylined = review({ criticName: 'Unknown', url: SHARED_URL, contentTier: 'complete', manualEntry: true });
  const { merged, stats } = mergeReviewsJson(
    { _meta: { lastUpdated: '2026-09-06T09:00:00Z' }, reviews: [bylined] },
    { _meta: { lastUpdated: '2026-09-05T09:00:00Z' }, reviews: [manualUnbylined] },
  );
  assert.equal(merged.reviews.length, 1, 'the manual rescue collapses the pair before the fossil pass runs');
  assert.equal(merged.reviews[0], bylined, 'the enriched pipeline row is the survivor');
  assert.equal(stats.urlRescueConflicts, 1, 'ordering invariant: the manual rescue, not the fossil pass, resolved this');
  assert.equal(stats.unknownBylineFossilsDropped, 0, 'the fossil pass must not have touched a manual row');
});

test('mergeReviewsJson: manual URL rescue prefers enriched attribution on either side or array order', () => {
  const bylined = review({ criticName: 'Olivia Garrett', url: SHARED_URL });
  for (const criticName of ['Unknown', '', null, undefined]) {
    const manual = review({ criticName, url: SHARED_URL, manualEntry: true });
    for (const [ours, remote] of [
      [[manual], [bylined]], [[bylined], [manual]],
      [[manual, bylined], []], [[bylined, manual], []],
    ]) {
      const { merged } = mergeReviewsJson({ reviews: ours }, { reviews: remote });
      assert.deepEqual(merged.reviews, [bylined], `${criticName}: enriched row survives`);
    }
  }
});

test('mergeReviewsJson: named manual corrections retain priority even at a self-branded outlet', () => {
  const manual = review({ criticName: 'Carole Di Tosti', outlet: 'Carole Di Tosti', url: SHARED_URL, manualEntry: true });
  const pipeline = review({ criticName: 'Another Critic', outlet: manual.outlet, url: SHARED_URL });
  assert.deepEqual(mergeReviewsJson(
    { _meta: { lastUpdated: '2026-10-19' }, reviews: [manual] },
    { _meta: { lastUpdated: '2026-10-20' }, reviews: [pipeline] },
  ).merged.reviews, [manual]);
});

test('mergeReviewsJson: manual rescue does not use unscored, placeholder or poorer pipeline rows as enrichment', () => {
  const manual = review({ criticName: 'Unknown', url: SHARED_URL, manualEntry: true });
  for (const overrides of [
    { assignedScore: null }, { assignedScore: undefined }, { assignedScore: '70' },
    { criticName: 'Staff' }, { criticName: 'The Stage' }, { contentTier: 'stub' },
  ]) {
    const pipeline = review({ criticName: 'Olivia Garrett', url: SHARED_URL, ...overrides });
    const { merged } = mergeReviewsJson({ reviews: [manual] }, { reviews: [pipeline] });
    assert.deepEqual(merged.reviews, [manual]);
  }
});

test('mergeReviewsJson: stale manual removal requires the same outlet and raw path', () => {
  const manual = review({ criticName: 'Unknown', url: SHARED_URL, manualEntry: true });
  for (const overrides of [
    { outlet: 'The Guardian' },
    { url: SHARED_URL.toUpperCase() },
  ]) {
    const pipeline = review({ criticName: 'Olivia Garrett', url: SHARED_URL, ...overrides });
    const { merged } = mergeReviewsJson({ reviews: [manual] }, { reviews: [pipeline] });
    assert.deepEqual(merged.reviews, [manual], 'unconfirmed enrichment cannot evict the manual row');
  }
});

test('mergeReviewsJson: named manual URL rescue still works across outlet and path case drift', () => {
  const manual = review({ criticName: 'Steven Oxman', outlet: 'Chicago Sun-Times',
    outletId: 'chicago-sun-times', url: SHARED_URL, manualEntry: true });
  for (const overrides of [{}, { url: SHARED_URL.toUpperCase() }]) {
    const pipeline = review({ criticName: 'Another Critic', outlet: 'Sun-Times',
      outletId: 'suntimes', url: SHARED_URL, ...overrides });
    assert.deepEqual(mergeReviewsJson({ reviews: [manual] }, { reviews: [pipeline] }).merged.reviews, [manual]);
  }
  const otherShow = review({ showId: 'another-show-2026', url: SHARED_URL });
  assert.deepEqual(mergeReviewsJson({ reviews: [manual] }, { reviews: [otherShow] }).merged.reviews,
    [manual, otherShow]);
});

test('mergeReviewsJson: dropping stale manual attribution preserves multiple real bylines and tracks one drop', () => {
  const manual = review({ criticName: 'Unknown', url: SHARED_URL, manualEntry: true });
  const first = review({ criticName: 'Olivia Garrett', url: SHARED_URL });
  const second = review({ criticName: 'Another Critic', url: SHARED_URL });
  const { merged, stats } = mergeReviewsJson({ reviews: [manual] }, { reviews: [first, second] });
  assert.deepEqual(merged.reviews, [first, second]);
  assert.equal(stats.urlRescueConflicts, 1);
});

test('mergeReviewsJson: manual corrections use snapshot recency for both same-key and byline-swap conflicts', () => {
  for (const criticName of ['First Correction', 'Second Correction']) {
    const old = review({ criticName: 'First Correction', manualEntry: true, assignedScore: 40, url: SHARED_URL });
    const fresh = review({ criticName, manualEntry: true, assignedScore: 90, url: SHARED_URL });
    const older = { _meta: { lastUpdated: '2026-10-19' }, reviews: [old] };
    const newer = { _meta: { lastUpdated: '2026-10-20' }, reviews: [fresh] };
    for (const [ours, remote] of [[older, newer], [newer, older]]) {
      assert.deepEqual(mergeReviewsJson(ours, remote).merged.reviews, [fresh]);
    }
  }
});

test('mergeReviewsJson: manual byline-swap ties fall back to tier, then ours', () => {
  const first = review({ criticName: 'First Correction', manualEntry: true, contentTier: 'stub', url: SHARED_URL });
  const second = review({ criticName: 'Second Correction', manualEntry: true, contentTier: 'complete', url: SHARED_URL });
  for (const lastUpdated of [undefined, 'invalid', '2026-10-20']) {
    assert.deepEqual(mergeReviewsJson(
      { _meta: { lastUpdated }, reviews: [first] },
      { _meta: { lastUpdated }, reviews: [second] },
    ).merged.reviews, [second]);
  }
  assert.deepEqual(mergeReviewsJson(
    { reviews: [second] }, { reviews: [{ ...second, criticName: 'Third Correction' }] },
  ).merged.reviews, [second]);
});

test('mergeReviewsJson: same canonical key but a DIFFERENT raw path is NOT dropped', () => {
  // canonicalizeUrlForDedup lowercases the whole URL, so a host with
  // case-sensitive paths can collapse two genuinely different articles onto one
  // canonical key. Deleting on that alone would remove a real unbylined review
  // (adversarial-review finding, Codex). The raw-path guard is what stops it.
  const bylined = review({ criticName: 'Olivia Garrett', url: 'https://example.com/Reviews/Into-The-Woods', contentTier: 'complete' });
  const differentArticle = review({ criticName: 'Unknown', url: 'https://example.com/reviews/into-the-woods', contentTier: 'complete' });
  const { merged, stats } = mergeReviewsJson(
    { _meta: { lastUpdated: '2026-09-06T09:00:00Z' }, reviews: [bylined] },
    { _meta: { lastUpdated: '2026-09-05T09:00:00Z' }, reviews: [differentArticle] },
  );
  assert.equal(urlKeyOf(bylined), urlKeyOf(differentArticle), 'precondition: these must share a canonical key, or the test proves nothing');
  assert.equal(merged.reviews.length, 2, 'a case-only path difference must not authorise a deletion');
  assert.equal(stats.unknownBylineFossilsDropped, 0);
});

test('mergeReviewsJson: a fossil differing only by tracking parameters IS still dropped', () => {
  // The raw-path guard must not be so strict that it stops doing the job: the
  // two real canonical collapses in the live corpus are a WSJ gaa_* parameter
  // set and an NYT ?_r=1&, both the same article on a byte-identical path.
  const bylined = review({ criticName: 'Olivia Garrett', url: 'https://example.com/reviews/into-the-woods?utm_source=x', contentTier: 'complete' });
  const fossil = review({ criticName: 'Unknown', url: 'https://example.com/reviews/into-the-woods', contentTier: 'stub' });
  const { merged, stats } = mergeReviewsJson(
    { _meta: { lastUpdated: '2026-09-06T09:00:00Z' }, reviews: [bylined] },
    { _meta: { lastUpdated: '2026-09-05T09:00:00Z' }, reviews: [fossil] },
  );
  assert.deepEqual(merged.reviews.map(r => r.criticName), ['Olivia Garrett']);
  assert.equal(stats.unknownBylineFossilsDropped, 1);
});

test('mergeReviewsJson: every dropped fossil is recorded with provenance, not just counted', () => {
  // A pass that DELETES rows must leave enough behind to answer "what went
  // missing and why" from the merge result alone (adversarial-review finding,
  // Codex: the first version recorded only a tally).
  const bylined = review({ criticName: 'Olivia Garrett', url: SHARED_URL, contentTier: 'complete' });
  const fossil = review({ criticName: 'Unknown', url: SHARED_URL, contentTier: 'stub' });
  const { stats } = mergeReviewsJson(
    { _meta: { lastUpdated: '2026-09-06T09:00:00Z' }, reviews: [bylined] },
    { _meta: { lastUpdated: '2026-09-05T09:00:00Z' }, reviews: [fossil] },
  );
  assert.equal(stats.unknownBylineFossilsDroppedKeys.length, 1);
  const [rec] = stats.unknownBylineFossilsDroppedKeys;
  assert.equal(rec.url, SHARED_URL);
  assert.equal(rec.outlet, 'The Stage');
  assert.equal(rec.supersededBy, 'Olivia Garrett', 'the record must name which byline superseded it');
});

test('mergeReviewsJson: a bylined STUB never evicts a sentinel COMPLETE row', () => {
  // The inverse of the live shape, and the direction the first tests left
  // unpinned (codebase-review finding, Claude). Every other resolution path in
  // this module falls back to tierRank; deleting the richer row would lose its
  // text and score until the next uncontended rebuild.
  const bylinedStub = review({ criticName: 'Olivia Garrett', url: SHARED_URL, contentTier: 'stub' });
  const sentinelComplete = review({ criticName: 'Unknown', url: SHARED_URL, contentTier: 'complete' });
  const { merged, stats } = mergeReviewsJson(
    { _meta: { lastUpdated: '2026-09-06T09:00:00Z' }, reviews: [bylinedStub] },
    { _meta: { lastUpdated: '2026-09-05T09:00:00Z' }, reviews: [sentinelComplete] },
  );
  assert.equal(merged.reviews.length, 2, 'the richer sentinel row must survive a poorer bylined one');
  assert.equal(stats.unknownBylineFossilsDropped, 0);
});

test('mergeReviewsJson: an equal-tier bylined row DOES still evict the sentinel', () => {
  // The tier guard must not be so strict that it stops doing the job.
  const bylined = review({ criticName: 'Olivia Garrett', url: SHARED_URL, contentTier: 'complete' });
  const sentinel = review({ criticName: 'Unknown', url: SHARED_URL, contentTier: 'complete' });
  const { merged, stats } = mergeReviewsJson(
    { _meta: { lastUpdated: '2026-09-06T09:00:00Z' }, reviews: [bylined] },
    { _meta: { lastUpdated: '2026-09-05T09:00:00Z' }, reviews: [sentinel] },
  );
  assert.deepEqual(merged.reviews.map(r => r.criticName), ['Olivia Garrett']);
  assert.equal(stats.unknownBylineFossilsDropped, 1);
});

test('mergeReviewsJson: a generic placeholder byline cannot anchor a deletion', () => {
  // placeholder-byline.js's GENERIC_BYLINE_TERMS are distinct primary-key
  // identities (criticKey('Staff') is 'staff', not 'unknown'), so they DO reach
  // the fossil pass — and must not anchor it. Without isPlaceholderByline in
  // isMergeFossilAnchor, a 'Staff' row would evict a genuine sentinel row
  // (codebase-review finding, Claude).
  for (const junk of ['Staff', 'News Desk', 'Editorial Team']) {
    const junkRow = review({ criticName: junk, url: SHARED_URL, contentTier: 'complete' });
    const sentinel = review({ criticName: 'Unknown', url: SHARED_URL, contentTier: 'stub' });
    const { merged, stats } = mergeReviewsJson(
      { _meta: { lastUpdated: '2026-09-06T09:00:00Z' }, reviews: [junkRow] },
      { _meta: { lastUpdated: '2026-09-05T09:00:00Z' }, reviews: [sentinel] },
    );
    assert.equal(stats.unknownBylineFossilsDropped, 0, `"${junk}" must not anchor a deletion`);
    assert.ok(merged.reviews.some(r => isUnknownByline(r.criticName)), `the sentinel row must survive "${junk}"`);
  }
});

test('mergeReviewsJson: a punctuation-only byline is resolved by the PRIMARY key, never by the fossil pass', () => {
  // criticKey('\u2014') and criticKey('...') are both 'unknown', so such a row and a
  // sentinel row are the SAME primary identity and the ordinary conflict
  // resolution collapses them long before this pass runs. Asserting the sentinel
  // "survives" here would be wrong — what matters is that the fossil pass is not
  // what removed it, since criticKey and isUnknownByline disagree on these names.
  for (const junk of ['\u2014', '...']) {
    const junkRow = review({ criticName: junk, url: SHARED_URL, contentTier: 'complete' });
    const sentinel = review({ criticName: 'Unknown', url: SHARED_URL, contentTier: 'stub' });
    assert.equal(keyOf(junkRow), keyOf(sentinel), `precondition: "${junk}" must share a primary key with the sentinel`);
    const { merged, stats } = mergeReviewsJson(
      { _meta: { lastUpdated: '2026-09-06T09:00:00Z' }, reviews: [junkRow] },
      { _meta: { lastUpdated: '2026-09-05T09:00:00Z' }, reviews: [sentinel] },
    );
    assert.equal(merged.reviews.length, 1, 'same primary key collapses to one row');
    assert.equal(stats.unknownBylineFossilsDropped, 0, `the fossil pass must not be the mechanism for "${junk}"`);
  }
});

test('mergeReviewsJson: a cross-outlet pair sharing one aggregator URL is NEVER collapsed', () => {
  // urlKeyOf deliberately carries no outlet, and the source writer documents
  // that aggregator roundup URLs are legitimately shared ACROSS outlets. On URL
  // alone, a named Guardian row and a genuinely unbylined FT row backed by one
  // roundup page would collapse and an outlet would vanish from the composite
  // (adversarial-review finding, Codex). validate-data.js reports duplicates
  // "within same show+outlet", so this pass is scoped the same way.
  const guardianNamed = review({ criticName: 'Arifa Akbar', outlet: 'Guardian', url: SHARED_URL, contentTier: 'complete' });
  const ftUnbylined = review({ criticName: 'Unknown', outlet: 'Financial Times', url: SHARED_URL, contentTier: 'complete' });
  const { merged, stats } = mergeReviewsJson(
    { _meta: { lastUpdated: '2026-09-06T09:00:00Z' }, reviews: [guardianNamed] },
    { _meta: { lastUpdated: '2026-09-05T09:00:00Z' }, reviews: [ftUnbylined] },
  );
  assert.equal(merged.reviews.length, 2, 'two outlets sharing a roundup URL are two reviews');
  assert.equal(stats.unknownBylineFossilsDropped, 0);
});

test('mergeReviewsJson: provenance records every drop, including showId, across multiple fossils', () => {
  // The single-drop provenance test checked one record and only three of its
  // fields (adversarial-review finding, Codex: it asserted less than its name).
  const rows = [];
  for (const n of [1, 2]) {
    const url = `https://example.com/reviews/show-${n}`;
    rows.push(review({ showId: `show-${n}`, criticName: `Critic ${n}`, outlet: 'Radio Times', url, contentTier: 'complete' }));
    rows.push(review({ showId: `show-${n}`, criticName: 'Unknown', outlet: 'Radio Times', url, contentTier: 'stub' }));
  }
  const { merged, stats } = mergeReviewsJson(
    { _meta: { lastUpdated: '2026-09-06T09:00:00Z' }, reviews: rows },
    { _meta: { lastUpdated: '2026-09-05T09:00:00Z' }, reviews: [] },
  );
  assert.equal(stats.unknownBylineFossilsDropped, 2);
  assert.equal(stats.unknownBylineFossilsDroppedKeys.length, 2);
  assert.deepEqual(
    stats.unknownBylineFossilsDroppedKeys.map(k => k.showId).sort(),
    ['show-1', 'show-2'],
    'each dropped row must name the show it came from',
  );
  for (const k of stats.unknownBylineFossilsDroppedKeys) {
    assert.equal(k.outlet, 'Radio Times');
    assert.ok(k.url && k.url.startsWith('https://example.com/reviews/show-'));
    assert.ok(/^Critic [12]$/.test(k.supersededBy), `supersededBy must name the winning byline, got ${k.supersededBy}`);
  }
  assert.equal(merged.reviews.length, 2, 'exactly the two bylined rows remain');
});

// BRO-4852: run 37705532802 rebuilt reviews.json without seven wrongShow rows,
// lost the push race, and the two-way union put all seven back ("added":8).
test('mergeReviewsJson with base: rows our rebuild excluded stay excluded; real remote additions survive (BRO-4852)', () => {
  const row = (showId, outlet, extra = {}) => ({ showId, outlet, outletId: outlet.toLowerCase(), criticName: null, assignedScore: 85, ...extra });
  const excluded = [
    row('two-girls-off-broadway-2026', 'The Guardian'), row('two-girls-off-broadway-2026', 'The New York Times'),
    row('two-girls-off-broadway-2026', 'Theatrely'), row('two-girls-off-broadway-2026', 'Vulture'),
    row('midnight-off-broadway-2026', 'BroadwayWorld', { criticName: 'Michael Major' }),
    row('midnight-off-broadway-2026', 'BroadwayWorld', { criticName: 'Persson Clementine Scott' }),
    row('and-juliet-tour-2024', 'Deadline'),
  ];
  const kept = row('wicked-2003', 'Variety', { criticName: 'Marilyn Stasio' });
  const base = { _meta: { lastUpdated: '2026-10-08T00:00:00Z' }, reviews: [kept, ...excluded] };
  const ours = { _meta: { lastUpdated: '2026-10-08T00:05:25Z' }, reviews: [kept] };
  const newRemote = row('soon-off-broadway-2026', 'Time Out', { criticName: 'Adam Feldman' });
  const remote = { _meta: { lastUpdated: '2026-10-08T00:05:46Z' }, reviews: [kept, ...excluded, newRemote] };

  const { merged, stats } = mergeReviewsJson(ours, remote, base);
  assert.deepEqual(merged.reviews.map((r) => r.showId).sort(), ['soon-off-broadway-2026', 'wicked-2003']);
  assert.equal(stats.droppedByOurs, 7);
  assert.equal(stats.droppedByOursKeys.length, 7);
  assert.equal(stats.added, 1);

  // No base: legacy two-way union (all 8 come back).
  assert.equal(mergeReviewsJson(ours, remote).merged.reviews.length, 9);
});

test('mergeReviewsJson with base: a remote row edited since base, or a manualEntry row, is kept (BRO-4852)', () => {
  const r = { showId: 'x-2026', outlet: 'Variety', criticName: 'A B', assignedScore: 70 };
  const m = { showId: 'y-2026', outlet: 'Vulture', criticName: 'C D', assignedScore: 60, manualEntry: true };
  const base = { reviews: [r, m] };
  const ours = { reviews: [] };
  const remote = { reviews: [{ ...r, assignedScore: 75 }, m] };
  const { merged, stats } = mergeReviewsJson(ours, remote, base);
  assert.equal(merged.reviews.length, 2);
  assert.equal(stats.droppedByOurs, 0);
  assert.equal(mergeReviewsJson.requiresTrueBase, true);
});

// BRO-2944: orphan rows (no review-text file behind them) used to survive every
// rebuild through the two-way union, and rebuild-all-reviews.js then
// auto-registered their outletId, so a deleted outlet came back (suntimes,
// after BRO-2921 merged it into chicago-sun-times). With a base, a pipeline row
// our rebuild no longer emits is dropped, so the outlet id leaves the merged
// set the auto-register reads. Hand-entered rows (manualEntry, e.g. the
// Berkeley Rep Galileo regional reviews, which have no review-text files by
// design) are deliberate and stay.
test('mergeReviewsJson with base: orphan rows naming a deleted outlet are dropped; manualEntry rows stay (BRO-2944)', () => {
  const orphanA = { showId: 'paranormal-activity-chicago-regional-2025', outlet: 'Chicago Sun-Times', outletId: 'suntimes', criticName: 'Steven Oxman', url: 'https://chicago.suntimes.com/x', contentTier: 'excerpt' };
  const orphanB = { ...orphanA, showId: 'paranormal-activity-national-tour-regional-2025' };
  const manual = { showId: 'galileo-berkeley-rep-regional-2024', outlet: 'KQED', outletId: 'kqed', criticName: 'David John Chávez', assignedScore: 56, manualEntry: true, url: 'https://www.kqed.org/arts/13958082/galileo-review-theater-berkeley-rep' };
  // Same display outlet and critic as orphanA, so the same merge key: the relabelled row.
  const relabelled = { ...orphanA, outletId: 'chicago-sun-times' };
  const base = { _meta: { lastUpdated: '2026-09-07T21:50:00Z' }, reviews: [orphanA, orphanB, manual] };
  const ours = { _meta: { lastUpdated: '2026-09-07T21:53:41Z' }, reviews: [relabelled] }; // rebuild emits only file-backed rows
  // The other writer pushed later without touching these rows: its snapshot is newer.
  const remote = { _meta: { lastUpdated: '2026-09-07T22:01:52Z' }, reviews: [orphanA, orphanB, manual] };
  const { merged, stats } = mergeReviewsJson(ours, remote, base);
  const outletIds = new Set(merged.reviews.map((r) => r.outletId));
  assert.equal(outletIds.has('suntimes'), false, 'deleted outlet must not survive in the merged rows');
  assert.ok(outletIds.has('chicago-sun-times'), 'our relabel wins the same-key conflict: remote never changed it');
  assert.ok(outletIds.has('kqed'), 'hand-entered regional row is kept');
  assert.equal(stats.conflictsRemoteUnchanged, 1);
  assert.equal(stats.droppedByOurs, 1);

  // A remote row the other writer DID change since base still goes through the normal rules.
  const remoteEdited = { _meta: remote._meta, reviews: [{ ...orphanA, assignedScore: 66 }, orphanB, manual] };
  const r2 = mergeReviewsJson(ours, remoteEdited, base);
  assert.equal(r2.stats.conflictsRemoteUnchanged, 0);
  assert.equal(r2.merged.reviews.find((r) => r.showId === orphanA.showId).outletId, 'suntimes', 'newer remote edit wins as before');
  // A manual remote row unchanged since base still beats a pipeline row.
  const manualRemote = { ...orphanA, manualEntry: true };
  const r3 = mergeReviewsJson(ours, { _meta: remote._meta, reviews: [manualRemote] }, { reviews: [manualRemote] });
  assert.equal(r3.merged.reviews[0].manualEntry, true);
});
