import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSnapshot } = require('../../scripts/snapshot-audience-full.js');

test('keeps only finite numeric source fields, drops url/strings/objects', () => {
  const buzz = {
    shows: {
      x: {
        title: 'X',
        combinedScore: 80,
        designation: 'Liking',
        sources: {
          theatr: { score: 90, reviewCount: 5, numLikes: 3, url: 'http://x', lastUpdated: '2026-01-01', ratingDistribution: { 5: 2 } },
        },
      },
    },
    _meta: {},
  };
  const snap = buildSnapshot(buzz, '2026-06-21');
  assert.deepEqual(snap.shows.x.sources.theatr, { score: 90, reviewCount: 5, numLikes: 3 });
  assert.equal(snap.shows.x.title, 'X');
  assert.equal(snap.shows.x.combinedScore, 80);
  assert.equal(snap.shows.x.designation, 'Liking');
});

test('omits a source that carries no numeric signal', () => {
  const buzz = { shows: { y: { sources: { reddit: { suppressed: true, suppressedReason: 'low volume', lastUpdated: '2026-01-01' } } } } };
  const snap = buildSnapshot(buzz, '2026-06-21');
  assert.deepEqual(snap.shows.y.sources, {});
});

test('NaN/Infinity are not treated as numeric', () => {
  const buzz = { shows: { z: { sources: { showScore: { score: NaN, reviewCount: Infinity, real: 7 } } } } };
  const snap = buildSnapshot(buzz, '2026-06-21');
  assert.deepEqual(snap.shows.z.sources.showScore, { real: 7 });
});

test('sourceCoverage counts shows per source; sources list = coverage keys', () => {
  const buzz = {
    shows: {
      a: { sources: { theatr: { score: 1 }, mezzanine: { score: 2 } } },
      b: { sources: { theatr: { score: 3 } } },
      c: { sources: {} },
    },
    _meta: { sources: ['StaleList'] }, // must be ignored
  };
  const snap = buildSnapshot(buzz, '2026-06-21');
  assert.equal(snap._meta.sourceCoverage.theatr, 2);
  assert.equal(snap._meta.sourceCoverage.mezzanine, 1);
  assert.deepEqual(snap._meta.sources.sort(), ['mezzanine', 'theatr']);
  assert.equal(snap._meta.totalShows, 3);
});

test('pure: no snapshotAt (added only at write time), deterministic', () => {
  const buzz = { shows: { a: { sources: { theatr: { score: 1 } } } }, _meta: {} };
  const one = buildSnapshot(buzz, '2026-06-21');
  const two = buildSnapshot(buzz, '2026-06-21');
  assert.ok(!('snapshotAt' in one._meta));
  assert.deepEqual(one, two);
  assert.equal(one._meta.snapshotDate, '2026-06-21');
});

test('handles empty/missing shows without throwing', () => {
  assert.equal(buildSnapshot({ shows: {} }, '2026-06-21')._meta.totalShows, 0);
  assert.equal(buildSnapshot({}, '2026-06-21')._meta.totalShows, 0);
});
