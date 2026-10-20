// applyCoverageFloor: the show page's score floor, shared by the website and
// the app feed's cr.pq. Run: node --test scripts/lib/coverage-floor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { applyCoverageFloor, SCORE_REGRESSION_FLOOR_HOURS } = require('./coverage-floor.js');
const { loadCoverageFloorInputs, coverageFloorOptsForShow, COVERAGE_ACK_NS_SUFFIX } = require('./coverage-floor-inputs.js');

const NOW = Date.parse('2026-10-20T12:00:00Z');
const hoursAgo = h => new Date(NOW - h * 3600 * 1000).toISOString();

test('a score public for more than 24h is shown whatever else says TBD', () => {
  assert.equal(SCORE_REGRESSION_FLOOR_HOURS, 24);
  assert.equal(applyCoverageFloor(true, { scorePublicSince: hoursAgo(25), now: NOW }), false);
  assert.equal(applyCoverageFloor(true, { scorePublicSince: hoursAgo(25), coverageState: 'incomplete', now: NOW }), false);
  // Under 24h the plain gate still decides
  assert.equal(applyCoverageFloor(true, { scorePublicSince: hoursAgo(23), now: NOW }), true);
  assert.equal(applyCoverageFloor(false, { scorePublicSince: hoursAgo(23), coverageState: 'incomplete', now: NOW }), false);
});

test('a never-public score waits while coverage is incomplete, unless acked', () => {
  assert.equal(applyCoverageFloor(false, { coverageState: 'incomplete', now: NOW }), true);
  assert.equal(applyCoverageFloor(false, { coverageState: 'incomplete', coverageAcked: true, now: NOW }), false);
  assert.equal(applyCoverageFloor(false, { coverageState: 'complete', now: NOW }), false);
});

test('fails open: no inputs means the plain gate', () => {
  assert.equal(applyCoverageFloor(false), false);
  assert.equal(applyCoverageFloor(true), true);
  assert.equal(applyCoverageFloor(true, { scorePublicSince: 'not a date', now: NOW }), true);
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cov-floor-'));
  mkdirSync(join(dir, 'audit'));
  writeFileSync(join(dir, 'audit', 'show-review-gap.json'), JSON.stringify({ results: [
    { showId: 'a', censusVerdict: { verdict: 'incomplete', liveCount: 3, candidateCount: 5 }, computedAt: '2026-10-01' },
    { showId: 'b' },
  ] }));
  writeFileSync(join(dir, 'audit', 'score-public-since.json'), JSON.stringify({ a: '2026-10-01T00:00:00Z', c: '2026-10-08T00:00:00Z' }));
  writeFileSync(join(dir, 'audit', 't1-coverage-ack.json'), JSON.stringify([{ key: `a${COVERAGE_ACK_NS_SUFFIX}` }, { key: 'b::other' }]));
  return dir;
}

test('loader reads verdicts, stamps and newsletter-gap acks', () => {
  const inputs = loadCoverageFloorInputs(fixture(), {});
  assert.equal(inputs.covByShowId.get('a').state, 'incomplete');
  assert.equal(inputs.covByShowId.has('b'), false, 'a result without a verdict is skipped');
  assert.equal(inputs.scorePublicSinceByShowId.get('a'), '2026-10-01T00:00:00Z');
  assert.deepEqual([...inputs.coverageAckedShowIds], ['a']);
  assert.deepEqual(coverageFloorOptsForShow(inputs, { id: 'a', openingDate: '2026-09-30' }), {
    scorePublicSince: '2026-10-01T00:00:00Z', coverageState: 'incomplete', coverageAcked: true,
  });
  // A stamp from before the first preview (no opening date yet) is dropped.
  assert.equal(coverageFloorOptsForShow(inputs, { id: 'c', previewsStartDate: '2026-12-18' }).scorePublicSince, undefined);
});

test('loader: kill switch and missing files leave every map empty', () => {
  const off = loadCoverageFloorInputs(fixture(), { COVERAGE_GATE_DISABLED: 'true' });
  assert.equal(off.covByShowId.size + off.scorePublicSinceByShowId.size + off.coverageAckedShowIds.size, 0);
  const none = loadCoverageFloorInputs(mkdtempSync(join(tmpdir(), 'cov-floor-empty-')), {});
  assert.equal(none.covByShowId.size + none.scorePublicSinceByShowId.size + none.coverageAckedShowIds.size, 0);
});
