// A displayed pull quote must not open mid-sentence. 2026-11-16: Slant on The
// Fantasticks shipped ", director Christopher Gattelli spread large-scale
// charm..." because the sentence splitter broke at the "!" in the title
// "Schmigadoon!" and the fragment guard only caught a lowercase first letter.
// The selectBestExcerpt end-to-end case lives in pull-quote-contiguity.test.mjs
// (it needs data/shows.json, so it runs in the live-data lane).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startsAsFragment } = require('./pull-quote-guards.js');

describe('startsAsFragment', () => {
  it('flags a leading comma, semicolon or colon', () => {
    assert.equal(startsAsFragment(', director Christopher Gattelli spread large-scale charm.'), true);
    assert.equal(startsAsFragment('; the cast never settles.'), true);
    assert.equal(startsAsFragment(': a triumph.'), true);
    assert.equal(startsAsFragment('" , where characters are talked about.'), true);
  });
  it('still flags a lowercase start, and passes a real sentence', () => {
    assert.equal(startsAsFragment('disappointing: poorly directed.'), true);
    assert.equal(startsAsFragment('“A joyous staging.”'), false);
    assert.equal(startsAsFragment('...a worthwhile and breezy diversion.'), false);
    assert.equal(startsAsFragment('It is a delight to see him working on a smaller canvas.'), false);
  });
});

describe('llmQuoteHardRejectReason', () => {
  const { llmQuoteHardRejectReason } = require('./pull-quote-guards.js');
  it('hard-rejects a punctuation-led LLM quote so the extractor re-extracts it', () => {
    assert.equal(llmQuoteHardRejectReason(', director Christopher Gattelli spread large-scale charm.', ''), 'punctuation-start-fragment');
    assert.equal(llmQuoteHardRejectReason('It is a delight to see him working on a smaller canvas.', ''), null);
  });
});
