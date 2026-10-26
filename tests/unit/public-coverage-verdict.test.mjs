import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { publicCoverageVerdict } = require('../../scripts/lib/public-coverage-verdict');

const verdict = {
  state: 'complete', liveCount: 2, candidateCount: 2,
  computedAt: '2026-09-02T22:17:45.717Z',
};

test('a newer review invalidates a pre-press-night verdict without mutating it', () => {
  const cov = Object.freeze({ ...verdict });
  const warnings = [];
  const result = publicCoverageVerdict(cov, [{ d: '2026-09-01' }, { d: '2026-09-04' }], {
    showId: 'the-story-west-end-2026', warn: message => warnings.push(message),
  });
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /the-story-west-end-2026.*omitting stale cov/);
  assert.match(warnings[0], /latestReview=2026-09-04T00:00:00.000Z/);
  assert.deepEqual(cov, verdict);
});

test('fresh or equal timestamps preserve the census counts and state', () => {
  for (const d of ['2026-09-01', verdict.computedAt, '2026-09-03T00:17:45.717+02:00']) {
    assert.equal(publicCoverageVerdict(verdict, [{ d }, { d }, { d }], {
      warn: () => assert.fail('fresh verdict must not warn'),
    }), verdict);
  }
});

test('the newest valid date wins regardless of review order or missing dates', () => {
  assert.equal(publicCoverageVerdict(verdict, [
    { d: '2026-09-04' }, { d: null }, { d: 'invalid' }, {}, { d: '2026-09-01' },
  ], { warn: () => {} }), null);
});

test('missing or invalid audit timestamps cannot establish freshness', () => {
  for (const computedAt of [undefined, null, '', 'invalid', 0]) {
    const warnings = [];
    assert.equal(publicCoverageVerdict({ ...verdict, computedAt }, [{ d: '2026-09-01' }], {
      warn: message => warnings.push(message),
    }), null);
    assert.equal(warnings.length, 1);
  }
});

test('absent verdicts and undated reviews retain the existing optional-field behavior', () => {
  const opts = { warn: () => assert.fail('no stale verdict') };
  assert.equal(publicCoverageVerdict(null, [{ d: '2026-09-04' }], opts), null);
  assert.equal(publicCoverageVerdict(undefined, [], opts), null);
  assert.equal(publicCoverageVerdict(verdict, [], opts), verdict);
  assert.equal(publicCoverageVerdict(verdict, [{ d: null }, { d: 'invalid' }], opts), verdict);
});

test('a refreshed audit restores the public summary', () => {
  const reviews = [{ d: '2026-09-04' }];
  assert.equal(publicCoverageVerdict(verdict, reviews, { warn: () => {} }), null);
  const refreshed = { ...verdict, computedAt: '2026-09-04T12:00:00.000Z' };
  assert.equal(publicCoverageVerdict(refreshed, reviews), refreshed);
});
