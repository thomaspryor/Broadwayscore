// BRO-7613: ingest-manual-review.js --publish-date onto an existing file with a
// different (wrong) date was dropped by the writer (it only fills a blank
// publishDate) while the script printed "Updated". The post-write check must
// name publishDate as stale so the operator is told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { buildManualIngestIntended, findStaleMergeFields } = require('./stale-merge-check.js');
const { createOrMergeReviewFile } = require('./review-file-writer');
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

test('writer round-trip: a dropped --publish-date is reported stale', (t) => {
  // Real writer + real show id (hamilton-2015 is in shows.json); temp review-texts dir.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-7613-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const showId = 'hamilton-2015';
  const url = 'https://www.example.com/hamilton-review-bro-7613';
  fs.mkdirSync(path.join(dir, showId));
  const fp = path.join(dir, showId, 'vulture--bro-7613-critic.json');
  const body = 'Hamilton at the Richard Rodgers Theatre is a stirring musical with expressive performances. '.repeat(30);
  fs.writeFileSync(fp, JSON.stringify({ showId, outletId: 'vulture', outlet: 'Vulture', criticName: 'BRO 7613 Critic', url, publishDate: '2026-09-02', fullText: body, contentTier: 'complete' }));
  const result = createOrMergeReviewFile(showId, {
    outletId: 'vulture', outlet: 'Vulture', criticName: 'BRO 7613 Critic', url, source: 'manual-entry', publishDate: '2015-08-06',
    fields: buildManualReviewFields({ fullText: body, publishDate: '2015-08-06' }),
  }, { reviewTextsDir: dir });
  assert.notEqual(result.action, 'new');
  const landed = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const intended = buildManualIngestIntended({ action: result.action, url, fullText: body, publishDate: '2015-08-06', preExisting: { data: { fullText: body, contentTier: 'complete' } } });
  // If a future writer change makes the operator date win, landed matches and this is []; either way no silent drop.
  const stale = findStaleMergeFields(intended, landed);
  if (landed.publishDate === '2015-08-06') assert.deepEqual(stale, []);
  else assert.deepEqual(stale, ['publishDate']);
});
