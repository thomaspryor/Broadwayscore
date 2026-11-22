// Tests for scripts/build-show-refresh-manifest.ts (BRO-8056 phase 1b). Runs under tsx
// (tests/unit-test-manifest-tsx.txt). Pure parts only; the full build is exercised by prebuild.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SLICE_INPUT_FILES, SLICE_REQUIRED_FILES, resolvePublicSha } from './build-show-refresh-manifest.ts';

test('slice inputs cover every file computeOneShow and the TBD verdict read', () => {
  for (const f of ['shows.json', 'reviews.json', 'blog-reviews-for-scoring.json', 'audience.json', 'buzz.json',
    'outlet-registry.json', 'critic-consensus.json', 'audience-buzz.json', 'score-gate-overrides.json',
    'coverage-floor-snapshot.json', 'audit/show-review-gap.json', 'audit/score-public-since.json', 'audit/t1-coverage-ack.json']) {
    assert.ok(SLICE_INPUT_FILES.includes(f), f);
  }
  assert.equal(SLICE_INPUT_FILES.length, 13);
  assert.equal(new Set(SLICE_INPUT_FILES).size, 13);
  assert.ok(!SLICE_REQUIRED_FILES.some(f => f.startsWith('audit/')), 'coverage audit files are fail-open, never required');
});

test('publicSha prefers git HEAD, then VERCEL_GIT_COMMIT_SHA, then GITHUB_SHA', () => {
  const nogit = '/';
  assert.equal(resolvePublicSha({ VERCEL_GIT_COMMIT_SHA: 'v', GITHUB_SHA: 'g' }, nogit), 'v');
  assert.equal(resolvePublicSha({ GITHUB_SHA: 'g' }, nogit), 'g');
  assert.equal(resolvePublicSha({}, nogit), null);
  assert.match(resolvePublicSha({ GITHUB_SHA: 'g' }), /^[0-9a-f]{40}$/);
});
