import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chooseArticleBody, SHORT_JSONLD_MAX } = require('../../scripts/lib/jsonld-body-choice.js');
const { extractTextFromHtml } = require('../../scripts/collect-review-texts.js');

const para = (n, word) => Array.from({ length: n }, (_, i) => `<p>${word} paragraph ${i} ${'lorem ipsum dolor sit amet '.repeat(8)}</p>`).join('\n');
const ldPage = (body, paragraphs) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', articleBody: body })}</script></head><body><article>${paragraphs}</article></body></html>`;

describe('chooseArticleBody (BRO-5222)', () => {
  const opening = 'Chronicling the birth of a new medium and the patent fight that followed, this drama ';
  it('prefers paragraphs when the JSON-LD body is a short teaser of them', () => {
    const r = chooseArticleBody(opening.repeat(7), `${opening.repeat(7)} ${'more review prose '.repeat(300)}`);
    assert.equal(r.source, 'paragraphs');
  });
  it('matches the teaser through entities, curly quotes and accents', () => {
    const ld = `The show&#8217;s opening at the Théâtre ${'x '.repeat(300)}`;
    const ps = `The show’s opening at the Theatre ${'x '.repeat(300)} ${'more prose '.repeat(200)}`;
    assert.equal(chooseArticleBody(ld, ps).source, 'paragraphs');
  });
  it('keeps a short real JSON-LD review when the paragraphs are unrelated page chrome', () => {
    const ld = 'A capsule review of a revival that lands every joke. '.repeat(17);
    const ps = 'Related story: another show opens next week with a new cast. '.repeat(60);
    assert.equal(chooseArticleBody(ld, ps).source, 'jsonld');
  });
  it('keeps a long JSON-LD body even when paragraphs are longer', () => {
    assert.equal(chooseArticleBody('t'.repeat(SHORT_JSONLD_MAX), 'p'.repeat(20000)).source, 'jsonld');
  });
  it('keeps a short JSON-LD body when paragraphs are not clearly fuller', () => {
    assert.equal(chooseArticleBody('t'.repeat(800), 'p'.repeat(1500)).source, 'jsonld');
  });
});

describe('extractTextFromHtml JSON-LD teaser fallback (BRO-5222)', () => {
  it('returns the full paragraphs when JSON-LD only carries a teaser', () => {
    const paras = para(20, 'Full');
    const teaser = paras.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 620);
    const out = extractTextFromHtml(ldPage(teaser, paras), 'https://variety.com/x/');
    assert.ok(out.length > teaser.length * 2, `got ${out.length}`);
    assert.match(out, /^Full paragraph 0/);
  });
  it('keeps a short JSON-LD review over unrelated paragraphs with no article container', () => {
    const body = 'A capsule review of a revival that lands every joke. '.repeat(17);
    const out = extractTextFromHtml(ldPage(body, para(20, 'Related')), 'https://example.com/x/');
    assert.equal(out, body.trim());
  });
  it('still returns a full JSON-LD body', () => {
    const body = 'Complete body sentence. '.repeat(120);
    const out = extractTextFromHtml(ldPage(body, para(3, 'Side')), 'https://variety.com/x/');
    assert.equal(out, body.trim());
  });
});

describe('extractTextFromHtml Variety promo modules (BRO-5222)', () => {
  const promo = `<div class="injected-related-story"><h3>Related Stories</h3><div><a>'Other Show' Review: Something Else Entirely Happens Here</a></div></div>`;
  const varietyPage = (ld) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', articleBody: ld })}</script></head><body><article><div class="a-content">${para(4, 'Review')}${promo}${para(12, 'Review later')}</div><p>Read More About: theater</p></article></body></html>`;
  it('drops the mid-article Related Stories block and keeps all review prose', () => {
    const out = extractTextFromHtml(varietyPage('Review paragraph 0 '.repeat(40)), 'https://variety.com/2007/legit/reviews/x/');
    assert.doesNotMatch(out, /Related Stories|Other Show/);
    assert.match(out, /^Review paragraph 0/);
    assert.match(out, /Review later paragraph 11/);
    const { extractTextFromHtml: wayback } = require('../../scripts/recover-wayback-reviews.js');
    assert.equal(wayback(varietyPage('Review paragraph 0 '.repeat(40)), 'https://variety.com/2007/legit/reviews/x/'), out);
  });
  it('leaves non-Variety pages to the generic path', () => {
    const out = extractTextFromHtml(varietyPage('Review paragraph 0 '.repeat(40)), 'https://example.com/x/');
    assert.match(out, /Review/);
  });
});

// BRO-5261 retro-review of BRO-5222: markup inside articleBody.
it('jsonLdBodyToText strips markup and keeps paragraphs; the teaser fallback then fires', () => {
  const { jsonLdBodyToText, chooseArticleBody } = require('../../scripts/lib/jsonld-body-choice.js');
  const raw = '<p>The Farnsworth Invention is Aaron Sorkin&#8217;s first Broadway play since A Few Good Men and it moves fast.</p><p>Second.</p>';
  const text = jsonLdBodyToText(raw);
  assert.equal(text, 'The Farnsworth Invention is Aaron Sorkin’s first Broadway play since A Few Good Men and it moves fast.\n\nSecond.');
  const page = `${text.split('\n\n')[0]} ${'More of the same review text. '.repeat(40)}`;
  assert.equal(chooseArticleBody(text, page).source, 'paragraphs');
  assert.equal(jsonLdBodyToText(undefined), '');
  // Prose with a literal or escaped '<' is not markup.
  assert.equal(jsonLdBodyToText('Ratings: 3 &lt; 4 stars, and the cast &gt; the book.'), 'Ratings: 3 < 4 stars, and the cast > the book.');
  assert.equal(jsonLdBodyToText('I <3 this show. Act two -> better.'), 'I <3 this show. Act two -> better.');
});

// BRO-5244: the acceptance command must exercise the Wayback caller too.
it('Wayback recovers at least 90% of the collector body through nested divs', () => {
  const { extractTextFromHtml: wayback } = require('../../scripts/recover-wayback-reviews.js');
  const nested = `<article><div class="article-body">${para(3, 'Opening')}<div>${para(3, 'Nested')}</div>${para(12, 'Ending')}</div></article>`;
  for (const url of ['https://example.com/review', 'https://variety.com/review']) {
    const html = ldPage('', nested);
    const collected = extractTextFromHtml(html, url);
    const recovered = wayback(html, url);
    assert.ok(collected.length > 3000);
    assert.ok(recovered.length >= collected.length * 0.9, `${url}: Wayback ${recovered.length}, collector ${collected.length}`);
    assert.match(recovered, /Ending paragraph 11/);
  }
});
