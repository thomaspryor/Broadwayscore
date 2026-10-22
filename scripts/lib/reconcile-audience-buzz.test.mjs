import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { reconcileAudienceBuzz } = require('./reconcile-audience-buzz.js');
const { filterToLiveShowIds, MIN_PLAUSIBLE_SHOWS } = require('./live-show-ids.js');

const live = (...extra) => new Set([...Array.from({ length: MIN_PLAUSIBLE_SHOWS }, (_, i) => `show-${i}`), ...extra]);

test('a concurrently added live show is recovered from remote (old behavior kept)', () => {
  const current = { shows: { 'show-1': { sources: {} } } };
  const remote = { shows: { 'show-1': { sources: {} }, 'show-2': { combinedScore: 80, sources: {} } } };
  const r = reconcileAudienceBuzz(current, remote, { liveIds: live() });
  assert.equal(r.recovered, 1);
  assert.equal(current.shows['show-2'].combinedScore, 80);
});

test('a deliberately dropped orphan key is not re-added (BRO-3248)', () => {
  const current = { shows: {} };
  const remote = { shows: { 'proof-express-test-2026': { sources: {} } } };
  const r = reconcileAudienceBuzz(current, remote, { liveIds: live() });
  assert.equal(r.recovered, 0);
  assert.deepEqual(r.skippedOrphans, ['proof-express-test-2026']);
  assert.equal(current.shows['proof-express-test-2026'], undefined);
});

test('a retired id stays out even when a stale remote shows.json still lists it', () => {
  const current = { shows: {} };
  const remote = { shows: { 'retired-x-2026': { sources: {} } } };
  const r = reconcileAudienceBuzz(current, remote, { liveIds: live('retired-x-2026'), retiredIds: new Set(['retired-x-2026']) });
  assert.equal(r.recovered, 0);
  assert.equal(current.shows['retired-x-2026'], undefined);
});

test('missing sources are still filled from remote for shared keys', () => {
  const current = { shows: { 'show-3': { sources: { mezzanine: { score: 80 } } } } };
  const remote = { shows: { 'show-3': { sources: { showScore: { score: 90 }, mezzanine: { score: 70 } } } } };
  reconcileAudienceBuzz(current, remote, { liveIds: live() });
  assert.equal(current.shows['show-3'].sources.showScore.score, 90);
  assert.equal(current.shows['show-3'].sources.mezzanine.score, 80, 'ours wins when present');
});

test('below the plausibility floor nothing is treated as an orphan', () => {
  const r = filterToLiveShowIds(['a', 'b'], new Set(['a']));
  assert.equal(r.filtered, false);
  assert.deepEqual(r.kept, ['a', 'b']);
  const current = { shows: {} };
  reconcileAudienceBuzz(current, { shows: { b: { sources: {} } } }, { liveIds: new Set(['a']) });
  assert.ok(current.shows.b, 'tiny shows.json = old recover-everything behavior');
});

test('BRO-5276: a source we removed on purpose (sourcesRemoved) is not refilled; an untombstoned one still is', () => {
  const current = { shows: { 'show-1': { sourcesRemoved: { theatr: 'closed before Theatr existed' }, sources: { showScore: null } } } };
  const remote = { shows: { 'show-1': { sources: { theatr: { score: 80, reviewCount: 30 }, mezzanine: { score: 70, reviewCount: 12 } } } } };
  const r = reconcileAudienceBuzz(current, remote, { liveIds: live() });
  assert.equal(current.shows['show-1'].sources.theatr, undefined);
  assert.equal(current.shows['show-1'].sources.mezzanine.score, 70);
  assert.equal(r.recovered, 1);
});

test('BRO-5276: removeSourceWithTombstone deletes the source and the reconcile then leaves it out', async () => {
  const { removeSourceWithTombstone } = require('./reconcile-audience-buzz.js');
  const show = { sources: { reddit: { score: 50, reviewCount: 20 }, showScore: { score: 80, reviewCount: 99 } } };
  removeSourceWithTombstone(show, 'reddit', 'not a Reddit market');
  assert.equal(show.sources.reddit, undefined);
  assert.equal(show.sourcesRemoved.reddit, 'not a Reddit market');
  const current = { shows: { 'show-1': show } };
  reconcileAudienceBuzz(current, { shows: { 'show-1': { sources: { reddit: { score: 50, reviewCount: 20 } } } } }, { liveIds: live() });
  assert.equal(current.shows['show-1'].sources.reddit, undefined);
});

test('BRO-5337: a source ours deleted (in base and remote) stays deleted on a live show', () => {
  const base = { shows: { 'show-4': { sources: { showScore: { score: 90 }, mezzanine: { score: 70 } } } } };
  const current = { shows: { 'show-4': { sources: { mezzanine: { score: 70 } } } } };
  const remote = { shows: { 'show-4': { sources: { showScore: { score: 90 }, mezzanine: { score: 70 } } } } };
  const r = reconcileAudienceBuzz(current, remote, { liveIds: live(), base });
  assert.equal(current.shows['show-4'].sources.showScore, undefined);
  assert.equal(r.recovered, 0);
  assert.deepEqual(r.skippedDeleted, ['show-4/showScore']);
});

test('BRO-5337: a live key ours deleted (in base and remote) is not re-added', () => {
  const base = { shows: { 'show-5': { sources: {} } } };
  const current = { shows: {} };
  const remote = { shows: { 'show-5': { sources: {} } } };
  const r = reconcileAudienceBuzz(current, remote, { liveIds: live(), base });
  assert.equal(current.shows['show-5'], undefined);
  assert.deepEqual(r.skippedDeleted, ['show-5']);
});

test('BRO-5337: a key and a source added only on remote are still kept', () => {
  const base = { shows: { 'show-6': { sources: { mezzanine: { score: 70 } } } } };
  const current = { shows: { 'show-6': { sources: { mezzanine: { score: 70 } } } } };
  const remote = { shows: { 'show-6': { sources: { mezzanine: { score: 70 }, showScore: { score: 88 } } }, 'show-7': { sources: {} } } };
  const r = reconcileAudienceBuzz(current, remote, { liveIds: live(), base });
  assert.equal(current.shows['show-6'].sources.showScore.score, 88);
  assert.ok(current.shows['show-7']);
  assert.equal(r.recovered, 2);
  assert.deepEqual(r.skippedDeleted, []);
});

test('BRO-5337: without a base the old refill behavior is unchanged', () => {
  const current = { shows: { 'show-8': { sources: {} } } };
  const remote = { shows: { 'show-8': { sources: { showScore: { score: 90 } } } } };
  reconcileAudienceBuzz(current, remote, { liveIds: live() });
  assert.equal(current.shows['show-8'].sources.showScore.score, 90);
});
