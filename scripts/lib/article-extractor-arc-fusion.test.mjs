// BRO-7884: Arc XP (Fusion) pages render the story client-side; the body is in Fusion.globalContent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractArticleTextFromUrl, extractArcFusionBody } = require('./article-extractor.js');

const filler = 'Synthetic sentence about a revival and its stars, with a {brace} and a \\"quote\\". '.repeat(3);
const els = [
  { type: 'text', content: `First para ${filler}` },
  { type: 'image', url: 'x.jpg' },
  { type: 'text', content: `Second <i>para</i> ${filler}` },
  { type: 'text', content: `Third para ${filler}` },
];
const page = `<html><body><nav>Arts and Culture Share</nav><p>Subscribe to our newsletter.</p>`
  + `<script type="application/javascript">window.Fusion=window.Fusion||{};Fusion.globalContent=${JSON.stringify({ canonical_url: '/a/', content_elements: els })};Fusion.globalContentConfig={"source":"x"};</script></body></html>`;

test('an unknown Arc host returns the text elements joined, not the page chrome', () => {
  const t = extractArticleTextFromUrl(page, 'https://www.columbiaspectator.com/arts-and-culture/2026/11/19/review-x/');
  assert.match(t, /^First para/);
  assert.match(t, /Second para/);
  assert.match(t, /Third para/);
  assert.doesNotMatch(t, /Subscribe|x\.jpg|<i>/);
  assert.equal(t.split('\n\n').length, 3);
});

test('null when there is no Fusion payload or the body is short', () => {
  assert.equal(extractArcFusionBody('<html><p>nothing</p></html>'), null);
  const short = `<script>Fusion.globalContent=${JSON.stringify({ content_elements: [{ type: 'text', content: 'tiny' }] })};</script>`;
  assert.equal(extractArcFusionBody(short), null);
});

test('tolerates whitespace around the assignment', () => {
  const spaced = page.replace('Fusion.globalContent=', 'Fusion.globalContent = ');
  assert.match(extractArcFusionBody(spaced), /^First para/);
});

test('a page whose markup already holds the body keeps the markup text (Fusion is last resort)', () => {
  const body = '<article>' + Array.from({ length: 6 }, (_, i) => `<p>Markup paragraph ${i} ${filler}</p>`).join('') + '</article>';
  const teaser = `<script>Fusion.globalContent=${JSON.stringify({ content_elements: [{ type: 'text', content: `Teaser only ${filler} ${filler}` }] })};</script>`;
  const t = extractArticleTextFromUrl(`<html><body>${body}${teaser}</body></html>`, 'https://www.example-arc-site.com/x/');
  assert.match(t, /Markup paragraph 0/);
  assert.doesNotMatch(t, /Teaser only/);
});
