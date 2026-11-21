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

// BRO-7090: theatreweekly.com bot-verification page, 12.7KB (over the 10KB size gate).
test('"One moment, please" verification page is a challenge page at any size', () => {
  const html = '<!DOCTYPE html><html><head><script>setTimeout(function(){window.location.reload();},5000)</script>'
    + '<title>One moment, please...</title><style>' + '.spinner{animation:spin 1s}'.repeat(600) + '</style></head>'
    + '<body><h1>Please wait while your request is being verified...</h1><script src="/z0f76a1d14fd21a8fb5fd0d03e0fdc3d3cedae52f?wsidchk=1"></script></body></html>';
  assert.ok(html.length > 10000);
  assert.equal(isChallengeOrGarbage(html), true);
});

test('exact "One moment, please..." title without a verification marker is not a challenge page', () => {
  const html = '<html><head><title>One moment, please...</title></head><body>' + 'Real review prose. '.repeat(800) + '</body></html>';
  assert.ok(html.length > 10000);
  assert.equal(isChallengeOrGarbage(html), false);
});

test('an article that only mentions "One moment, please" is not a challenge page', () => {
  const html = '<html><head><title>One moment, please: a review</title></head><body>' + 'Real review prose. '.repeat(800) + '</body></html>';
  assert.equal(isChallengeOrGarbage(html), false);
});

test('real article page is not a challenge page', () => {
  assert.equal(isChallengeOrGarbage('<html><title>Review</title>' + 'x'.repeat(20000) + '</html>'), false);
});

// BRO-5222: the body tollbit.hollywoodreporter.com returns (402) after the
// 307 an AI-crawler user agent gets. Must advance the chain, not be stored.
test('TollBit 402 bot paywall is a challenge page', () => {
  const body = '[{"message":"You are not authorized to access this content without a valid TollBit Token. Please follow this URL to find out more.","url":"https://tollbit.dev"}]';
  assert.equal(isChallengeOrGarbage(body), true);
});

test('an article that mentions TollBit is not a challenge page', () => {
  const html = '<html><title>Publishers and AI bots</title><body>' + 'Publishers such as Variety now route AI crawlers through TollBit, see tollbit.dev. '.repeat(80) + '</body></html>';
  assert.equal(isChallengeOrGarbage(html), false);
});
