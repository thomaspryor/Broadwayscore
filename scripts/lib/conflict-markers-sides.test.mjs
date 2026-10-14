import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { conflictSides, parseConflictedJson, parseAgreeingConflictedReview } = require('./conflict-markers.js');

test('rebuild reader: sides differing only in retry bookkeeping are published', () => {
  const r = parseAgreeingConflictedReview(DEEP_HEAT_TEXT());
  assert.ok(r, 'deep-heat differs only in incompleteDetail/fetchRetryAfter/aggUrlRecoveryCount');
  assert.equal(r.data.showId, 'deep-heat-rivalry-off-west-end-2026');
});

test('rebuild reader: sides that disagree on a flag or score are NOT published', () => {
  const flag = '{\n  "url": "u",\n<<<<<<< HEAD\n  "assignedScore": 70\n=======\n  "assignedScore": 70,\n  "wrongProduction": true\n>>>>>>> x\n}\n';
  assert.equal(parseAgreeingConflictedReview(flag), null);
  const score = '{\n  "url": "u",\n<<<<<<< HEAD\n  "humanReviewScore": 60\n=======\n  "humanReviewScore": 80\n>>>>>>> x\n}\n';
  assert.equal(parseAgreeingConflictedReview(score), null);
});

// Hoisted accessor so the tests above can use the fixture declared below.
function DEEP_HEAT_TEXT() { return DEEP_HEAT; }

// Real committed shape: deep-heat-rivalry-off-west-end-2026/thestage--unknown.json
// (broadway-review-texts 1e2ed770e, 2026-09-25). rebuild-all-reviews.js must
// keep the review by reading one side, not drop it from reviews.json.
const DEEP_HEAT = [
  '{',
  '  "showId": "deep-heat-rivalry-off-west-end-2026",',
  '  "outletId": "thestage",',
  '  "incompleteReason": "scraper_timeout",',
  '<<<<<<< HEAD',
  '  "incompleteDetail": "3 timeout attempts",',
  '  "fetchRetryAfter": "2026-09-25T05:29:21.719Z"',
  '=======',
  '  "incompleteDetail": "2 timeout attempts",',
  '  "fetchRetryAfter": "2026-09-25T04:10:54.861Z",',
  '  "aggUrlRecoveryCount": 1',
  '>>>>>>> 1d53ad5cfef (data: concurrent review-text writes swept in during push [skip ci])',
  '}',
  '',
].join('\n');

test('conflictSides splits the real deep-heat file into two valid readings', () => {
  const s = conflictSides(DEEP_HEAT);
  assert.ok(s);
  assert.equal(JSON.parse(s.ours).incompleteDetail, '3 timeout attempts');
  assert.equal(JSON.parse(s.theirs).aggUrlRecoveryCount, 1);
  assert.equal(JSON.parse(s.ours).showId, 'deep-heat-rivalry-off-west-end-2026');
});

test('parseConflictedJson prefers ours, falls back to theirs, null when neither parses', () => {
  assert.equal(parseConflictedJson(DEEP_HEAT).side, 'ours');
  const oursBroken = '{\n<<<<<<< HEAD\n  "a": 1,\n=======\n  "a": 2\n>>>>>>> x\n}\n';
  assert.deepEqual(parseConflictedJson(oursBroken), { data: { a: 2 }, side: 'theirs' });
  const bothBroken = '{\n<<<<<<< HEAD\n  "a": 1,\n=======\n  "a": 2,\n>>>>>>> x\n}\n';
  assert.equal(parseConflictedJson(bothBroken), null);
  assert.equal(parseConflictedJson('{"a":1}'), null, 'no markers -> null');
});

test('conflictSides handles diff3 base sections and rejects malformed blocks', () => {
  const diff3 = '{\n<<<<<<< HEAD\n  "a": 1\n||||||| base\n  "a": 0\n=======\n  "a": 2\n>>>>>>> x\n}\n';
  const s = conflictSides(diff3);
  assert.equal(JSON.parse(s.ours).a, 1);
  assert.equal(JSON.parse(s.theirs).a, 2);
  assert.equal(conflictSides('{\n<<<<<<< HEAD\n  "a": 1\n}\n'), null, 'unclosed');
  assert.equal(conflictSides('{\n>>>>>>> x\n}\n'), null, 'closer without opener');
});
