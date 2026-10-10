/**
 * Unit tests for the unregistered-outlet + empty-stub guard added 2026-05-25.
 *
 * Prevents the contamination pattern where discovery scripts slugify an
 * unrecognized URL host (reddit, metopera.org, lincolncenterfestival.org) or
 * a title fragment into outletId and write an empty stub. See BSC daily
 * 2026-05-25 root-cause notes.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');

const TMP_REVIEW_TEXTS = fs.mkdtempSync(path.join(os.tmpdir(), 'rfw-junk-'));

describe('createOrMergeReviewFile — unregistered outlet + empty stub guard', () => {
  test('rejects empty stub for unregistered domain (reddit)', () => {
    const res = createOrMergeReviewFile('test-show', {
      outletId: 'reddit', outlet: 'Reddit',
      url: 'https://www.reddit.com/r/Broadway/comments/abc/',
      criticName: 'Unknown',
    }, { dryRun: true, reviewTextsDir: TMP_REVIEW_TEXTS });
    assert.equal(res.action, 'skipped');
    assert.equal(res.reason, 'unregistered-outlet-empty-stub');
  });

  test('rejects empty stub for unregistered domain (metopera.org → metoperaorg)', () => {
    const res = createOrMergeReviewFile('test-show', {
      outletId: 'metoperaorg', outlet: 'Met Opera',
      url: 'https://www.metopera.org/season/2024-25-season/aida/',
      criticName: 'Unknown',
    }, { dryRun: true, reviewTextsDir: TMP_REVIEW_TEXTS });
    assert.equal(res.action, 'skipped');
    assert.equal(res.reason, 'unregistered-outlet-empty-stub');
  });

  test('rejects empty stub for title-fragment outletId', () => {
    const res = createOrMergeReviewFile('test-show', {
      outletId: 'was-along-for-the-ride', outlet: 'was along for the ride',
      url: null,
      criticName: 'Jonathan Loy',
    }, { dryRun: true, reviewTextsDir: TMP_REVIEW_TEXTS });
    assert.equal(res.action, 'skipped');
    assert.equal(res.reason, 'unregistered-outlet-empty-stub');
  });

  test('lets unregistered outlet through when it carries real text', () => {
    const res = createOrMergeReviewFile('test-show', {
      outletId: 'a-brand-new-blog', outlet: 'A Brand New Blog',
      url: 'https://example.com/r',
      criticName: 'Real Critic',
      fullText: 'This is a real review with substantive text about the show.',
    }, { dryRun: true, reviewTextsDir: TMP_REVIEW_TEXTS });
    assert.notEqual(res.reason, 'unregistered-outlet-empty-stub');
  });

  test('lets unregistered outlet through when it carries an aggregator excerpt (bwwExcerpt)', () => {
    // Regression: the early version of the guard only checked fullText/excerpt/text
    // and would drop legit BWW-roundup extractions on unregistered outlets that
    // carry only bwwExcerpt. Mirror Guard F's text-presence fields.
    const res = createOrMergeReviewFile('test-show', {
      outletId: 'a-new-bww-source', outlet: 'A New BWW Source',
      url: 'https://example.com/r',
      criticName: 'Real Critic',
      bwwExcerpt: 'BWW roundup excerpt with substantive content.',
    }, { dryRun: true, reviewTextsDir: TMP_REVIEW_TEXTS });
    assert.notEqual(res.reason, 'unregistered-outlet-empty-stub');
  });

  test('lets registered outlet stub through (pending URL/text resolution)', () => {
    // nysr is a real registered outlet; aggregator may write a stub before
    // the per-outlet review URL is resolved. Guard must NOT block.
    const res = createOrMergeReviewFile('test-show', {
      outletId: 'nysr', outlet: 'NYSR',
      url: 'https://nystagereview.com/some-review',
      criticName: 'Frank Scheck',
      excerpt: 'Excerpt preview.',
    }, { dryRun: true, reviewTextsDir: TMP_REVIEW_TEXTS });
    assert.notEqual(res.reason, 'unregistered-outlet-empty-stub');
  });
});
