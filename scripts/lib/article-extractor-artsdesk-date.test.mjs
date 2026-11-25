// The Arts Desk prints its date only in <div class='author_date'> (BRO-8321). Synthetic fixtures, no live data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractPublishDate } = require('./article-extractor');
const page = (created) => `<html><body><h1 class="articleTitle">A Christmas Carol, Old Vic review</h1>
<div class='author_date'><span class='author'>by&nbsp;<a href='/user/815'>Rachel Halliburton</a></span><span class='created'>${created}</span></div>
<div class="related"><span class='created'>Monday, 1 January 2018</span></div></body></html>`;
const URL_ = 'https://theartsdesk.com/theatre/christmas-carol-old-vic-review-giles-terera';

test('reads the article date from the author_date block, never a related-article card', () => {
  assert.equal(extractPublishDate(page('Wednesday, 25 November 2026'), URL_), '2026-11-25');
  assert.equal(extractPublishDate(page('Friday, 9 December 2022'), URL_), '2022-12-09');
});

test('no author_date block (or two of them) gives no date rather than a guess', () => {
  assert.equal(extractPublishDate('<html><body><p>nothing here</p></body></html>', URL_), null);
  const two = page('Wednesday, 25 November 2026') + `<div class='author_date'><span class='created'>Friday, 9 December 2022</span></div>`;
  assert.equal(extractPublishDate(two, URL_), null);
});
