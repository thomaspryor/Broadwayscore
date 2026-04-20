/**
 * Unit tests for clearFailureFlags from scripts/lib/clear-failure-flags.js.
 *
 * Pattern Card #1 (Notion 346637c5-416f-8154-9500-f09fd49e5a2a):
 * Verifies that stale failure-state flags are cleared on success, preventing
 * valid reviews from being silently excluded from reviews.json.
 *
 * Logic is require()'d from the lib — never copied (CLAUDE.md §15).
 *
 * Run: node --test tests/unit/clear-failure-flags.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { clearFailureFlags } = require('../../scripts/lib/clear-failure-flags');

const LONG_TEXT = 'A'.repeat(600);

describe('clearFailureFlags — incompleteReason=wrong_content', () => {
  it('clears wrong_content when wrongShow + wrongProduction are gone and text is complete', () => {
    const data = { fullText: LONG_TEXT, incompleteReason: 'wrong_content', wrongShow: false };
    const cleared = clearFailureFlags(data);
    assert.strictEqual(data.incompleteReason, null);
    assert.ok(cleared.includes('incompleteReason'));
  });

  it('does NOT clear wrong_content when wrongShow is still true', () => {
    const data = { fullText: LONG_TEXT, incompleteReason: 'wrong_content', wrongShow: true };
    clearFailureFlags(data);
    assert.strictEqual(data.incompleteReason, 'wrong_content');
  });

  it('does NOT clear wrong_content when wrongProduction is still true', () => {
    const data = { fullText: LONG_TEXT, incompleteReason: 'wrong_content', wrongProduction: true };
    clearFailureFlags(data);
    assert.strictEqual(data.incompleteReason, 'wrong_content');
  });

  it('clears wrong_content when contentTier=complete (even without text)', () => {
    const data = { contentTier: 'complete', incompleteReason: 'wrong_content' };
    const cleared = clearFailureFlags(data);
    assert.strictEqual(data.incompleteReason, null);
    assert.ok(cleared.includes('incompleteReason'));
  });

  it('also clears incompleteDetail when incompleteReason is cleared', () => {
    const data = { fullText: LONG_TEXT, incompleteReason: 'wrong_content', incompleteDetail: 'detail text' };
    clearFailureFlags(data);
    assert.strictEqual(data.incompleteDetail, null);
  });
});

describe('clearFailureFlags — incompleteReason=no_url', () => {
  it('clears no_url when URL is now present', () => {
    const data = { url: 'https://example.com/review', incompleteReason: 'no_url', fullText: LONG_TEXT };
    const cleared = clearFailureFlags(data);
    assert.strictEqual(data.incompleteReason, null);
    assert.ok(cleared.includes('incompleteReason'));
  });

  it('does NOT clear no_url when URL is still absent', () => {
    const data = { incompleteReason: 'no_url', fullText: LONG_TEXT };
    clearFailureFlags(data);
    assert.strictEqual(data.incompleteReason, 'no_url');
  });
});

describe('clearFailureFlags — other incompleteReasons', () => {
  it('clears paywall when contentTier=complete', () => {
    const data = { contentTier: 'complete', incompleteReason: 'paywall' };
    const cleared = clearFailureFlags(data);
    assert.strictEqual(data.incompleteReason, null);
    assert.ok(cleared.includes('incompleteReason'));
  });

  it('clears paywall when text is long AND aggregator signal present', () => {
    const data = { fullText: LONG_TEXT, incompleteReason: 'paywall', llmScore: { score: 75 } };
    const cleared = clearFailureFlags(data);
    assert.strictEqual(data.incompleteReason, null);
    assert.ok(cleared.includes('incompleteReason'));
  });

  it('does NOT clear paywall with long text alone (no aggregator signal)', () => {
    const data = { fullText: LONG_TEXT, incompleteReason: 'paywall' };
    clearFailureFlags(data);
    assert.strictEqual(data.incompleteReason, 'paywall');
  });
});

describe('clearFailureFlags — rejectionReason', () => {
  it('clears garbage_text rejection when text is long enough (re-scrape fixed it)', () => {
    const data = { fullText: LONG_TEXT, rejectionReason: 'garbage_text' };
    const cleared = clearFailureFlags(data);
    assert.strictEqual(data.rejectionReason, null);
    assert.ok(cleared.includes('rejectionReason'));
  });

  it('does NOT clear rejectionReason when text is too short', () => {
    const data = { fullText: 'Short text.', rejectionReason: 'garbage_text' };
    clearFailureFlags(data);
    assert.strictEqual(data.rejectionReason, 'garbage_text');
  });

  it('does NOT clear wrong_production (semantic rejection) regardless of text length', () => {
    // Regression: a film review of Hamlet (Vulture 2026-04-20) had its 'wrong_production'
    // rejection cleared by text-length heuristic, leaking into reviews.json. Semantic
    // rejections describe content mismatches that more text cannot resolve.
    const data = { fullText: LONG_TEXT, rejectionReason: 'wrong_production', rejectedBy: ['ensemble'] };
    clearFailureFlags(data);
    assert.strictEqual(data.rejectionReason, 'wrong_production');
    assert.deepStrictEqual(data.rejectedBy, ['ensemble']);
  });

  it('does NOT clear wrong_show (semantic rejection)', () => {
    const data = { fullText: LONG_TEXT, rejectionReason: 'wrong_show' };
    clearFailureFlags(data);
    assert.strictEqual(data.rejectionReason, 'wrong_show');
  });

  it('does NOT clear not_a_review (semantic rejection)', () => {
    const data = { fullText: LONG_TEXT, rejectionReason: 'not_a_review' };
    clearFailureFlags(data);
    assert.strictEqual(data.rejectionReason, 'not_a_review');
  });
});

describe('clearFailureFlags — SERP retry state', () => {
  it('clears serpRetryCount when URL is present', () => {
    const data = { url: 'https://example.com/review', serpRetryCount: 3 };
    const cleared = clearFailureFlags(data);
    assert.strictEqual(data.serpRetryCount, null);
    assert.ok(cleared.includes('serpRetryCount'));
  });

  it('does NOT clear serpRetryCount without URL', () => {
    const data = { serpRetryCount: 3 };
    clearFailureFlags(data);
    assert.strictEqual(data.serpRetryCount, 3);
  });

  it('clears serpDiscoveryAbandoned when URL + fullText present', () => {
    const data = { url: 'https://example.com/review', fullText: LONG_TEXT, serpDiscoveryAbandoned: true };
    const cleared = clearFailureFlags(data);
    assert.strictEqual(data.serpDiscoveryAbandoned, null);
    assert.ok(cleared.includes('serpDiscoveryAbandoned'));
  });

  it('does NOT clear serpDiscoveryAbandoned with URL but no fullText', () => {
    const data = { url: 'https://example.com/review', serpDiscoveryAbandoned: true };
    clearFailureFlags(data);
    assert.strictEqual(data.serpDiscoveryAbandoned, true);
  });
});

describe('clearFailureFlags — no flags to clear', () => {
  it('returns empty array when no flags are set', () => {
    const data = { fullText: LONG_TEXT, llmScore: { score: 80 } };
    const cleared = clearFailureFlags(data);
    assert.deepStrictEqual(cleared, []);
  });

  it('handles null input gracefully', () => {
    const cleared = clearFailureFlags(null);
    assert.deepStrictEqual(cleared, []);
  });

  it('does not modify data that has no failure flags', () => {
    const data = { fullText: LONG_TEXT, outletId: 'nytimes', criticName: 'Helen Shaw' };
    clearFailureFlags(data);
    assert.strictEqual(data.outletId, 'nytimes');
    assert.strictEqual(data.criticName, 'Helen Shaw');
  });
});

describe('clearFailureFlags — never clears wrongShow / wrongProduction', () => {
  it('does not touch wrongShow even when text is good', () => {
    const data = { fullText: LONG_TEXT, wrongShow: true, llmScore: { score: 80 } };
    clearFailureFlags(data);
    assert.strictEqual(data.wrongShow, true);
  });

  it('does not touch wrongProduction even when text is good', () => {
    const data = { fullText: LONG_TEXT, wrongProduction: true, llmScore: { score: 80 } };
    clearFailureFlags(data);
    assert.strictEqual(data.wrongProduction, true);
  });
});
