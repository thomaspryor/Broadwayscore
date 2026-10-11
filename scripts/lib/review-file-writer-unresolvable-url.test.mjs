/**
 * BRO-4458: createOrMergeReviewFile must refuse Google's relative /goto redirect
 * (and cache/AMP wrappers) as a review URL. Live case: broadwaynews + tennessean
 * stubs on the-body-of-mary stranded empty-body >24h on unfetchable /goto URLs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('./review-file-writer.js');
const { isUnresolvableRedirectUrl } = require('./unresolvable-url.js');
const reviewTextsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-file-writer-unres-'));

const call = (url, fields = {}) => {
  const w = console.warn, l = console.log;
  console.warn = () => {}; console.log = () => {};
  try {
    return createOrMergeReviewFile('the-body-of-mary-a-play-in-three-acts-of-god-off-broadway-2026',
      { outletId: 'broadwaynews', outlet: 'Broadway News', criticName: 'Unknown', url, source: 'opening-night-discovery', fields },
      { dryRun: true, reviewTextsDir });
  } finally { console.warn = w; console.log = l; }
};

test('refuses the relative /goto redirect', () => {
  const r = call('/goto?url=CAESogEB6zswFV2lmVVdCz_FAnxpbkdT0laEhC');
  assert.equal(r.action, 'skipped');
  assert.equal(r.reason, 'unresolvable-redirect-url');
});

test('refuses google cache wrapper', () => {
  assert.equal(call('https://webcache.googleusercontent.com/search?q=cache:x').reason, 'unresolvable-redirect-url');
});

test('a real article URL is not refused by this guard', () => {
  assert.notEqual(call('https://www.broadwaynews.com/the-body-of-mary-review/').reason, 'unresolvable-redirect-url');
});

test('predicate', () => {
  assert.equal(isUnresolvableRedirectUrl('/goto?url=x'), true);
  assert.equal(isUnresolvableRedirectUrl('mailto:a@b.c'), true);
  assert.equal(isUnresolvableRedirectUrl('https://www.nytimes.com/a'), false);
});

test('prefetch skips an unresolvable redirect without calling fetchPage', async () => {
  const { prefetchDiscoveredArticle } = require('./discovery-prefetch.js');
  let called = false;
  const r = await prefetchDiscoveredArticle('/goto?url=CAE', { fetchPageFn: async () => { called = true; return {}; } });
  assert.equal(called, false);
  assert.equal(r.fullText, null);
});

test('www.google.com/amp wrapper is unresolvable', () => {
  assert.equal(isUnresolvableRedirectUrl('https://www.google.com/amp/s/x.com/a'), true);
});
