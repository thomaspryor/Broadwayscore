// BRO-8224: the review-text collectors (not only ingest-review-from-url.js,
// BRO-8210) must rebuild a Blogger Dynamic Views shell from the feed API.
// Per CLAUDE.md rule 15 this require()s the real collector function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const bdv = require('./blogger-dynamic-views.js');
const collector = require('../collect-review-texts-v2.js');

const shell = fs.readFileSync(path.join(here, '__fixtures__/blogger-dynamic-views-nytr.html'), 'utf8');
const URL_ = 'https://newyorktheatrereview.blogspot.com/2026/09/we-have-to-talk-about-john-cameron-page.html?m=1';
const FEED = 'https://newyorktheatrereview.blogspot.com/feeds/posts/default/6339047144160648619?alt=json';
const para = 'Falls for Jodie is a tightly drawn two-hander at The Tank, and the direction moves the actors well around a small space. ';
const feed = { entry: {
  id: { $t: 'tag:blogger.com,1999:blog-4235279950148760642.post-6339047144160648619' },
  link: [{ rel: 'alternate', href: 'https://newyorktheatrereview.blogspot.com/2026/09/we-have-to-talk-about-john-cameron-page.html' }],
  title: { $t: 'We Have to Talk About John' },
  published: { $t: '2026-09-29T22:27:00.647-04:00' },
  content: { $t: `<p>${para.repeat(9)}</p><p>${para.repeat(9)}</p>` },
} };

function fakeFetch(seen) {
  return async (u) => {
    seen.push(u);
    if (u === FEED) return { content: JSON.stringify(feed), source: 'direct' };
    if (u === URL_) return { content: shell, source: 'scrapingdog' };
    return { content: '<html><body><article>' + para.repeat(40) + '</article></body></html>', source: 'direct' };
  };
}

test('the shell alone gives the collector almost no text (the bug)', () => {
  assert.ok(collector.extractTextFromHtml(shell).split(/\s+/).length < 300);
});

test('collect-review-texts-v2 fetch path calls the expander and re-extracts the body', async () => {
  const seen = [];
  const r = await collector.fetchWithScrapingBee(URL_, fakeFetch(seen));
  assert.deepEqual(seen, [URL_, FEED]);
  assert.equal(r.bloggerFeedUrl, FEED);
  assert.equal(r.method, 'scrapingdog', 'method kept for sourceMethod mapping');
  assert.match(r.text, /tightly drawn two-hander/);
  assert.ok(r.text.split(/\s+/).length >= 300, `got ${r.text.split(/\s+/).length} words`);
  assert.match(r.html, /class='post-body entry-content'/);
});

test('a non-Blogger page is not sent to the feed', async () => {
  const seen = [];
  const r = await collector.fetchWithScrapingBee('https://example.com/review', fakeFetch(seen));
  assert.deepEqual(seen, ['https://example.com/review']);
  assert.equal(r.bloggerFeedUrl, undefined);
});

test('a failed feed read keeps the original result and reports the feed url', async () => {
  const r = await bdv.expandFetchedArticle({ html: shell, text: 'x', method: 'playwright' }, URL_,
    async () => { throw new Error('403'); }, () => 'never');
  assert.equal(r.html, shell);
  assert.equal(r.text, 'x');
  assert.equal(r.bloggerFeedUrl, FEED);
  assert.equal(r.bloggerFeedError, '403');
});
