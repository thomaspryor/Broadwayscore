// BRO-6573: Toledo Blade keeps the story in pgStoryZeroJSON, not in page markup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractArticleTextFromUrl, extractToledoBladeBody } = require('./article-extractor.js');

const para = (t) => `<div class=\\"OutlineElement\\">\\n<p class=\\"Paragraph\\"><span class=\\"TextRun\\"><span class=\\"NormalTextRun\\">${t}<\\/span><\\/span><\\/p>\\n<\\/div>`;
const filler = 'Synthetic sentence about a touring musical and its audience. '.repeat(3);
const page = `<html><div class="pgevoke-pagecontent"><script>pgStoryZeroJSON = {"articles":[{"title":"T","body": "${para('First &rsquo;para ' + filler)}${para('Second para ' + filler)}${para('He said \\"hi\\" ' + filler)}","other":"x"}]}</script><p>nav chrome</p></div></html>`;

test('extracts paragraphs from the embedded JSON body', () => {
  const t = extractArticleTextFromUrl(page, 'https://www.toledoblade.com/a-e/music-theater-dance/2026/10/16/x/stories/1');
  assert.match(t, /^First/);
  assert.match(t, /Second para/);
  assert.match(t, /He said "hi"/);
  assert.doesNotMatch(t, /nav chrome|<p|TextRun/);
  assert.equal(t.split('\n\n').length, 3);
});

test('returns null when the page has no body field', () => {
  assert.equal(extractToledoBladeBody('<html><p>nothing</p></html>'), null);
});

test('ignores earlier "body" keys outside the story script and keeps the longest body', () => {
  const html = `<script type="application/ld+json">{"body":"<p>${filler}</p>"}</script>` + page.replace('"other":"x"', '"related":{"body":"<p>short teaser</p>"}');
  const t = extractToledoBladeBody(html);
  assert.match(t, /^First/);
  assert.doesNotMatch(t, /short teaser/);
});

test('tolerates raw newlines inside the body string', () => {
  const html = `<script>pgStoryZeroJSON = {"articles":[{"body": "<p>${filler}\nsecond line</p>"}]}</script>`;
  assert.match(extractToledoBladeBody(html), /second line/);
});

test('returns null without the story script', () => {
  assert.equal(extractToledoBladeBody(`<script>{"body":"<p>${filler}</p>"}</script>`), null);
});

test('BroadwayWorld page uses JSON-LD articleBody over sidebar chrome (BRO-6573)', () => {
  const body = 'Synthetic review sentence about a touring musical. '.repeat(10).trim();
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'NewsArticle', headline: 'Review: X', articleBody: body })}</script></head><body><article><p>5. Pantry Girls 37 min Season 2, Episode 5 sidebar card</p></article></body></html>`;
  const t = extractArticleTextFromUrl(html, 'https://www.broadwayworld.com/rhode-island/article/Review-X-20261024');
  assert.equal(t, body);
});
