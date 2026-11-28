// BRO-7131: a teaser-only stored body (meta description / standfirst kept by a
// shell fetch) must not block a later full-text recovery of the same url.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isSameArticleBodyUpgrade, TEASER_MAX_WORDS } = require('./stale-merge-check.js');

// Synthetic text only: no review copy in public files.
const teaser = 'Four years after the first staging of this rarely performed opera the production returns with a new soprano in the notoriously difficult title role.';
const body = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} describes the singing, the staging, the orchestra and the conductor in some detail for the reader.`).join(' ');
const existing = { fullText: teaser, contentTier: 'truncated', url: 'https://example.com/review-x' };

test('teaser stored body is upgraded by a same-url full article', () => {
  assert.equal(isSameArticleBodyUpgrade(existing, body, { sameUrl: true }), true);
});

test('without the same-url proof the teaser is kept (old behaviour)', () => {
  assert.equal(isSameArticleBodyUpgrade(existing, body), false);
  assert.equal(isSameArticleBodyUpgrade(existing, body, { sameUrl: false }), false);
});

test('a stored body longer than a teaser still needs the lede/shingle proof', () => {
  const long = Array.from({ length: TEASER_MAX_WORDS + 10 }, (_, i) => `word${i}`).join(' ');
  assert.equal(isSameArticleBodyUpgrade({ ...existing, fullText: long }, body, { sameUrl: true }), false);
});

test('a good (complete) stored body is never replaced', () => {
  assert.equal(isSameArticleBodyUpgrade({ ...existing, contentTier: 'complete' }, body, { sameUrl: true }), false);
});

test('locked or split-parent bodies are untouched', () => {
  assert.equal(isSameArticleBodyUpgrade({ ...existing, _locked: true }, body, { sameUrl: true }), false);
  assert.equal(isSameArticleBodyUpgrade({ ...existing, multiShowSplitParent: true }, body, { sameUrl: true }), false);
});

test('an incoming body under four times the teaser\'s length does not count', () => {
  const small = Array.from({ length: 50 }, (_, i) => `unrelatedword${i}`).join(' ');
  assert.equal(isSameArticleBodyUpgrade(existing, small, { sameUrl: true }), false);
});
