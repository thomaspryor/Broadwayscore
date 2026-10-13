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
