// BRO-6518: hosts whose author markup is a site-wide account yield no byline, not a wrong one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractAuthorFromHtml } = require('./content-quality.js');

const html = '<html><head><meta name="author" content="Jacob Davis"></head><body><p class="byline">By Jacob Davis</p></body></html>';

test('Around the Town Chicago and PicksInSix give no page byline', () => {
  assert.equal(extractAuthorFromHtml(html, '', { url: 'https://aroundthetownchicago.com/theatre-reviews/1776/' }), null);
  assert.equal(extractAuthorFromHtml(html, '', { url: 'https://www.picksinsix.com/review-x/' }), null);
  assert.equal(extractAuthorFromHtml(html, '', { url: 'https://www.conversationswithedtracy.com/a-review' }), null);
});

test('other hosts, including look-alike domains, still read the page byline', () => {
  assert.equal(extractAuthorFromHtml(html, '', { url: 'https://chicagoreader.com/x/' }), 'Jacob Davis');
  assert.equal(extractAuthorFromHtml(html, '', { url: 'https://notpicksinsix.com.example.org/x' }), 'Jacob Davis');
});

test('matched on hostname or outlet id, never on a query string', () => {
  assert.equal(extractAuthorFromHtml(html, '', { url: 'https://chicagoreader.com/x/?ref=aroundthetownchicago.com' }), 'Jacob Davis');
  assert.equal(extractAuthorFromHtml(html, '', { outletId: 'around-the-town-chicago' }), null);
});
