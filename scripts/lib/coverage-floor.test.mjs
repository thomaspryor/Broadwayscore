// applyCoverageFloor: the show page's score floor, shared by the website and
// the app feed's cr.pq. Run: node --test scripts/lib/coverage-floor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { applyCoverageFloor, SCORE_REGRESSION_FLOOR_HOURS } = require('./coverage-floor.js');
const {
  loadCoverageFloorInputs, coverageFloorOptsForShow, coverageFloorSnapshot,
  COVERAGE_ACK_NS_SUFFIX, COVERAGE_FLOOR_SNAPSHOT_FILE,
} = require('./coverage-floor-inputs.js');

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

// BRO-5811: data/audit/** is not in the Vercel server functions, so a page
// re-rendered at runtime reads the prebuild snapshot. It must reach the same
// TBD/score decision as the static build that read the raw audits.
function decide(inputs, show, reviewCountTBD = false) {
  return applyCoverageFloor(reviewCountTBD, { ...coverageFloorOptsForShow(inputs, show), now: NOW });
}

test('runtime re-render (no data/audit, snapshot only) holds the same shows at TBD as the build', () => {
  const dir = fixture();
  // The 'held' show: census incomplete, never public, not acked.
  writeFileSync(join(dir, 'audit', 'show-review-gap.json'), JSON.stringify({ results: [
    { showId: 'held', censusVerdict: { verdict: 'incomplete', liveCount: 1, candidateCount: 4 }, computedAt: '2026-10-19' },
    { showId: 'a', censusVerdict: { verdict: 'incomplete', liveCount: 3, candidateCount: 5 } },
  ] }));
  const built = loadCoverageFloorInputs(dir, {});
  writeFileSync(join(dir, COVERAGE_FLOOR_SNAPSHOT_FILE), JSON.stringify(coverageFloorSnapshot(built)));
  rmSync(join(dir, 'audit'), { recursive: true });

  const runtime = loadCoverageFloorInputs(dir, {});
  assert.deepEqual(runtime, built, 'snapshot round-trips to the same maps');
  const held = { id: 'held', openingDate: '2026-10-15' };
  assert.equal(decide(built, held), true, 'build holds the show at TBD');
  assert.equal(decide(runtime, held), true, 'runtime re-render holds it too (was: fails open)');
  for (const show of [{ id: 'a', openingDate: '2026-09-30' }, { id: 'c', openingDate: '2026-10-01' }, { id: 'z' }]) {
    assert.equal(decide(runtime, show), decide(built, show), `same decision for ${show.id}`);
  }
  // Kill switch still wins at runtime.
  const off = loadCoverageFloorInputs(dir, { COVERAGE_GATE_DISABLED: 'true' });
  assert.equal(off.covByShowId.size, 0);
});

test('raw audits win over a (possibly stale) snapshot; never mixed', () => {
  const dir = fixture();
  writeFileSync(join(dir, COVERAGE_FLOOR_SNAPSHOT_FILE), JSON.stringify({
    cov: { stale: { state: 'incomplete', liveCount: 0, candidateCount: 1, computedAt: null } },
    stamps: { stale: '2026-01-01T00:00:00Z' },
    acked: ['stale'],
  }));
  const inputs = loadCoverageFloorInputs(dir, {});
  assert.equal(inputs.covByShowId.has('stale'), false);
  assert.equal(inputs.scorePublicSinceByShowId.has('stale'), false);
  assert.equal(inputs.coverageAckedShowIds.has('stale'), false);
  assert.equal(inputs.covByShowId.get('a').state, 'incomplete');

  // A corrupt (present but unparseable) gap audit is not "audits absent":
  // the raw stamps/acks still apply and the snapshot is still ignored.
  writeFileSync(join(dir, 'audit', 'show-review-gap.json'), '{not json');
  const corrupt = loadCoverageFloorInputs(dir, {});
  assert.equal(corrupt.covByShowId.size, 0);
  assert.equal(corrupt.scorePublicSinceByShowId.get('a'), '2026-10-01T00:00:00Z');
  assert.deepEqual([...corrupt.coverageAckedShowIds], ['a']);
});

test('next.config.js traces the snapshot into server functions and keeps data/audit excluded', () => {
  const config = require('../../next.config.js');
  const includes = Object.values(config.outputFileTracingIncludes || {}).flat();
  const excludes = Object.values(config.outputFileTracingExcludes || {}).flat();
  assert.ok(includes.includes(`data/${COVERAGE_FLOOR_SNAPSHOT_FILE}`), 'snapshot is traced');
  assert.ok(!includes.some(p => p.startsWith('data/audit')), 'no raw audit file is traced');
  assert.ok(excludes.includes('data/audit/**'));
  assert.ok(!COVERAGE_FLOOR_SNAPSHOT_FILE.startsWith('audit/'), 'snapshot must live outside the excluded tree');
});

test('post-build trace check: needs the snapshot, rejects any data/audit file', () => {
  const { checkNft } = require('./check-coverage-floor-trace.js');
  const root = mkdtempSync(join(tmpdir(), 'cov-floor-nft-'));
  const dir = join(root, '.next', 'server', 'app', 'show', '[slug]');
  mkdirSync(dir, { recursive: true });
  const nft = join(dir, 'page.js.nft.json');
  const rel = f => join('..', '..', '..', '..', '..', f);
  writeFileSync(nft, JSON.stringify({ files: [rel(`data/${COVERAGE_FLOOR_SNAPSHOT_FILE}`), rel('data/shows.json')] }));
  assert.deepEqual(checkNft(nft, root), { ok: true, problems: [] });
  writeFileSync(nft, JSON.stringify({ files: [rel('data/audit/show-review-gap.json')] }));
  const bad = checkNft(nft, root);
  assert.equal(bad.ok, false);
  assert.equal(bad.problems.length, 2, 'missing snapshot AND traced audit file');
});
