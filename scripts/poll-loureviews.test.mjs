// BRO-2926: permanent ingest refusals are told apart from "already exists"
// and remembered, so the LouReviews poller stops re-fetching them every cycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('./lib/review-file-writer');
const {
  REJECTIONS_FILENAME, isDurableSkip, isDurablyRejected, recordDurableRejection, bucketWriteResult,
} = require('./lib/ingest-rejection-cache');

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('the shared writer marks permanent refusals durable and others not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2926-'));
  fs.mkdirSync(path.join(dir, 'hamilton-2015'));
  // unresolvable-redirect-url: a property of the url itself, permanent
  const redirect = createOrMergeReviewFile('hamilton-2015',
    { outletId: 'thestage', outlet: 'The Stage', criticName: 'Jane Doe', url: 'https://webcache.googleusercontent.com/search?q=cache:x', source: 'test', fields: {} },
    { reviewTextsDir: dir });
  assert.equal(redirect.action, 'skipped');
  assert.equal(redirect.reason, 'unresolvable-redirect-url');
  assert.equal(redirect.durable, true);
  // empty-unknown is an EXPECTED rejection but not permanent (an extractor can come back empty once)
  const empty = createOrMergeReviewFile('hamilton-2015',
    { outletId: 'thestage', outlet: 'The Stage', criticName: 'Unknown', url: null, source: 'test', fields: {} },
    { reviewTextsDir: dir });
  assert.match(empty.reason, /^empty-unknown/);
  assert.equal(empty.durable, false);
  // junk-outlet: BENIGN, not a refusal to remember
  const junk = createOrMergeReviewFile('hamilton-2015',
    { outletId: 'unknown', outlet: 'Unknown', criticName: 'Unknown', url: '', source: 'test', fields: {} },
    { reviewTextsDir: dir });
  assert.equal(junk.action, 'skipped');
  assert.equal(junk.durable, false);
});

test('only url/byline-intrinsic expected rejections are durable', () => {
  const { isDurableRejection } = require('./lib/ingest-skip-classify');
  for (const r of ['cross-market', 'tour-review', 'credited-person-as-critic: Jane Doe', 'listing-page-url: section page']) assert.equal(isDurableRejection(r), true, r);
  for (const r of ['unknown-show-id', 'onMerge-aborted', 'empty-unknown: no URL', 'blocklisted-url', 'no-changes', 'cross-show-url-owned:x']) assert.equal(isDurableRejection(r), false, r);
});

test('bucketWriteResult separates written, existing, durable and refused', () => {
  assert.equal(bucketWriteResult({ action: 'new' }), 'written');
  assert.equal(bucketWriteResult({ action: 'updated' }), 'written');
  assert.equal(bucketWriteResult({ action: 'skipped', reason: 'no-changes', durable: false }), 'existing');
  assert.equal(bucketWriteResult({ action: 'skipped', reason: 'cross-market', durable: true }), 'durable');
  assert.equal(bucketWriteResult({ action: 'skipped', reason: 'cross-show-url-owned:other-show', durable: false }), 'refused');
  assert.equal(bucketWriteResult({ action: 'skipped', reason: 'something-new', durable: false }), 'refused');
  assert.equal(isDurableSkip({ action: 'skipped', durable: true }), true);
  assert.equal(isDurableSkip({ action: 'new', durable: true }), false);
});

test('a recorded refusal is found again (tracking params ignored); dry runs write nothing', () => {
  const showDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2926-show-'));
  const url = 'https://loureviews.blog/2026/05/some-review/';
  assert.equal(isDurablyRejected(showDir, url), false);
  assert.equal(recordDurableRejection(showDir, { url, outletId: 'loureviews', reason: 'cross-market', source: 'test' }, { dryRun: true }), false);
  assert.equal(fs.existsSync(path.join(showDir, REJECTIONS_FILENAME)), false);
  assert.equal(recordDurableRejection(showDir, { url, outletId: 'loureviews', reason: 'cross-market', source: 'test' }), true);
  assert.equal(isDurablyRejected(showDir, url + '?utm_source=x'), true);
  assert.equal(recordDurableRejection(showDir, { url, outletId: 'loureviews', reason: 'cross-market' }), false, 'no duplicate entry');
  const saved = JSON.parse(fs.readFileSync(path.join(showDir, REJECTIONS_FILENAME), 'utf8'));
  assert.equal(saved.urls.length, 1);
});

test('the rejection file is skipped by the rebuild (underscore prefix, like _blocklist.json)', () => {
  assert.ok(REJECTIONS_FILENAME.startsWith('_'));
  const rebuild = fs.readFileSync(path.join(HERE, 'rebuild-all-reviews.js'), 'utf8');
  assert.match(rebuild, /\.filter\(f => f\.endsWith\('\.json'\) && !f\.startsWith\('_'\)\)/);
});

test('poll-loureviews checks the rejection record before fetching and never files a refusal as existing', () => {
  const src = fs.readFileSync(path.join(HERE, 'poll-loureviews.js'), 'utf8');
  const check = src.indexOf('isDurablyRejected(showDir, p.link)');
  const fetch = src.indexOf('fetchHtml(p.link)');
  assert.ok(check > 0 && fetch > 0 && check < fetch, 'durable-rejection check must run before the fetch');
  assert.match(src, /bucketWriteResult\(result\)/);
  assert.match(src, /recordDurableRejection\(showDir/);
  const reextract = fs.readFileSync(path.join(HERE, 're-extract-aggregator-reviews.js'), 'utf8');
  assert.match(reextract, /bucketWriteResult\(result\)/);
});

test('a post the writer re-routed to a sibling show counts as on disk (BRO-5261)', () => {
  const { loureviewsUrlsOnDisk } = require('./lib/loureviews-match');
  const { normalizeUrl } = require('./lib/poller-blocklist');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-ondisk-'));
  fs.mkdirSync(path.join(root, 'x-west-end-2026'));
  fs.mkdirSync(path.join(root, 'x-broadway-2026'));
  fs.mkdirSync(path.join(root, '_pending'));
  fs.writeFileSync(path.join(root, 'x-west-end-2026', 'loureviews--louise-penn.json'),
    JSON.stringify({ url: 'http://loureviews.blog/2026/05/01/review-x/?utm_source=rss' }));
  fs.writeFileSync(path.join(root, 'x-west-end-2026', '_blocklist.json'), JSON.stringify({ urls: [] }));
  const urls = loureviewsUrlsOnDisk(root);
  assert.ok(urls.has(normalizeUrl('https://loureviews.blog/2026/05/01/review-x/')));
  assert.equal(urls.size, 1);
  assert.equal(loureviewsUrlsOnDisk(path.join(root, 'nope')).size, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
