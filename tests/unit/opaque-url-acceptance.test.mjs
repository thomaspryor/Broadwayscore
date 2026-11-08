// BRO-7163 F02: opaque outlet URLs (story.asp?ID=..., post.cfm?id=...) are accepted on headline/link-text evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isOpaqueArticleUrl, headlineAsUrl } = require('../../scripts/lib/opaque-article-url.js');
const gap = require('../../scripts/audit-show-review-gap.js');

test('opaque vs slugged URLs', () => {
  for (const u of ['https://x.com/story.asp?ID=48291', 'https://x.com/post.cfm?id=7', 'https://x.com/p/48291', 'https://x.com/2026/11/48291']) assert.equal(isOpaqueArticleUrl(u), true, u);
  for (const u of ['https://x.com/the-river-room-review/', 'https://x.com/london-theatre/the-river-room-review']) assert.equal(isOpaqueArticleUrl(u), false, u);
});

const SHOW = { id: 'the-river-room-off-west-end-2026', title: 'The River Room', market: 'west-end', category: 'off-west-end' };
const acc = (url, title) => gap.acceptSerpCensusResult({ url, title, snippet: 'A review of The River Room' }, { show: SHOW, showInfo: { creativeNames: [] } });

test('SERP census accepts an opaque URL on a known outlet when the headline names the show', () => {
  assert.ok(acc('https://www.whatsonstage.com/story.asp?ID=48291', 'The River Room review ★★★★'));
});
test('SERP census still rejects an opaque URL whose headline names a different work', () => {
  assert.equal(acc('https://www.whatsonstage.com/story.asp?ID=48291', 'The Glass Menagerie review'), null);
});
test('SERP census does not accept an opaque URL on an unknown host on headline alone', () => {
  assert.equal(acc('https://some-random-blog.example/story.asp?ID=48291', 'The River Room review ★★★★'), null);
});
test('headlineAsUrl slugs a headline', () => {
  assert.equal(headlineAsUrl('The River Room — review!'), 'https://headline.invalid/the-river-room-review/');
});

test('roundup link extraction falls back to link text for opaque hrefs (wiring)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../scripts/audit-show-review-gap.js', import.meta.url), 'utf8');
  assert.match(src, /if \(!isOpaqueArticleUrl\(href\)\) return;/);
});
