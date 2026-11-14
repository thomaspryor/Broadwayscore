// Coverage Verdict S3 (task #905) — coverage digest snapshot builder.
// Run: node --test scripts/produce-coverage-digest-snapshot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildSnapshot } = require('./produce-coverage-digest-snapshot.js');

test('buildSnapshot renders the plan\'s example line and a "known reviews live" banner', () => {
  const gapAudit = {
    results: [{
      title: 'The Car Man',
      showId: 'the-car-man-west-end-2026',
      censusVerdict: { verdict: 'incomplete', liveCount: 11, candidateCount: 14 },
      missing: [{ url: 'a' }, { url: 'b' }, { url: 'c', priorRun: true }],
    }],
  };
  const snapshot = buildSnapshot(gapAudit, '2026-08-03T12:00:00.000Z');
  assert.strictEqual(snapshot.generatedAt, '2026-08-03T12:00:00.000Z');
  assert.strictEqual(snapshot.items.length, 1);
  assert.strictEqual(snapshot.items[0].title, 'The Car Man');
  assert.match(snapshot.items[0].detail, /known reviews live/);
  assert.match(snapshot.bannerText, /known reviews live/);
});

test('buildSnapshot: quiet day (nothing incomplete) still says "known reviews live"', () => {
  const snapshot = buildSnapshot({ results: [] }, '2026-08-03T12:00:00.000Z');
  assert.deepStrictEqual(snapshot.items, []);
  assert.match(snapshot.bannerText, /known reviews live/);
});

test('buildSnapshot: missing/null gapAudit degrades to empty, never throws', () => {
  const snapshot = buildSnapshot(null, '2026-08-03T12:00:00.000Z');
  assert.deepStrictEqual(snapshot.items, []);
});

test('buildSnapshot adds advisory rows for reviews in outlet feeds that are not ingested (BRO-5358)', () => {
  const feed = { gaps: [
    { showId: 'fish-off-broadway-2026', title: 'Fish', level: 'matched', outletId: 'theater-pizzazz' },
    { showId: 'fish-off-broadway-2026', title: 'Fish', level: 'matched', outletId: 'off-off-online' },
    { showId: 'x', title: 'X', level: 'possible', outletId: 'q' },
  ] };
  const snap = buildSnapshot({ results: [] }, '2026-10-14T00:00:00.000Z', feed);
  assert.equal(snap.items.length, 1);
  assert.match(snap.items[0].detail, /^2 reviews in outlet feeds not ingested \(theater-pizzazz, off-off-online\) \(advisory\)$/);
  assert.match(snap.bannerText, /1 new show\(s\) with reviews in outlet feeds/);
  assert.equal(buildSnapshot({ results: [] }, 'now').items.length, 0);
});

test('buildSnapshot drops rows for show ids not in shows.json (BRO-5349)', () => {
  const row = (showId) => ({ showId, title: showId, censusVerdict: { verdict: 'incomplete', liveCount: 1, candidateCount: 3 }, missing: [{ url: 'a' }, { url: 'b' }] });
  const audit = { results: [row('live-show-2026'), row('retired-dupe-2026')] };
  const ids = (s) => s.items.map((it) => it.title);
  assert.deepStrictEqual(ids(buildSnapshot(audit, '2026-10-18T00:00:00Z', null, new Set(['live-show-2026']))), ['live-show-2026']);
  assert.strictEqual(buildSnapshot(audit, '2026-10-18T00:00:00Z').items.length, 2);
});
