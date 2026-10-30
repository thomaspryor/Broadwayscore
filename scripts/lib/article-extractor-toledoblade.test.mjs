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
