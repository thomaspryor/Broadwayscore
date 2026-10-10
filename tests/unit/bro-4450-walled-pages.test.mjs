/**
 * BRO-4450 — NY Sun body lives only in JSON-LD articleBody (server HTML is a
 * "Loading article" skeleton); thetimes.com "Verifying Device" interstitial
 * arrives as a Scrapingdog 200 and must be treated as a challenge so the
 * fallback chain advances to Bright Data.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { extractArticleText } from '../../scripts/lib/article-extractor.js';

const require = createRequire(import.meta.url);
const { isChallengeOrGarbage } = require('../../scripts/lib/scraper.js');

const BODY = 'Towards the end of “Hungry Women,” a new play, one character threatens to kill a baby. '.repeat(6);

test('nysun: extracts JSON-LD articleBody when DOM is a loading skeleton', () => {
  const ld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'NewsArticle', headline: 'x', articleBody: BODY });
  const html = `<html><head><script type="application/ld+json">${ld}</script></head><body><main><div aria-busy="true" class="article-wrapper"><span class="sr-only">Loading article…</span></div></main></body></html>`;
  const text = extractArticleText(html, 'www.nysun.com');
  assert.ok(text && text.length >= 300);
  assert.match(text, /Hungry Women/);
});

test('thetimes interstitial is a challenge page', () => {
  const html = '<!DOCTYPE html><html><head><title>Verifying Device</title></head><body><script src="https://p.toadmash.net/1/x.js"></script></body></html>';
  assert.equal(isChallengeOrGarbage(html), true);
});

test('real article page is not a challenge page', () => {
  assert.equal(isChallengeOrGarbage('<html><title>Review</title>' + 'x'.repeat(20000) + '</html>'), false);
});
