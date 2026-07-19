// Unit tests for scripts/lib/reddit-grosses.js.
// Per feedback_test_extraction_pattern.md — require() the real lib.
// Also a parity guard: these exact cases were the inline isRelevantPost
// implementation in scrape-boring-waltz-costs.js before it was moved here
// (2026-07-19) — any behavior change here is a real regression.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { isRelevantPost } = require('../../scripts/lib/reddit-grosses');

describe('isRelevantPost', () => {
  it('matches a title containing "grosses"', () => {
    assert.equal(isRelevantPost({ title: 'Broadway Grosses Analysis: Week Ending 7/13/2026' }), true);
  });

  it('matches a title containing "post-mortem"', () => {
    assert.equal(isRelevantPost({ title: 'Hamilton Post-Mortem: 10 Years on Broadway' }), true);
  });

  it('matches a title containing "postmortem" (no hyphen)', () => {
    assert.equal(isRelevantPost({ title: 'Show Postmortem Thread' }), true);
  });

  it('is case-insensitive', () => {
    assert.equal(isRelevantPost({ title: 'WEEKLY GROSSES REPORT' }), true);
  });

  it('does not match an unrelated title', () => {
    assert.equal(isRelevantPost({ title: 'What did everyone see this weekend?' }), false);
  });

  it('handles a missing title gracefully', () => {
    assert.equal(isRelevantPost({}), false);
  });
});
