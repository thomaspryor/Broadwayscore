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
