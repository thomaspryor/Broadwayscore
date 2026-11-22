// Tests for scripts/build-show-refresh-manifest.ts (BRO-8056 phase 1b). Runs under tsx
// (tests/unit-test-manifest-tsx.txt). Pure parts only; the full build is exercised by prebuild.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SLICE_INPUT_FILES, SLICE_REQUIRED_FILES, resolvePublicSha } from './build-show-refresh-manifest.ts';

test('slice inputs cover every file computeOneShow and the TBD verdict read', () => {
  for (const f of ['shows.json', 'reviews.json', 'blog-reviews-for-scoring.json', 'audience.json', 'buzz.json',
    'outlet-registry.json', 'critic-consensus.json', 'audience-buzz.json', 'score-gate-overrides.json', 'curated-historical-shows.json',
    'coverage-floor-snapshot.json', 'audit/show-review-gap.json', 'audit/score-public-since.json', 'audit/t1-coverage-ack.json', 'site-image-versions.json']) {
    assert.ok(SLICE_INPUT_FILES.includes(f), f);
  }
  assert.equal(SLICE_INPUT_FILES.length, 15);
  assert.equal(new Set(SLICE_INPUT_FILES).size, 15);
  assert.ok(!SLICE_REQUIRED_FILES.some(f => f.startsWith('audit/')), 'coverage audit files are fail-open, never required');
});

test('publicSha prefers git HEAD, then VERCEL_GIT_COMMIT_SHA, then GITHUB_SHA', () => {
  const nogit = '/';
  assert.equal(resolvePublicSha({ VERCEL_GIT_COMMIT_SHA: 'v', GITHUB_SHA: 'g' }, nogit), 'v');
  assert.equal(resolvePublicSha({ GITHUB_SHA: 'g' }, nogit), 'g');
  assert.equal(resolvePublicSha({}, nogit), null);
  assert.match(resolvePublicSha({ GITHUB_SHA: 'g' }), /^[0-9a-f]{40}$/);
});

test('slice coverage ignores COVERAGE_GATE_DISABLED so slice hashes do not depend on the environment', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('./build-show-refresh-manifest.ts', import.meta.url), 'utf8');
  assert.match(src, /coverageFloorInputs: readCoverageFloorInputs\(coverageFiles, \{\}\)/);
  // image versions are written before the data read, so their hash is in dataShas
  assert.ok(src.indexOf('writeSiteImageVersions()') < src.indexOf('readDataFiles(dataDir)'));
});
