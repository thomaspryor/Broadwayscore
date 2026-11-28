import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { applyReviewFieldEdit } = require('../../scripts/lib/review-field-edit.js');
const { MIN_QUOTE_LENGTH } = require('../../scripts/lib/pull-quote-guards.js');

// BRO-7478: a 24-char llmPullQuote applied green but the rebuild only uses one
// longer than MIN_QUOTE_LENGTH, so the site kept showing no quote.
const fullText = 'A raucous romp. Like its small-screen inspiration, the entire experience is all very fun and never remotely mean. It is a killer good time.';
const record = { fullText, llmPullQuote: null };
const edit = (q) => applyReviewFieldEdit(record, { field: 'llmPullQuote', oldValue: null, newValue: q }, 'test');

test('a quote the rebuild would drop (<= MIN_QUOTE_LENGTH) is refused', () => {
  const r = edit('It is a killer good time.');
  assert.equal(r.ok, false);
  assert.match(r.reason, /longer than 30/);
});

test('the rebuild threshold and the validator agree', () => {
  assert.equal(MIN_QUOTE_LENGTH, 30);
  const src = require('node:fs').readFileSync(new URL('../../scripts/rebuild-all-reviews.js', import.meta.url), 'utf8');
  assert.match(src, /data\.llmPullQuote\.length > 30/);
});

test('a verbatim quote over the threshold is accepted', () => {
  const r = edit('Like its small-screen inspiration, the entire experience is all very fun and never remotely mean.');
  assert.equal(r.ok, true, r.reason);
});
