import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chooseArticleBody, SHORT_JSONLD_MAX } = require('../../scripts/lib/jsonld-body-choice.js');
const { extractTextFromHtml } = require('../../scripts/collect-review-texts.js');

const para = (n, word) => Array.from({ length: n }, (_, i) => `<p>${word} paragraph ${i} ${'lorem ipsum dolor sit amet '.repeat(8)}</p>`).join('\n');
const ldPage = (body, paragraphs) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', articleBody: body })}</script></head><body><article>${paragraphs}</article></body></html>`;

describe('chooseArticleBody (BRO-5222)', () => {
  it('prefers paragraphs when the JSON-LD body is a short teaser', () => {
    const r = chooseArticleBody('t'.repeat(620), 'p'.repeat(7000));
    assert.equal(r.source, 'paragraphs');
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
    const teaser = 'Teaser sentence. '.repeat(36);
    const out = extractTextFromHtml(ldPage(teaser, para(20, 'Full')), 'https://variety.com/x/');
    assert.ok(out.length > teaser.length * 2, `got ${out.length}`);
    assert.match(out, /^Full paragraph 0/);
  });
  it('still returns a full JSON-LD body', () => {
    const body = 'Complete body sentence. '.repeat(120);
    const out = extractTextFromHtml(ldPage(body, para(3, 'Side')), 'https://variety.com/x/');
    assert.equal(out, body.trim());
  });
});
