import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { JSDOM } from 'jsdom';

// BRO-6872: readers dropped whole review paragraphs for containing ordinary
// words ("subscribe", "sign up", "back to", "Central Park West"). The L&SA
// A Few Good Men review lost its closing paragraph this way. Real functions only.
const require = createRequire(import.meta.url);
const { isChromeParagraph } = require('../../scripts/lib/chrome-paragraph.js');
const { extractArticleTextFromDocument } = require('../../scripts/lib/dom-article-extractor.js');
const { extractTextFromHtml, extractArticleText: extractFromPage } = require('../../scripts/collect-review-texts.js');
const { extractArticleText } = require('../../scripts/lib/article-extractor.js');

const PROSE = 'Whether audiences still subscribe to its view of honor is another matter, and the second act, where the young men who sign up for the Marines face the court, finally finds the play its pulse and its moral argument. ';
const LONG = PROSE.repeat(2); // > 300 chars of prose with both words
const FILLER = (i) => `Paragraph ${i}. The cast is uniformly sharp, the direction keeps the long evening moving, and the design gives the courtroom a cold, official gleam that suits the material well. `;

test('isChromeParagraph: long prose with clutter words is kept; short clutter and promo phrases are dropped', () => {
  assert.ok(LONG.length > 300);
  assert.equal(isChromeParagraph(LONG), false);
  assert.equal(isChromeParagraph('Subscribe to get the latest reviews.'), true);
  assert.equal(isChromeParagraph('We use cookies to improve your experience. ' + LONG), true);
  assert.equal(isChromeParagraph('Sign up for our weekly theatre newsletter and never miss a review. ' + LONG), true);
  assert.equal(isChromeParagraph('A short line about the back to back scenes.', /back to/i), true);
});

test('browser extractor keeps a long paragraph that says "subscribe" and "sign up for"', () => {
  const html = `<html><body>${[1, 2, 3, 4].map((i) => `<p>${FILLER(i)}</p>`).join('')}<p>${LONG}</p><p>Subscribe to our newsletter today.</p></body></html>`;
  const { document } = new JSDOM(html).window;
  const text = extractArticleTextFromDocument(document, 'https://example.com/review');
  assert.match(text, /subscribe to its view of honor/);
  assert.match(text, /sign up for the Marines face the court/);
  assert.doesNotMatch(text, /Subscribe to our newsletter/);
});

test('HTML extractor (collect-review-texts) keeps the same paragraph', () => {
  const html = `<html><body><div class="entry-content">${[1, 2, 3, 4].map((i) => `<p>${FILLER(i)}</p>`).join('')}<p>${LONG}</p></div></body></html>`;
  const text = extractTextFromHtml(html, 'https://example.com/review');
  assert.match(text, /subscribe to its view of honor/);
});

const lsaP = (t) => `<p><font face="Arial,Helvetica,Geneva,Swiss,SunSans-Regular">${t}</font></p>`;
test('L&SA: "comes back to" and "Central Park West" prose survive; nav and footer do not', () => {
  const body = [1, 2, 3].map((i) => lsaP(FILLER(i))).join('')
    + lsaP('When the brother comes back to the apartment on Central Park West, the family finally says what it has avoided all evening, and the play turns.')
    + lsaP('Back to Today\'s News')
    + lsaP('Lighting&amp;Sound America, 372 Central Park West, New York. Tel: 212 000 0000');
  const text = extractArticleText(`<html><body><table><tr><td>${body}</td></tr></table></body></html>`, 'lightingandsoundamerica.com');
  assert.match(text, /comes back to the apartment on Central Park West/);
  assert.doesNotMatch(text, /Today's News|Tel:/);
});

test('The Stage: a review paragraph like "The protagonist is a writer" is not an author bio', () => {
  const para = (t) => `<p>${t}</p>`;
  const html = '<html><body><div class="aos-Article-IntroText">intro</div>'
    + [1, 2, 3].map((i) => para(FILLER(i))).join('')
    + para('The protagonist is a writer whose deadline keeps slipping, and the production makes that panic funny before it makes it sad, which is the evening at its best.')
    + para('Holly Smith is a culture journalist based in London.')
    + '</body></html>';
  const text = extractArticleText(html, 'thestage.co.uk');
  assert.match(text, /The protagonist is a writer/);
  assert.doesNotMatch(text, /culture journalist/);
});

test('browser path consults the dedicated extractor on dedicated hosts', async () => {
  const url = 'http://www.lightingandsoundamerica.com/news/story.asp?ID=TEST02';
  const html = `<html><body><table><tr><td>${[1, 2, 3, 4, 5].map((i) => lsaP(FILLER(i))).join('')}</td></tr></table></body></html>`;
  const shortDom = FILLER(1) + FILLER(2) + FILLER(3); // a DOM read that lost the ending
  const page = { url: () => url, evaluate: async (src) => (String(src).includes('decode') ? 0 : shortDom), content: async () => html };
  const text = await extractFromPage(page);
  assert.match(text, /Paragraph 5\./);
});

test('browser extractor strips a capitalised sign-up pitch but keeps lowercase prose', () => {
  const html = `<html><body><article>${[1, 2, 3, 4].map((i) => `<p>${FILLER(i)}</p>`).join('')}<p>${LONG}</p><p>Love our arts coverage? Sign up for City Lights, our twice-weekly guide to arts and nightlife.</p></article></body></html>`;
  const { document } = new JSDOM(html).window;
  const text = extractArticleTextFromDocument(document, 'https://example.com/review');
  assert.doesNotMatch(text, /City Lights/);
  assert.match(text, /sign up for the Marines face the court/);
});

const { CHROME_PHRASES } = require('../../scripts/lib/chrome-paragraph.js');
test('drift: the browser extractor inlines CHROME_PHRASES verbatim', () => {
  assert.ok(extractArticleTextFromDocument.toString().includes(CHROME_PHRASES.source),
    'dom-article-extractor.js must inline the same CHROME_PHRASES as scripts/lib/chrome-paragraph.js');
});

test('server readers keep short prose that says "sign up" or "advertisement" (no new words)', () => {
  const shortProse = 'The recruits sign up with a swagger, and a TV advertisement for the Corps plays during the scene change.';
  assert.ok(shortProse.length < 300);
  assert.equal(isChromeParagraph(shortProse), false);
  const html = `<html><body><div class="entry-content">${[1, 2, 3, 4].map((i) => `<p>${FILLER(i)}</p>`).join('')}<p>${shortProse}</p></div></body></html>`;
  assert.match(extractTextFromHtml(html, 'https://example.com/review'), /recruits sign up with a swagger/);
});

test('long clutter with a clear promo phrase is still dropped', () => {
  assert.equal(isChromeParagraph('This website uses cookies to improve your experience. ' + LONG), true);
  assert.equal(isChromeParagraph("Sign up for Variety's newsletter for the latest. " + LONG), true);
});
