import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

// BRO-3499: collect-review-texts.js extractTextFromHtml now falls back to
// article-extractor.js's dedicated extractor for DEDICATED_EXTRACTOR_HOSTS
// when the generic extraction comes up short. Real functions, no copies.
const require = createRequire(import.meta.url);
const { extractTextFromHtml } = require('../../scripts/collect-review-texts.js');
const { isDedicatedExtractorHost } = require('../../scripts/lib/article-extractor.js');

const BODY = 'A sharp, funny revival that finds new bite in an old farce, with a cast that never misses a beat. '.repeat(4).trim();
const ld = (body) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', articleBody: body })}</script></head><body><div>nav</div></body></html>`;

test('isDedicatedExtractorHost matches the configured outlets only', () => {
  assert.equal(isDedicatedExtractorHost('https://www.lavocedinewyork.com/arts/x.html'), true);
  assert.equal(isDedicatedExtractorHost('https://www.thestage.co.uk/reviews/x'), true);
  assert.equal(isDedicatedExtractorHost('https://www.nytimes.com/x'), false);
});

test('La Voce: a 300-499 char JSON-LD body is recovered via the dedicated extractor', () => {
  assert.ok(BODY.length >= 300 && BODY.length < 500, `fixture length ${BODY.length}`);
  const url = 'https://www.lavocedinewyork.com/arts/2026/review.html';
  assert.equal(extractTextFromHtml(ld(BODY), url), BODY);
});

test('non-dedicated host keeps generic behavior (short body stays empty)', () => {
  assert.equal(extractTextFromHtml(ld(BODY), 'https://example.com/review'), '');
});

// BRO-5219: on nub.news the generic path clears the 500-char fallback threshold
// by keeping the donation appeal, so the dedicated extractor must run FIRST.
test('nub.news: dedicated body wins over a long generic extraction', () => {
  const para = 'The cast handle the river comedy with real warmth and timing. ';
  const appeal = '<p>The Ball is in your court. You can support us with a small payment or at least read us for free. Monthly supporters will enjoy an ad-free experience.</p>';
  const html = '<html><body><article><div id="article_content_block" class="prose">' +
    `<p>${para.repeat(4)}</p><p>${para.repeat(4)}</p>` +
    '</div>' + appeal.repeat(3) + '</article></body></html>';
  const text = extractTextFromHtml(html, 'https://kingston.nub.news/news/local-features/review-x-1');
  assert.match(text, /river comedy/);
  assert.doesNotMatch(text, /support us|Ball is in your court/);
  // A host that merely ends in "nub.news" is not Nub News.
  assert.match(extractTextFromHtml(html, 'https://snub.news/review-x'), /support us/);
});

// BRO-6872: a generic body past 500 chars used to skip the dedicated extractor.
// On L&SA that saved the A Few Good Men review without its closing paragraphs
// and with the address footer, so the site scored a text the critic never
// finished. The rule now: on a dedicated host the longer of the two wins,
// whatever the generic length.
const { preferDedicatedText } = require('../../scripts/collect-review-texts.js');
const lsaPara = (t) => `<p><font face="Arial,Helvetica,Geneva,Swiss,SunSans-Regular" size="2">${t}</font></p>`;
const LSA_PARA = 'The courtroom scenes crackle, but the first act sags under its own weight and the staging inflates a modest potboiler. ';
const LSA_HTML = '<html><body><table><tr><td>' + [1, 2, 3, 4, 5, 6].map((i) => lsaPara(`Paragraph ${i}. ${LSA_PARA.repeat(2)}`)).join('') + '</td></tr></table></body></html>';
const LSA_URL = 'http://www.lightingandsoundamerica.com/news/story.asp?ID=TEST01';

test('L&SA: dedicated body beats a generic body that is past 500 chars but shorter', () => {
  const generic = 'Paragraph 1. ' + LSA_PARA.repeat(5); // > 500 chars, missing the ending
  assert.ok(generic.length > 500, `generic ${generic.length}`);
  const text = preferDedicatedText(generic, LSA_HTML, LSA_URL);
  assert.match(text, /Paragraph 6\./);
  assert.ok(text.length > generic.length);
});

// BRO-7171 Stage 5: "the longer wins" let page chrome make the generic copy
// win. The generic body now wins only when it holds real prose the outlet
// extractor missed (gap-acceptance novelProseVerdict on the stored forms).
test('dedicated host keeps a generic body only when it adds real prose', () => {
  const junk = 'x'.repeat(5000);
  assert.match(preferDedicatedText(junk, LSA_HTML, LSA_URL), /Paragraph 6\./, 'longer junk must not win');
  const extra = [1, 2, 3, 4, 5, 6].map((i) => `Extra ${i}: the second act finally finds its footing when the defence calls a surprise witness and the room goes quiet for a long while.`).join('\n\n');
  const richer = [1, 2, 3, 4, 5, 6].map((i) => `Paragraph ${i}. ${LSA_PARA.repeat(2).trim()}`).join('\n\n') + '\n\n' + extra;
  assert.equal(preferDedicatedText(richer, LSA_HTML, LSA_URL), richer, 'generic with novel prose wins');
});

test('non-dedicated host never runs the dedicated extractor', () => {
  const generic = 'Paragraph 1. ' + LSA_PARA.repeat(5);
  assert.equal(preferDedicatedText(generic, LSA_HTML, 'https://example.com/review'), generic);
});

test('extractTextFromHtml on an L&SA page returns every review paragraph', () => {
  const text = extractTextFromHtml(LSA_HTML, LSA_URL);
  for (const i of [1, 6]) assert.match(text, new RegExp(`Paragraph ${i}\\.`));
});
