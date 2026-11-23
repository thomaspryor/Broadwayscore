// BRO-8210: Blogger Dynamic Views pages hold no post body in server HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const bdv = require('./blogger-dynamic-views.js');
const { extractArticleTextFromUrl, extractPublishDate } = require('./article-extractor.js');

// Real Dynamic Views shell (newyorktheatrereview.blogspot.com, submission #1199).
const shell = fs.readFileSync(path.join(here, '__fixtures__/blogger-dynamic-views-nytr.html'), 'utf8');
const URL_ = 'https://newyorktheatrereview.blogspot.com/2026/09/we-have-to-talk-about-john-cameron-page.html?m=1';
const para = 'Falls for Jodie is a tightly drawn two-hander at The Tank, and the direction moves the actors well around a small space. ';
const feed = { entry: {
  id: { $t: 'tag:blogger.com,1999:blog-4235279950148760642.post-6339047144160648619' },
  link: [{ rel: 'alternate', href: 'https://newyorktheatrereview.blogspot.com/2026/09/we-have-to-talk-about-john-cameron-page.html' }],
  title: { $t: 'We Have to Talk About John' },
  published: { $t: '2026-09-29T22:27:00.647-04:00' },
  author: [{ name: { $t: 'NYTR' } }],
  content: { $t: `<p>${para.repeat(6)}</p><p>${para.repeat(4)}</p>` },
} };

test('the real shell extracts nothing on its own (the bug)', () => {
  assert.ok((extractArticleTextFromUrl(shell, URL_) || '').length < 200);
});

test('detects the Dynamic Views shell and its post id', () => {
  assert.equal(bdv.bloggerDynamicViewsPostId(shell), '6339047144160648619');
  assert.equal(bdv.bloggerFeedUrl(URL_, '6339047144160648619'),
    'https://newyorktheatrereview.blogspot.com/feeds/posts/default/6339047144160648619?alt=json');
});

test('classic Blogger pages (post-body in HTML) are left alone', () => {
  const classic = `${shell}<div class='post-body entry-content'>x</div>`;
  assert.equal(bdv.bloggerDynamicViewsPostId(classic), null);
  assert.equal(bdv.bloggerDynamicViewsPostId('<html>wordpress</html>'), null);
});

test('expand fetches the feed and the existing extractor reads the body + date', async () => {
  const seen = [];
  const r = await bdv.expandBloggerDynamicViews(shell, URL_, async (u) => { seen.push(u); return { content: JSON.stringify(feed) }; });
  assert.equal(r.expanded, true);
  assert.deepEqual(seen, ['https://newyorktheatrereview.blogspot.com/feeds/posts/default/6339047144160648619?alt=json']);
  const text = extractArticleTextFromUrl(r.html, URL_);
  assert.ok(text.length > 500, `got ${text.length}`);
  assert.match(text, /tightly drawn two-hander/);
  if (extractPublishDate) assert.equal(extractPublishDate(r.html, URL_), '2026-09-29');
});

test('feed wrapped in <pre> by a fetch provider still parses', () => {
  assert.ok(bdv.bloggerFeedToHtml(`<html><body><pre>${JSON.stringify(feed)}</pre></body></html>`));
});

test('failed or empty feed keeps the original HTML', async () => {
  const a = await bdv.expandBloggerDynamicViews(shell, URL_, async () => { throw new Error('403'); });
  assert.equal(a.expanded, false); assert.equal(a.html, shell); assert.equal(a.error, '403');
  const b = await bdv.expandBloggerDynamicViews(shell, URL_, async () => '{"entry":{"content":{"$t":"short"}}}');
  assert.equal(b.expanded, false); assert.equal(b.html, shell);
});

test('entity-escaped <pre> body from a browser-rendering tier still parses', () => {
  const esc = JSON.stringify(feed).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = bdv.bloggerFeedToHtml(`<html><head></head><body><pre style="x">${esc}</pre></body></html>`);
  assert.ok(html);
  assert.match(extractArticleTextFromUrl(html, URL_), /tightly drawn two-hander/);
});

test('no author meta (Blogger account handle is not the critic); quotes in title escaped', () => {
  const f = { entry: { ...feed.entry, title: { $t: `O'Hara's "Play"` } } };
  const html = bdv.bloggerFeedToHtml(f);
  assert.doesNotMatch(html, /name="author"/);
  assert.match(html, /O&#39;Hara&#39;s &quot;Play&quot;/);
});

test('a feed entry for a different post is refused', async () => {
  const other = { entry: { ...feed.entry, id: { $t: 'tag:blogger.com,1999:blog-1.post-999999' } } };
  const r = await bdv.expandBloggerDynamicViews(shell, URL_, async () => JSON.stringify(other));
  assert.equal(r.expanded, false);
  const otherLink = { entry: { ...feed.entry, link: [{ rel: 'alternate', href: 'https://newyorktheatrereview.blogspot.com/2026/09/another-post.html' }] } };
  assert.equal((await bdv.expandBloggerDynamicViews(shell, URL_, async () => JSON.stringify(otherLink))).expanded, false);
});

test('a jump-break (Read more) truncated feed is refused', async () => {
  const cut = { entry: { ...feed.entry, content: { $t: `${feed.entry.content.$t}<a href='https://x.blogspot.com/p.html#more'>Read more »</a>` } } };
  assert.equal((await bdv.expandBloggerDynamicViews(shell, URL_, async () => JSON.stringify(cut))).expanded, false);
});
