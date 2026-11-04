import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractArticleText, extractStandfirst } = require('../../scripts/lib/article-extractor');

// TheaterMania's 2026 layout: the dek sits in div.title-area under the <h1>, the review body in div.news-content.
// The body pattern starts below the title block, so before BRO-6872 the dek (often the verdict) was dropped.
const DEK = 'A starry cast cannot find the comic pulse of this creaky old satire.';
const body = '<p>' + 'The revival moves at a stately pace and the jokes land softly, if at all, across a long evening. '.repeat(6) + '</p>';
const page = ({ dek = DEK, description = DEK, bodyHtml = body } = {}) => `<html><head>
<meta name="description" content="${description}" />
<meta property="og:description" content="${description}" />
</head><body>
<div class="title-area"><a href="/news/?categories=reviews">Reviews</a><h1 class="h2 entry-title">Review: A Revival Short on Laughs</h1> <p>${dek}</p></div>
<div class="news-content">${bodyHtml}<section class="featured-in-this-story">Featured</section></div>
</body></html>`;
const host = 'www.theatermania.com';

test('a dek under the headline that matches the page description is kept ahead of the body', () => {
  const text = extractArticleText(page(), host);
  assert.ok(text.startsWith(`${DEK}\n\n`), text.slice(0, 120));
  assert.ok(text.includes('The revival moves at a stately pace'));
  assert.equal(text.split(DEK).length - 1, 1);
});

test('a paragraph under the headline that is not the declared description is not added', () => {
  const text = extractArticleText(page({ dek: 'Photo: Joan Marcus. Share this story with a friend today please.' }), host);
  assert.ok(text.startsWith('The revival moves'), text.slice(0, 80));
  assert.equal(extractStandfirst(page({ dek: 'Photo: Joan Marcus. Share this story with a friend today please.' })), null);
});

test('a page description that is not printed under the headline is not added', () => {
  const html = page().replace(/<h1[^>]*>[\s\S]*?<\/h1>\s*<p>[\s\S]*?<\/p>/, '<h1>Review</h1><div class="byline">By A Critic</div>');
  assert.equal(extractStandfirst(html), null);
  assert.ok(extractArticleText(html, host).startsWith('The revival moves'));
});

test('a dek the body already contains is not repeated', () => {
  const html = page({ bodyHtml: `<p>${DEK}</p>${body}` });
  const text = extractArticleText(html, host);
  assert.equal(text.split(DEK).length - 1, 1);
});

test('entities and curly quotes in the description still match the printed dek', () => {
  const dek = 'Bill Irwin and a starry cast can’t find the comedic pulse of Molière’s medical satire.';
  const description = 'Bill Irwin and a starry cast can&#8217;t find the comedic pulse of Moli&egrave;re&#8217;s medical satire.';
  assert.equal(extractStandfirst(page({ dek, description })), dek);
});

test('no body means no text, dek or not', () => {
  assert.equal(extractArticleText('<html><head><meta name="description" content="' + DEK + '"></head><body><h1>T</h1><p>' + DEK + '</p></body></html>', host), null);
});
