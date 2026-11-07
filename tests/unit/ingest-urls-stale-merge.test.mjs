/**
 * BRO-3791: ingest-urls.js (bulk break-glass URL ingest) had the same
 * merge-into-existing false-positive-success shape fixed in BRO-3790 for the
 * single-URL tools. Exercises the REAL writer plus the shared
 * findStaleFieldsAfterUpdate helper that ingest-urls.js now calls post-write.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');
const { findExistingReviewFile } = require('../../scripts/lib/review-normalization');
const { findStaleFieldsAfterUpdate } = require('../../scripts/lib/stale-merge-check');

const GOOD = 'A complete-looking review body that reads as real content and is long enough to pass every length gate cleanly. '.repeat(4);

function setup(existing) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-3791-'));
  const showDir = path.join(dir, 'urls-show');
  fs.mkdirSync(showDir, { recursive: true });
  const fp = path.join(showDir, 'theater-pizzazz--jane-critic.json');
  fs.writeFileSync(fp, JSON.stringify({ showId: 'urls-show', outletId: 'theater-pizzazz', outlet: 'Theater Pizzazz', criticName: 'Jane Critic', ...existing }, null, 2));
  return { dir, showDir, fp };
}

test('a new url onto a file with good content is flagged stale, not a silent success', () => {
  const OLD = 'https://theaterpizzazz.com/wrong/';
  const NEW = 'https://theaterpizzazz.com/right/';
  const { dir, showDir, fp } = setup({ url: OLD, contentTier: 'complete', fullText: GOOD });
  const pre = findExistingReviewFile(showDir, 'theater-pizzazz', 'Jane Critic', NEW);
  assert.ok(pre);
  const res = createOrMergeReviewFile('urls-show', {
    outletId: 'theater-pizzazz', outlet: 'Theater Pizzazz', criticName: 'Jane Critic',
    url: NEW, source: 'ingest-urls', fields: {},
  }, { reviewTextsDir: dir });
  assert.notEqual(res.action, 'skipped');
  const landed = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert.deepEqual(findStaleFieldsAfterUpdate({ preExisting: pre, url: NEW, fullText: null, landed }), ['url']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a re-ingest of the same url onto good content is not flagged', () => {
  const URL = 'https://theaterpizzazz.com/same/';
  const { dir, showDir, fp } = setup({ url: URL, contentTier: 'complete', fullText: GOOD });
  const pre = findExistingReviewFile(showDir, 'theater-pizzazz', 'Jane Critic', URL);
  createOrMergeReviewFile('urls-show', {
    outletId: 'theater-pizzazz', outlet: 'Theater Pizzazz', criticName: 'Jane Critic',
    url: URL, source: 'ingest-urls', fields: { fullText: GOOD + ' rotating ad copy', textFetchedAt: 'x', fetchMethod: 'fetch' },
  }, { reviewTextsDir: dir });
  const landed = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert.deepEqual(findStaleFieldsAfterUpdate({ preExisting: pre, url: URL, fullText: GOOD + ' rotating ad copy', landed }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fullText is only required to land when the pre-existing body was bad', () => {
  const landed = { url: 'u', fullText: 'old' };
  assert.deepEqual(findStaleFieldsAfterUpdate({ preExisting: { data: { fullText: GOOD, contentTier: 'complete' } }, url: 'u', fullText: 'new', landed }), []);
  assert.deepEqual(findStaleFieldsAfterUpdate({ preExisting: { data: { fullText: 'old', contentTier: 'stub' } }, url: 'u', fullText: 'new', landed }), ['fullText']);
});
