/** BRO-5789: extract-pull-quotes must not store a quote audit-pull-quotes flags. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { llmQuoteHardRejectReason } = require('../../scripts/lib/pull-quote-guards.js');

const body = 'A long opening paragraph. The play\'s tropes get stretched to the point of translucence, and it all lacks a little cohesion. This Dickens adaptation is undernourished and flatulent in the second half.';

test('bracket-led editorial text is an internal note', () => {
  assert.equal(llmQuoteHardRejectReason("[The play's] tropes get stretched to the point of translucence", body), 'internal-note');
});
test('a quote cut inside a word is rejected', () => {
  assert.equal(llmQuoteHardRejectReason('This Dickens adaptation is undernourished and flat', body), 'mid-word-truncation');
});
test('a clean complete sentence passes', () => {
  assert.equal(llmQuoteHardRejectReason("The play's tropes get stretched to the point of translucence, and it all lacks a little cohesion.", body), null);
});
test('missing fullText does not throw', () => {
  assert.equal(llmQuoteHardRejectReason('Some quote without a source text at all here, no end', ''), null);
});
test('the extractor calls the guard before storing', () => {
  const src = fs.readFileSync(new URL('../../scripts/extract-pull-quotes.js', import.meta.url), 'utf8');
  assert.ok(src.indexOf('llmQuoteHardRejectReason(quote') > 0 && src.indexOf('llmQuoteHardRejectReason(quote') < src.indexOf('current.llmPullQuote = quote'));
});
