import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGap, justifiesUrlResolution } from './review-gap-triage.js';

test('live prod wins even if review-texts is also excluded (stale flag, already deployed)', () => {
  assert.equal(
    classifyGap({ reviewTextsExists: true, exclusionRule: 'wrongProduction', inReviewsJson: true, inLiveProd: true }),
    'live-on-prod'
  );
});

test('review-texts file with a blocking flag and nothing downstream is ingested-but-excluded', () => {
  assert.equal(
    classifyGap({ reviewTextsExists: true, exclusionRule: 'wrongProduction', inReviewsJson: false, inLiveProd: false }),
    'ingested-but-excluded'
  );
});

test('the BRO-3153 incident shape: file exists, scored into reviews.json, not yet deployed', () => {
  assert.equal(
    classifyGap({ reviewTextsExists: true, exclusionRule: null, inReviewsJson: true, inLiveProd: false }),
    'in-pipeline-awaiting-deploy'
  );
});

test('no review-texts file locally but already in reviews.json (in-pipeline via aggregate only)', () => {
  assert.equal(
    classifyGap({ reviewTextsExists: false, exclusionRule: null, inReviewsJson: true, inLiveProd: false }),
    'in-pipeline-awaiting-deploy'
  );
});

test('review-texts file exists, includable, but rebuild has not run yet', () => {
  assert.equal(
    classifyGap({ reviewTextsExists: true, exclusionRule: null, inReviewsJson: false, inLiveProd: false }),
    'in-pipeline-awaiting-deploy'
  );
});

test('nothing anywhere is a true missed discovery', () => {
  assert.equal(
    classifyGap({ reviewTextsExists: false, exclusionRule: null, inReviewsJson: false, inLiveProd: false }),
    'true-missed-discovery'
  );
});

test('only true-missed-discovery justifies URL-resolution work', () => {
  assert.equal(justifiesUrlResolution('true-missed-discovery'), true);
  assert.equal(justifiesUrlResolution('live-on-prod'), false);
  assert.equal(justifiesUrlResolution('ingested-but-excluded'), false);
  assert.equal(justifiesUrlResolution('in-pipeline-awaiting-deploy'), false);
});
