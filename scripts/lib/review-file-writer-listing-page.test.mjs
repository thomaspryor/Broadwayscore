/**
 * BRO-4596: createOrMergeReviewFile must refuse a write whose URL is a listing
 * or section-index page (LISTING_PAGE_URL_PATTERNS), for any source. Live case:
 * four express-uk Neil Norman rows on https://www.express.co.uk/entertainment/theatre
 * were scored off a text-pattern star. dryRun only, temp corpus dir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('./review-file-writer.js');
const reviewTextsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-file-writer-listing-'));

const call = (url, fields = {}, source = 'web-search') => {
  const w = console.warn, l = console.log;
  console.warn = () => {}; console.log = () => {};
  try {
    return createOrMergeReviewFile('oliver-west-end-2024',
      { outlet: 'Express UK', criticName: 'Neil Norman', url, source, fields }, { dryRun: true, reviewTextsDir });
  } finally { console.warn = w; console.log = l; }
};

test('refuses the express.co.uk theatre section page', () => {
  const r = call('https://www.express.co.uk/entertainment/theatre');
  assert.equal(r.action, 'skipped');
  assert.equal(r.reason, 'listing-page-url: section-index-page');
});

test('fields.allowNonReviewUrl is the human escape hatch', () => {
  const r = call('https://www.express.co.uk/entertainment/theatre', { allowNonReviewUrl: true });
  assert.notEqual(r.reason, 'listing-page-url: section-index-page');
});

test('a real express.co.uk article is not refused by this guard', () => {
  const r = call('https://www.express.co.uk/entertainment/theatre/1769203/Oliver-review-London-2024');
  assert.doesNotMatch(String(r.reason || ''), /^listing-page-url/);
});
