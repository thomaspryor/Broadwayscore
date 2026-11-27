/**
 * Unit tests for scripts/lib/paywall-detector.js.
 * Per CLAUDE.md §15: require() the real function — never duplicate its logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { detectHardPaywall } = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'paywall-detector.js'));

test('clean review body: not detected', () => {
  const text = 'Steven Spielberg directs a bold revival of West Side Story. The cast is uniformly exceptional...';
  assert.equal(detectHardPaywall(text).detected, false);
});

test('"Subscribe to continue" at start: detected', () => {
  const r = detectHardPaywall('Subscribe to continue reading this article.');
  assert.equal(r.detected, true);
  assert.equal(r.reason, 'paywall-start-marker');
});

test('"Sign in to read" at start: detected', () => {
  const r = detectHardPaywall('Sign in to read the full review.');
  assert.equal(r.detected, true);
});

test('"Already a subscriber?" at start (case-insensitive): detected', () => {
  const r = detectHardPaywall('already a subscriber? Sign In.');
  assert.equal(r.detected, true);
});

test('paywall phrase in middle of text: NOT detected', () => {
  const body = 'This was a rave reviewed play. I subscribed to the show. The Washington Post said it was great.';
  assert.equal(detectHardPaywall(body).detected, false);
});

test('outlet-specific WSJ marker in first 600 chars: detected', () => {
  const text = 'A gripping production of Glengarry Glen Ross... Already a subscriber? Sign In to read.';
  const r = detectHardPaywall(text, 'https://www.wsj.com/articles/test');
  assert.equal(r.detected, true);
  assert.match(r.reason, /paywall-outlet-marker:wsj\.com/);
});

test('outlet marker beyond 600 chars: NOT detected', () => {
  const filler = 'Body text. '.repeat(100); // ~1000 chars
  const text = filler + 'Already a subscriber? Sign In';
  const r = detectHardPaywall(text, 'wsj.com');
  assert.equal(r.detected, false);
});

test('extracts domain from full URL', () => {
  const r = detectHardPaywall('Subscribe to continue reading', 'https://www.wsj.com/articles/foo');
  assert.equal(r.detected, true);
});

test('accepts bare domain', () => {
  const r = detectHardPaywall('Create your free account', 'nytimes.com');
  assert.equal(r.detected, true);
});

test('empty / null text: not detected', () => {
  assert.equal(detectHardPaywall('').detected, false);
  assert.equal(detectHardPaywall(null).detected, false);
  assert.equal(detectHardPaywall(undefined).detected, false);
});

test('mid-paragraph "to read the full article" at start: detected', () => {
  const r = detectHardPaywall('To read the full article, please subscribe.');
  assert.equal(r.detected, true);
});

test('real WSJ short-but-legitimate review excerpt: NOT detected', () => {
  // Representative of the 300+ "truncated" WSJ files that are actually fine.
  const text = 'ShareResizeKaren Ziemba, Emily Skinner, Chuck Cooper, and Tony Yazbeck in a scene from "Follies" in "Prince of Broadway" Matthew MurphyNew York Anyone with a more than casual interest in theater needs no introduction to Harold Prince.';
  assert.equal(detectHardPaywall(text, 'wsj.com').detected, false);
});

// RULE21 / BRO-8264: a paid teaser survives furniture removal, but must never
// become ensemble input just because the generic paywall tests still pass.
const paywall = require('../../scripts/lib/paywall-detector');
const { selectScorableText } = require('../../scripts/lib/scorable-text');
const teaser = 'The production offers a striking opening scene and an assured central performance. '.repeat(12);
const paidHtml = `<article><p>${teaser}</p><div class="wp-block-jetpack-subscriber-view"><p>Pages on Stages Exclusive!</p><p>Log in or pay to keep reading.</p></div></article>`;
const pagesUrl = 'https://pagesonstages.com/review/';

test('Pages on Stages paid prompt after a lede beyond 600 characters', () => {
  assert.equal(detectHardPaywall(teaser + 'Log in or pay to keep reading.', pagesUrl).detected, true);
});

test('raw Jetpack wall is detected before furniture strips the prompt', () => {
  assert.equal(paywall.detectSubscriberPaywall(paidHtml, pagesUrl).detected, true);
  assert.equal(paywall.detectSubscriberPaywall(paidHtml.replace('Log in or pay to keep reading.', 'Log in or <a>pay</a> to keep reading.'), pagesUrl).detected, true);
});

test('ordinary WordPress subscription footer and subscriber content are not walls', () => {
  for (const html of [
    `<article>${teaser}<div class="wp-block-jetpack-subscriptions">Subscribe now to keep reading and get access to the full archive.</div></article>`,
    `<article><div class="wp-block-jetpack-subscriber-view">${teaser}</div></article>`,
    `<style>.wp-block-jetpack-subscriber-view { display: block; }</style><article>${teaser}</article>`,
  ]) assert.equal(paywall.detectSubscriberPaywall(html, pagesUrl).detected, false);
  assert.equal(detectHardPaywall(teaser + 'Log in or pay to keep reading.', 'example.com').detected, false);
});

test('stored paid teaser is stamped, skipped on refetch, and released when the body recovers', () => {
  const data = { fullText: teaser, url: pagesUrl };
  assert.equal(paywall.stampSubscriberPaywall(data, paidHtml, pagesUrl, teaser), true);
  assert.equal(data.paywalled, true);
  assert.equal(selectScorableText(data), null);
  assert.equal(paywall.stampSubscriberPaywall(data, paidHtml, pagesUrl, teaser), false, 'same evidence is idempotent');
  assert.equal(selectScorableText(data), null);
  assert.equal(paywall.isPaywalledText({ ...data, fullText: teaser + 'The complete review now follows.' }), false);
});

test('a paywalled fetch cannot stamp a retained full body or another URL', () => {
  assert.equal(paywall.stampSubscriberPaywall({ fullText: teaser.repeat(4), url: pagesUrl }, paidHtml, pagesUrl, teaser), false);
  assert.equal(paywall.stampSubscriberPaywall({ fullText: teaser, url: 'https://pagesonstages.com/another/' }, paidHtml, pagesUrl, teaser), false);
});


test('legacy surviving paid prompt is not scored even before a refetch stamps it', () => {
  assert.equal(selectScorableText({ url: pagesUrl, fullText: teaser + 'Log in or pay to keep reading.' }), null);
});

test('furniture cleanup does not release a stamped teaser', () => {
  const { cleanText } = require('../../scripts/lib/text-cleaning');
  const text = teaser + '\n\nSubscribe now to keep reading and get access to the full archive.';
  const data = { url: pagesUrl, fullText: text };
  paywall.stampSubscriberPaywall(data, paidHtml, pagesUrl, text);
  data.fullText = cleanText(text);
  assert.equal(paywall.isPaywalledText(data), true);
});
