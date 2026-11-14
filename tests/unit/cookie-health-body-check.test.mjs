// BRO-6872: check-cookie-health printed "wsj: OK via plain-HTTPS (638543 chars)" for a page whose article body was a
// 597-char paywall teaser. withBodyCheck turns a size-only pass into a fail when the extracted body is short.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { withBodyCheck, CRITICAL_OUTLETS } = require('../../scripts/check-cookie-health.js');

const URL_ = CRITICAL_OUTLETS.wsj.testUrl;
// WSJ serves the article in __NEXT_DATA__ (article-extractor extractWsjNextData). Invented filler, no article text.
const page = (paras) => `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { articleData: { flattenedBody: paras.map((t) => ({ type: 'paragraph', content: [{ text: t }] })) } } } })}</script></body></html>`;
const PASS = { status: 'pass', message: 'OK via plain-HTTPS (638543 chars)' };

test('wsj has a body threshold', () => assert.ok(CRITICAL_OUTLETS.wsj.minBodyChars >= 1000));

test('a teaser body fails even though the page was big', () => {
  const r = withBodyCheck(PASS, page(['Filler sentence number one for the teaser. '.repeat(8)]), URL_, 1500);
  assert.equal(r.status, 'fail');
  assert.match(r.message, /paywall teaser, subscriber cookies not authenticating/);
});

test('a subscriber body passes and reports its length', () => {
  const r = withBodyCheck(PASS, page(Array.from({ length: 12 }, (_, i) => `Paragraph ${i} of invented filler text for the subscriber body check. `.repeat(3))), URL_, 1500);
  assert.equal(r.status, 'pass');
  assert.match(r.message, /article body \d+ chars/);
});

test('no threshold, or an earlier failure, is left alone', () => {
  assert.deepEqual(withBodyCheck(PASS, '<html></html>', URL_, undefined), PASS);
  const blocked = { status: 'fail', message: 'Blocked via plain-HTTPS' };
  assert.deepEqual(withBodyCheck(blocked, '<html></html>', URL_, 1500), blocked);
});
