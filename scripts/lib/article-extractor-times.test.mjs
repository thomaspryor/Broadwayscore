// BRO-7569: The Times' 2026 template marks paragraphs <p class="wp-block-paragraph"> (no uuid ids).
// The extractor returned null for every such page, so 36 Times UK reviews stayed excerpts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractArticleText } = require('./article-extractor.js');

const para = (t, attrs) => `<p ${attrs}>${t}</p>`;
const LINES = [
  'Welcome to the worst show of the year so far. This verbatim musical about homophobia and Section 28 is long-winded.',
  'Breach Theatre’s show, a collaboration between writers Billy Barrett and Ellice Stevens, runs for two hours without a break.',
  'Its heart may be in the right place, but everything about this production is pitched at the wrong volume throughout.',
];
const wrap = (ps) => `<html><body><header>nav</header><article id="article-main" class="wp-block-group"><h1>Title</h1>${ps}<div data-testid="article-comments"></div></article></body></html>`;

test('new Times template: wp-block-paragraph body paragraphs are extracted', () => {
  const html = wrap(LINES.map((l) => para(l, 'class="wp-block-paragraph"')).join('') + para('Share this article now and then some more', 'class="other"'));
  const t = extractArticleText(html, 'thetimes.com');
  assert.ok(t && t.includes('Welcome to the worst show') && t.includes('pitched at the wrong volume'), String(t).slice(0, 80));
  assert.ok(!t.includes('Share this article'));
});

test('old Times template: uuid-id paragraphs still extracted', () => {
  const ids = ['0a1b2c3d-1111-2222-3333-444455556666', '0a1b2c3d-1111-2222-3333-444455556667', '0a1b2c3d-1111-2222-3333-444455556668'];
  const html = wrap(LINES.map((l, i) => para(l, `id="${ids[i]}"`)).join(''));
  const t = extractArticleText(html, 'thetimes.com');
  assert.ok(t && t.includes('Welcome to the worst show'));
});

test('a page with no body paragraphs still returns null (logged-out wall)', () => {
  assert.equal(extractArticleText(wrap(para('Subscribe to read the full article please', 'class="wp-block-paragraph"')), 'thetimes.com'), null);
});
