// BRO-8097 class guard: a not_a_review verdict judged on a teaser body (<600 chars) is not evidence.
// Real shapes: red-2010/theatermania--david-finkle.json (159-char dtli teaser as fullText),
// the-waverly-gallery-2018/nypost--johnny-oleksinski.json (no body, aggregator-listed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldSuppressThinTextNotAReview: guard, THIN_BODY_CHARS } = require('./excerpt-wrongshow-guard.js');
const { isThinTextNotAReview, neutralizeThinTextNotAReview } = require('./stale-automated-text-verdict.js');

const TEASER = 'Red is a play that works on multiple levels, offering both an intimate character study and a broader meditation on art.';
const red = (over = {}) => ({
  url: 'https://www.theatermania.com/new-york-city-theater/reviews/red_27519.html',
  fullText: TEASER, contentTier: 'truncated', dtliExcerpt: TEASER,
  rejectionReason: 'not_a_review', rejectedBy: 'ensemble-scoreability-check', rejectedAt: '2026-02-16T22:58:45.304Z',
  rejectionReasoning: 'claude: single descriptive sentence', assignedScore: 72, scoreSource: 'llm-ensemble', ...over,
});

test('writer guard: thin body + aggregator-listed or /reviews/ url -> verdict suppressed', () => {
  assert.equal(guard({ rejection: 'not_a_review', fileData: red() }).suppress, true);
  assert.equal(guard({ rejection: 'not_a_review', fileData: red({ dtliExcerpt: null, url: 'https://x.com/reviews/red' }) }).suppress, true);
  assert.equal(guard({ rejection: 'not_a_review', fileData: red({ fullText: '' }) }).suppress, true);
});

test('writer guard: real body, no evidence, or other rejection -> verdict stands', () => {
  assert.equal(guard({ rejection: 'not_a_review', fileData: red({ fullText: 'x'.repeat(THIN_BODY_CHARS) }) }).suppress, false);
  assert.equal(guard({ rejection: 'not_a_review', fileData: red({ dtliExcerpt: null, url: 'https://x.com/news/cast-announced' }) }).suppress, false);
  assert.equal(guard({ rejection: 'garbage_text', fileData: red() }).suppress, false);
  assert.equal(guard({ rejection: 'wrong_show', fileData: red() }).suppress, false);
});

test('sweep predicate: matches the Red shape, once', () => {
  assert.equal(isThinTextNotAReview(red()), true);
  const d = red();
  assert.equal(neutralizeThinTextNotAReview(d, '2026-11-22T00:00:00Z'), true);
  assert.equal(d.rejectionReason, null);
  assert.equal(d.assignedScore, null);
  assert.equal(d.priorAutomatedTextVerdicts[0].clearedBy, 'thin-text-not-a-review');
  // re-rejected later: must not loop
  d.rejectionReason = 'not_a_review'; d.rejectedBy = 'ensemble-scoreability-check';
  assert.equal(isThinTextNotAReview(d), false);
});

test('sweep predicate: leaves human verdicts, real bodies, other rejecters, dupes alone', () => {
  assert.equal(isThinTextNotAReview(red({ fullText: 'x'.repeat(900) })), false);
  assert.equal(isThinTextNotAReview(red({ rejectedBy: 'manual-triage-bro-71' })), false);
  assert.equal(isThinTextNotAReview(red({ isNonReview: true })), false);
  assert.equal(isThinTextNotAReview(red({ humanReviewScore: 70 })), false);
  assert.equal(isThinTextNotAReview(red({ duplicateOf: 'a.json' })), false);
  assert.equal(isThinTextNotAReview(red({ rejectionReason: 'wrong_show' })), false);
});
