// declaredRunsForPrompt: tourLegs must reach the ensemble prompt alongside priorRuns.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { declaredRunsForPrompt } = require('./declared-runs.js');

// Real shows.json entry shape: the-car-man-west-end-2026 (core-data 143ffddcf).
const CAR_MAN = {
  priorRuns: [{ openingDate: '2026-06-15', closingDate: '2026-07-27', venue: 'UK Tour pre-London (Curve Leicester, The Lowry Salford)' }],
  tourLegs: [{ startDate: '2026-08-31', endDate: '2026-11-21', venue: 'UK Tour post-London (Bristol, Norwich)' }],
};

test('tour legs are mapped to openingDate/closingDate and appended after priorRuns', () => {
  const runs = declaredRunsForPrompt(CAR_MAN);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].venue, CAR_MAN.priorRuns[0].venue);
  assert.deepEqual(runs[1], { openingDate: '2026-08-31', closingDate: '2026-11-21', venue: 'UK Tour post-London (Bristol, Norwich)', note: 'tour leg' });
});

test('a show with neither declared returns null (prompt adds no note)', () => {
  assert.equal(declaredRunsForPrompt({}), null);
  assert.equal(declaredRunsForPrompt({ priorRuns: [], tourLegs: [null] }), null);
  assert.equal(declaredRunsForPrompt(null), null);
});

test('priorRuns-only shows are unchanged', () => {
  const p = [{ openingDate: '2023-01-25', closingDate: '2023-04-01', venue: 'Ambassadors' }];
  assert.deepEqual(declaredRunsForPrompt({ priorRuns: p }), p);
});
