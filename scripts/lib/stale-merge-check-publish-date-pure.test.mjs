// BRO-7613: pure checks for the manual-ingest publishDate verification (no live data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildManualIngestIntended, findStaleMergeFields, alignLandedPublishDate } = require('./stale-merge-check.js');
const { buildManualReviewFields } = require('./manual-review-fields');

test('new file: nothing to verify', () => {
  assert.deepEqual(buildManualIngestIntended({ action: 'new', url: 'u', publishDate: '2022-01-01', criticName: 'x' }), {});
});

test('existing file: operator publishDate is intended', () => {
  const i = buildManualIngestIntended({ action: 'updated', url: 'u', publishDate: '2022-03-11', criticName: 'jane doe', preExisting: { data: { fullText: 'x', contentTier: 'complete' } }, fullText: 'y' });
  assert.deepEqual(i, { url: 'u', publishDate: '2022-03-11', criticName: 'jane doe' });
});

test('existing file: bad pre-existing body makes fullText intended', () => {
  const i = buildManualIngestIntended({ action: 'updated', fullText: 'y', preExisting: { data: { fullText: 'x', contentTier: 'invalid' } } });
  assert.equal(i.fullText, 'y');
});

test('a still-wrong landed date is reported stale', () => {
  const intended = { publishDate: '2022-03-11' };
  assert.deepEqual(findStaleMergeFields(intended, alignLandedPublishDate(intended, { publishDate: '2026-09-25' })), ['publishDate']);
});

for (const stored of ['March 11, 2022', 'March 11th, 2022', '2022-03-11T08:33:00+00:00', '2022-03-11T23:30:00-05:00']) {
  test(`same calendar day in another format is not stale: ${stored}`, () => {
    const intended = { publishDate: '2022-03-11' };
    assert.deepEqual(findStaleMergeFields(intended, alignLandedPublishDate(intended, { publishDate: stored })), []);
  });
}

test('automated ingest (operatorTrust:false) does not force its date', () => {
  const f = buildManualReviewFields({ publishDate: '2022-03-11', operatorTrust: false });
  assert.equal(f.protectedFields, undefined);
  assert.equal(f.dateSource, undefined);
});
