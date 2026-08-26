import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeObVenueCandidates, keyOf } from './merge-ob-venue-candidates.js';

test('disjoint candidates from both sides all survive (the actual #788-class race)', () => {
  // Simulates the real BRO-158 scenario: two separate GitHub Actions runners
  // (extract-aggregator-candidates.js and promote-ob-venue-candidates.js)
  // each staged/pruned in their own checkout, then one push conflicts.
  const ours = [{ candidateHash: 'a', title: 'Show A', venue: 'V1' }];
  const remote = [{ candidateHash: 'b', title: 'Show B', venue: 'V2' }];
  const { merged, stats } = mergeObVenueCandidates(ours, remote);
  assert.deepEqual(merged.map((c) => c.candidateHash).sort(), ['a', 'b']);
  assert.equal(stats.added, 1);
  assert.equal(stats.kept, 0);
});

test('collision on candidateHash: ours wins (matches -X ours rebase strategy)', () => {
  const ours = [{ candidateHash: 'a', title: 'Show A (ours)', venue: 'V1', evidence: 'ours-evidence' }];
  const remote = [{ candidateHash: 'a', title: 'Show A (remote)', venue: 'V1', evidence: 'remote-evidence' }];
  const { merged, stats } = mergeObVenueCandidates(ours, remote);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].evidence, 'ours-evidence');
  assert.equal(stats.kept, 1);
});

test('a candidate pruned out of ours (promotion) does not resurrect from remote if remote also lacks it', () => {
  // promote-ob-venue-candidates.js's rewriteStaging() removes a promoted
  // hash BEFORE this merge runs (via updateStaging), so "ours" here already
  // reflects the removal — the merge itself only unions what's present on
  // each side, it never re-adds something neither side currently carries.
  const ours = [{ candidateHash: 'b', title: 'Show B', venue: 'V2' }];
  const remote = [{ candidateHash: 'b', title: 'Show B', venue: 'V2' }];
  const { merged } = mergeObVenueCandidates(ours, remote);
  assert.equal(merged.length, 1);
});

test('a candidate remote pruned but ours still has: ours wins (the collision rule), stays staged', () => {
  // Known accepted limitation, same shape as mergeDiaryShows's field-update
  // limitation: a same-run-window prune-vs-stage collision resolves to
  // "ours" like any other collision. The pruned candidate simply survives
  // one more cycle rather than being silently duplicated or double-lost.
  const oursStillHasIt = [{ candidateHash: 'c', title: 'Show C', venue: 'V3' }];
  const remotePrunedIt = [];
  const { merged } = mergeObVenueCandidates(oursStillHasIt, remotePrunedIt);
  assert.equal(merged.length, 1);
});

test('KNOWN LIMITATION: ours just pruned a hash (promoted), remote has not observed the removal yet — the hash is resurrected for one cycle', () => {
  // This is the union-vs-tombstone gap flagged in second-opinion review
  // (2026-08-26): mergeObVenueCandidates cannot distinguish "remote never
  // had this hash" from "remote hasn't re-pruned an already-promoted hash
  // yet" — both look identical (present on one side, absent on the other),
  // so the union adds it back in. Accepted: the next promote/extract run
  // re-derives "already in shows.json" and prunes it again — a transient
  // resurrection is categorically safer than the alternative this whole fix
  // exists to prevent (a candidate silently LOST forever). Do not "fix" this
  // by flipping the collision rule to prefer absence — that would resurrect
  // nothing here, but it would also make a genuinely fresh remote-only
  // candidate indistinguishable from one ours never fetched, silently
  // dropping real discoveries instead.
  const oursJustPromotedItAway = [];
  const remoteStillHasIt = [{ candidateHash: 'd', title: 'Show D', venue: 'V4' }];
  const { merged } = mergeObVenueCandidates(oursJustPromotedItAway, remoteStillHasIt);
  assert.equal(merged.length, 1, 'documents the resurrection — this is expected, not a regression');
  assert.equal(merged[0].candidateHash, 'd');
});

test('keyless (malformed/legacy) entries on both sides pass through unchanged, never dropped', () => {
  const ours = [{ title: 'No hash A', venue: 'V1' }];
  const remote = [{ title: 'No hash B', venue: 'V2' }];
  const { merged } = mergeObVenueCandidates(ours, remote);
  assert.equal(merged.length, 2);
});

test('missing/malformed input defaults to empty array', () => {
  const { merged } = mergeObVenueCandidates(null, undefined);
  assert.deepEqual(merged, []);
});

test('order: ours first (unchanged), then remote-only entries appended in remote order', () => {
  const ours = [{ candidateHash: 'a' }, { candidateHash: 'b' }];
  const remote = [{ candidateHash: 'c' }, { candidateHash: 'd' }];
  const { merged } = mergeObVenueCandidates(ours, remote);
  assert.deepEqual(merged.map((c) => c.candidateHash), ['a', 'b', 'c', 'd']);
});

test('keyOf returns candidateHash or null', () => {
  assert.equal(keyOf({ candidateHash: 'x' }), 'x');
  assert.equal(keyOf({}), null);
  assert.equal(keyOf(null), null);
});
