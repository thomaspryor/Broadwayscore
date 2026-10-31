/**
 * BRO-3790 cousin fix: ingest-manual-review.js has the same merge-into-
 * existing false-positive-success shape as ingest-review-from-url.js (found
 * during that ticket's own /what-else pass — same root cause,
 * createOrMergeReviewFile's merge-into-existing path only fills BLANK
 * fields, review-file-writer.js). This is the operator "break-glass"
 * correction tool, so a silent no-op here is the worst-case failure mode: an
 * operator explicitly fixing a known-bad url/critic/text sees "✅ Updated"
 * while the bad data survives untouched.
 *
 * Mirrors ingest-review-from-url-stale-merge.test.mjs's structure — exercises
 * the REAL createOrMergeReviewFile merge path plus the real
 * findStaleMergeFields/isPreExistingContentBad, the exact call shape
 * ingest-manual-review.js now uses post-write.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');
const { findExistingReviewFile, normalizeCritic } = require('../../scripts/lib/review-normalization');
const { findStaleMergeFields, isPreExistingContentBad } = require('../../scripts/lib/stale-merge-check');

function writeExisting(dir, showId, filename, data) {
  const showDir = path.join(dir, showId);
  fs.mkdirSync(showDir, { recursive: true });
  const fp = path.join(showDir, filename);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
  return fp;
}

describe('BRO-3790 cousin: ingest-manual-review.js post-write stale-merge verification', () => {
  test('an operator correcting the url onto a file with good existing content is silently kept by the writer — and the verification catches it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-3790-manual-url-'));
    const OLD_URL = 'https://theaterpizzazz.com/wrong-review-page/';
    const NEW_URL = 'https://theaterpizzazz.com/the-correct-review-page/';
    const fp = writeExisting(dir, 'manual-stale-url-show', 'theater-pizzazz--jane-critic.json', {
      showId: 'manual-stale-url-show',
      outletId: 'theater-pizzazz',
      outlet: 'Theater Pizzazz',
      criticName: 'Jane Critic',
      url: OLD_URL,
      contentTier: 'complete',
      fullText: 'A complete-looking review body that reads as real content and is long enough to pass every length gate cleanly. '.repeat(4),
    });

    const showDir = path.join(dir, 'manual-stale-url-show');
    const preExisting = findExistingReviewFile(showDir, 'theater-pizzazz', 'Jane Critic', NEW_URL);
    assert.ok(preExisting, 'sanity: pre-write lookup finds the existing file');

    const res = createOrMergeReviewFile('manual-stale-url-show', {
      outletId: 'theater-pizzazz', outlet: 'Theater Pizzazz', criticName: 'Jane Critic',
      url: NEW_URL,
      source: 'manual-entry',
      fields: {},
    }, { reviewTextsDir: dir });

    assert.notEqual(res.action, 'skipped', 'sanity: writer does not signal a refusal here');
    const landed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.equal(landed.url, OLD_URL, 'sanity: reproduces the bug — url on disk never changed');

    // Exactly what ingest-manual-review.js now does post-write.
    const intended = { url: NEW_URL, criticName: normalizeCritic('Jane Critic') };
    const landedForCompare = { ...landed, criticName: normalizeCritic(landed.criticName) };
    const stale = findStaleMergeFields(intended, landedForCompare);
    assert.deepEqual(stale, ['url'], 'the operator-intended url correction must be flagged, not reported as a silent success');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an operator correcting the criticName on an Unknown-byline file is flagged (criticName is never merged by the writer)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-3790-manual-critic-'));
    const SAME_URL = 'https://theaterpizzazz.com/the-review-page/';
    const fp = writeExisting(dir, 'manual-stale-critic-show', 'theater-pizzazz--unknown.json', {
      showId: 'manual-stale-critic-show',
      outletId: 'theater-pizzazz',
      outlet: 'Theater Pizzazz',
      criticName: 'Unknown',
      url: SAME_URL,
      fullText: 'A short teaser body.',
    });

    createOrMergeReviewFile('manual-stale-critic-show', {
      outletId: 'theater-pizzazz', outlet: 'Theater Pizzazz', criticName: 'Real Critic Name',
      url: SAME_URL,
      source: 'manual-entry',
      fields: {},
    }, { reviewTextsDir: dir });

    const landed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.equal(landed.criticName, 'Unknown', 'sanity: criticName is never merged by the writer at all');

    const intended = { criticName: normalizeCritic('Real Critic Name') };
    const landedForCompare = { ...landed, criticName: normalizeCritic(landed.criticName) };
    const stale = findStaleMergeFields(intended, landedForCompare);
    assert.deepEqual(stale, ['criticName'], 'the operator-supplied critic name must be flagged stale');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('re-pasting the SAME already-correct text onto a complete file is never flagged stale', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-3790-manual-good-text-'));
    const SAME_URL = 'https://theaterpizzazz.com/the-review-page/';
    const GOOD_TEXT = 'A complete, correct review body that was already fine before this manual re-entry ever ran. '.repeat(4);
    writeExisting(dir, 'manual-good-content-show', 'theater-pizzazz--jane-critic.json', {
      showId: 'manual-good-content-show',
      outletId: 'theater-pizzazz',
      outlet: 'Theater Pizzazz',
      criticName: 'Jane Critic',
      url: SAME_URL,
      contentTier: 'complete',
      fullText: GOOD_TEXT,
    });

    const showDir = path.join(dir, 'manual-good-content-show');
    const preExisting = findExistingReviewFile(showDir, 'theater-pizzazz', 'Jane Critic', SAME_URL);
    assert.equal(isPreExistingContentBad(preExisting), false, 'sanity: already-complete file is not "bad"');

    const intended = { criticName: normalizeCritic('Jane Critic') };
    if (isPreExistingContentBad(preExisting)) intended.fullText = GOOD_TEXT;
    const landed = { ...preExisting.data, criticName: normalizeCritic(preExisting.data.criticName) };
    const stale = findStaleMergeFields(intended, landed);
    assert.deepEqual(stale, [], 'fullText must not be asserted (and thus never flagged) against an already-good file');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
