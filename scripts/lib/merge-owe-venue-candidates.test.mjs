// BRO-4268: the staging file's push-time union merge. Replays the 2026-09-29
// lost update (Update Shows' stale copy overwrote 53 landed evidence rows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { mergeOweVenueCandidates, keyOf } = require('./merge-owe-venue-candidates.js');
const { candidateHash } = require('./owe-venue-staging.js');
const { findEntry } = require('./core-data-merge-registry.js');

const venue = (title, venueName) => ({ title, venue: venueName, source: `venue-page:${venueName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, candidateHash: candidateHash({ title, venue: venueName }) });
const evidence = (title, venueName) => ({ title, venue: venueName, source: 'audit-review-evidence', evidence: [{ kind: 'review-url', url: 'https://www.londonboxoffice.co.uk/news/post/x' }], candidateHash: candidateHash({ title, venue: venueName }) });

test('the 2026-09-29 race: a stale discovery copy (ours) no longer drops the evidence rows that landed on main (remote)', () => {
  const ours = [venue('Goblin', 'Park Theatre'), venue('The Silence And The Noise', 'Park Theatre')];
  const remote = [evidence('A Ghost in Your Ear', 'Hampstead Theatre Downstairs'), evidence('Flush', 'Arcola Theatre')];
  const { merged, stats } = mergeOweVenueCandidates(ours, remote);
  assert.equal(merged.length, 4);
  assert.deepEqual(stats, { added: 2, kept: 0, total: 4 });
  assert.ok(merged.some((c) => c.title === 'Flush'), 'the landed evidence row survives the stale push');
  assert.deepEqual(merged.slice(0, 2), ours, 'ours keeps its order and comes first');
});

test('shared key: ours wins (the pusher may have refreshed the row), remote copy is not duplicated', () => {
  const mine = { ...venue('Goblin', 'Park Theatre'), openingDate: '2026-10-01' };
  const theirs = { ...venue('Goblin', 'Park Theatre'), openingDate: null };
  const { merged, stats } = mergeOweVenueCandidates([mine], [theirs]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].openingDate, '2026-10-01');
  assert.equal(stats.kept, 1);
});

test('a row without candidateHash is keyed from title+venue, so hand-staged rows dedupe against discovery rows', () => {
  const hand = { title: 'Flush', venue: 'Arcola Theatre', source: 'audit-review-evidence' };
  assert.equal(keyOf(hand), candidateHash({ title: 'Flush', venue: 'Arcola Theatre' }));
  const { merged } = mergeOweVenueCandidates([hand], [venue('Flush', 'Arcola Theatre')]);
  assert.equal(merged.length, 1, 'same title+venue on both sides is one row');
});

test('the promoter prune is not sticky: rows remote still lists come back (re-pruned next run) rather than being lost', () => {
  const { merged, stats } = mergeOweVenueCandidates([], [venue('Goblin', 'Park Theatre')]);
  assert.equal(merged.length, 1);
  assert.equal(stats.added, 1);
});

test('non-array or junk input never throws; keyless rows pass through from both sides (same rule as the OB file)', () => {
  assert.deepEqual(mergeOweVenueCandidates(null, undefined).merged, []);
  assert.deepEqual(mergeOweVenueCandidates({ shows: [] }, 'x').merged, []);
  const { merged, stats } = mergeOweVenueCandidates([{ title: 'no venue' }], [{ venue: 'no title' }]);
  assert.equal(merged.length, 2, 'a keyless row on either side is kept verbatim — a missing key says nothing about whether it is a duplicate');
  assert.deepEqual(stats, { added: 1, kept: 0, total: 2 });
});

test('the OWE merge is the OB factory with a title+venue-deriving key — one rule set, not two twins', () => {
  const { makeVenueCandidatesMerge, mergeObVenueCandidates } = require('./merge-ob-venue-candidates.js');
  assert.equal(typeof makeVenueCandidatesMerge, 'function');
  const a = venue('Goblin', 'Park Theatre');
  assert.deepEqual(mergeOweVenueCandidates([a], []).merged, mergeObVenueCandidates([a], []).merged);
});

test('the registry routes data/audit/owe-venue-candidates.json (public-repo surface) through this merge', () => {
  const e = findEntry('data/audit/owe-venue-candidates.json', 'public-repo');
  assert.ok(e, 'registry entry exists');
  assert.equal(e.status, 'active');
  assert.equal(e.merge, mergeOweVenueCandidates);
  assert.equal(e.format, 'json');
  assert.equal(e.newline, false, 'owe-venue-staging.js writeStaging writes no trailing newline');
  assert.equal(e.apiFallbackMerge, true, 'the promoter bundles this file with apiFallbackSafe files — without apiFallbackMerge the commit would lose the Git Data API fast path (BRO-2435 shape)');
});

// BRO-4484: three-way mode. Every push-path caller hands a three-argument
// merger the common ancestor, so the promoter's prune now survives a race.
test('BRO-4484 race: the promoter pruned rows and main moved without touching the file — the prune survives (no REVERTED)', () => {
  const goblin = venue('Goblin', 'Park Theatre');
  const flush = evidence('Flush', 'Arcola Theatre');
  const base = [goblin, flush];
  const ours = [flush]; // promoter promoted Goblin and pruned it
  const remote = [goblin, flush]; // main moved, staging file untouched
  const { merged, stats } = mergeOweVenueCandidates(ours, remote, base);
  assert.deepEqual(merged, ours, 'final equals the run\'s own content, so content-survival sees "survived"');
  assert.equal(stats.ourDeletes, 1);
});

test('BRO-4484: with a base, rows another writer added after we read the file are still kept (the BRO-4268 lost update stays fixed)', () => {
  const goblin = venue('Goblin', 'Park Theatre');
  const ghost = evidence('A Ghost in Your Ear', 'Hampstead Theatre Downstairs');
  const { merged } = mergeOweVenueCandidates([], [goblin, ghost], [goblin]);
  assert.deepEqual(merged, [ghost]);
});

test('BRO-4484: a row the remote re-staged with fresh evidence beats our prune (one-cycle resurrection, re-pruned next run)', () => {
  const goblin = venue('Goblin', 'Park Theatre');
  const restaged = { ...goblin, evidence: [{ kind: 'venue-page', url: 'https://parktheatre.co.uk/goblin' }] };
  const { merged } = mergeOweVenueCandidates([], [restaged], [goblin]);
  assert.deepEqual(merged, [restaged]);
});

test('BRO-4484: a row remote pruned is not re-added by a stale copy that never edited it; an edited one is kept', () => {
  const goblin = venue('Goblin', 'Park Theatre');
  const flush = evidence('Flush', 'Arcola Theatre');
  const flushEdited = { ...flush, openingDate: '2026-11-02' };
  const { merged, stats } = mergeOweVenueCandidates([goblin, flushEdited], [], [goblin, flush]);
  assert.deepEqual(merged, [flushEdited]);
  assert.equal(stats.theirDeletes, 1);
});

test('BRO-4484: "unchanged since base" ignores key order', () => {
  const goblin = venue('Goblin', 'Park Theatre');
  const reordered = Object.fromEntries(Object.entries(goblin).reverse());
  const { merged } = mergeOweVenueCandidates([], [reordered], [goblin]);
  assert.deepEqual(merged, [], 'a writer that only reorders fields has not edited the row');
});

test('BRO-4484: the merger is three-argument and refuses a guessed base (reconcile-merged-json.js reads requiresTrueBase)', () => {
  assert.equal(mergeOweVenueCandidates.length, 3);
  assert.equal(mergeOweVenueCandidates.requiresTrueBase, true);
  assert.equal(findEntry('data/audit/owe-venue-candidates.json', 'public-repo').merge, mergeOweVenueCandidates);
});
