// BRO-4933: opening-night discovery must fill the body in the same run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { prefetchDiscoveredArticle, applyPrefetch } = require('./discovery-prefetch.js');
const { createOrMergeReviewFile } = require('./review-file-writer.js');

const para = 'Rent arrives in the West End with a raw, loud, deeply felt energy that the cast sustains for the whole evening. ';
const HTML = `<html><head><title>Rent review</title>
<meta property="article:published_time" content="2026-10-09T09:15:00Z">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","author":{"@type":"Person","name":"Nick Curtis"},"datePublished":"2026-10-09T09:15:00Z"}</script>
</head><body><article>${'<p>' + para.repeat(8) + '</p>'.repeat(1)}</article>${' '.repeat(600)}</body></html>`;
const URL_ = 'https://www.standard.co.uk/culture/theatre/rent-review-west-end-b123456.html';

test('prefetch returns body + JSON-LD byline', async () => {
  const pre = await prefetchDiscoveredArticle(URL_, { criticName: null, fetchPageFn: async () => ({ content: HTML }) });
  assert.ok(pre.fullText && pre.fullText.length >= 200, 'fullText filled');
  assert.equal(pre.criticName, 'Nick Curtis');
});

test('prefetch failure is non-fatal and leaves stub fields empty', async () => {
  const pre = await prefetchDiscoveredArticle(URL_, { fetchPageFn: async () => { throw new Error('boom'); } });
  assert.equal(pre.fullText, null);
  const out = applyPrefetch({ criticName: 'Unknown', fields: { fullText: null } }, pre);
  assert.equal(out.fields.fullText, null);
});

test('discovery stub for in-window show ends with non-empty fullText on disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4933-'));
  const pre = await prefetchDiscoveredArticle(URL_, { fetchPageFn: async () => ({ content: HTML }) });
  const res = createOrMergeReviewFile('rent-west-end-2026', applyPrefetch({
    outletId: 'evening-standard', outlet: 'Evening Standard', criticName: 'Unknown', url: URL_,
    source: 'opening-night-discovery',
    fields: { publishDate: null, fullText: null, contentTier: 'excerpt' },
  }, pre), { reviewTextsDir: dir });
  assert.ok(res.filepath, JSON.stringify(res));
  const d = JSON.parse(fs.readFileSync(res.filepath, 'utf8'));
  assert.ok(d.fullText && d.fullText.length >= 200, `fullText empty: ${JSON.stringify(d).slice(0, 300)}`);
  assert.ok(!/--unknown\.json$/.test(res.filepath), res.filepath);
});

test('unregistered outlet is not prefetched (keeps writer unknown-outlet guard effective)', async () => {
  let called = false;
  const pre = await prefetchDiscoveredArticle(URL_, { outletId: 'unknown', fetchPageFn: async () => { called = true; return { content: HTML }; } });
  assert.equal(called, false);
  assert.equal(pre.fullText, null);
});

test('hung fetch is bounded by timeoutMs', async () => {
  const pre = await prefetchDiscoveredArticle(URL_, { timeoutMs: 20, fetchPageFn: () => new Promise(() => {}) });
  assert.equal(pre.fullText, null);
});

test('registered outlet with SERP-less byline resolves from JSON-LD', async () => {
  const pre = await prefetchDiscoveredArticle(URL_, { outletId: 'standard', showId: 'rent-west-end-2026', fetchPageFn: async () => ({ content: HTML }) });
  assert.equal(pre.criticName, 'Nick Curtis');
  assert.ok(pre.fullText);
});
