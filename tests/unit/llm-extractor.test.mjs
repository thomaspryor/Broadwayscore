/**
 * llmFallbackExtractIfNeeded — the centralized zero/partial trigger (BRO-67).
 *
 * Before this fix, only gather-reviews.js's DTLI/BWW blocks fired the LLM
 * fallback on a partial regex miss (locked by tests/unit/llm-fallback-partial.test.mjs).
 * Two other call sites were still zero-only or had no fallback at all:
 *   - scripts/opening-night-poller.js (zero-only for both DTLI and BWW)
 *   - scripts/lib/opening-night-checks/{bww,dtli}-count-mismatch.check.js
 *     (no LLM fallback at all — the parity-audit checks used the SAME regex
 *     extractor they exist to sanity-check, so a partial format-change miss
 *     under-reported both `rrCount`/`dtliCount` AND the gap, hiding itself).
 *
 * llmFallbackExtractIfNeeded() centralizes the hasStructuralMarkers /
 * isPartialExtraction / mergeAggregatorReviews decision so every caller gets
 * the same resilience. These tests exercise the real function from
 * scripts/lib/llm-extractor.js per the CLAUDE.md §15 "require the real
 * function" rule, with ANTHROPIC_API_KEY unset so the network path is never
 * hit (callClaudeWithRetry degrades gracefully to null/[] without a key —
 * exactly the CI environment this test runs in).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');

const {
  llmFallbackExtractIfNeeded,
  llmFallbackExtract,
} = require(join(ROOT, 'scripts/lib/llm-extractor.js'));

const savedKey = process.env.ANTHROPIC_API_KEY;
test.before(() => { delete process.env.ANTHROPIC_API_KEY; });
test.after(() => { if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey; });

// BWW structural markers: needs 2+ of ['BlogPosting', 'roundup', 'broadwayworld.com', 'review-roundup']
const BWW_MARKERS_HTML = '<div class="review-roundup">via broadwayworld.com — roundup of reviews</div>';
// 8 thumb images (uptrans.png) so countExpectedReviews(html, 'bww') === 8
const BWW_8_THUMBS = BWW_MARKERS_HTML + Array.from({ length: 8 }, () => '<img src="uptrans.png">').join('');
const BWW_2_THUMBS = BWW_MARKERS_HTML + '<img src="uptrans.png"><img src="uptrans.png">';
const NO_MARKERS_HTML = '<html><body><p>nothing relevant here</p></body></html>';

describe('llmFallbackExtractIfNeeded: decision logic', () => {
  test('no structural markers → returns baseline unchanged, no LLM attempt', async () => {
    const baseline = [];
    const result = await llmFallbackExtractIfNeeded(NO_MARKERS_HTML, baseline, {
      aggregator: 'bww', showTitle: 'Some Show', showId: 'some-show',
    });
    assert.strictEqual(result, baseline, 'should be the exact same array reference — no work done');
  });

  test('full extraction (extracted >= expected) → returns baseline unchanged', async () => {
    // 8 thumbs on the page, regex already found 8 — nothing partial about this.
    const baseline = Array.from({ length: 8 }, (_, i) => ({ outletId: `outlet-${i}`, criticName: `Critic ${i}`, url: `https://x.com/${i}` }));
    const result = await llmFallbackExtractIfNeeded(BWW_8_THUMBS, baseline, {
      aggregator: 'bww', showTitle: 'Some Show', showId: 'some-show',
    });
    assert.strictEqual(result, baseline);
  });

  test('zero extraction with structural markers → attempts LLM fallback (gracefully empty without an API key)', async () => {
    const result = await llmFallbackExtractIfNeeded(BWW_MARKERS_HTML, [], {
      aggregator: 'bww', showTitle: 'Some Show', showId: 'some-show',
    });
    // No ANTHROPIC_API_KEY in this test env → llmFallbackExtract degrades to [].
    assert.deepStrictEqual(result, []);
  });

  test('partial extraction (regex got 2 of 8) → attempts LLM fallback and merges (baseline preserved without a key)', async () => {
    const baseline = [
      { outletId: 'nytimes', criticName: 'Jesse Green', url: 'https://nytimes.com/a' },
      { outletId: 'variety', criticName: 'Naveen Kumar', url: 'https://variety.com/b' },
    ];
    const result = await llmFallbackExtractIfNeeded(BWW_2_THUMBS, baseline, {
      aggregator: 'bww', showTitle: 'Some Show', showId: 'some-show',
    });
    // No key → LLM returns [] → mergeAggregatorReviews([]) returns the baseline
    // untouched (not the same reference — mergeAggregatorReviews copies — but
    // equal in content and still length 2, i.e. nothing was silently dropped).
    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(result, baseline);
  });

  test('small gap (7 of 8, below minGap=3) → does not trigger, returns baseline unchanged', async () => {
    const sevenThumbsHtml = BWW_MARKERS_HTML + Array.from({ length: 8 }, () => '<img src="uptrans.png">').join('');
    const baseline = Array.from({ length: 7 }, (_, i) => ({ outletId: `outlet-${i}`, criticName: `Critic ${i}`, url: `https://x.com/${i}` }));
    const result = await llmFallbackExtractIfNeeded(sevenThumbsHtml, baseline, {
      aggregator: 'bww', showTitle: 'Some Show', showId: 'some-show',
    });
    assert.strictEqual(result, baseline);
  });

  test('DTLI aggregator: partial trigger works the same way', async () => {
    // DTLI markers: needs 2+ of ['review-item', 'BigThumbs', 'review-item-attribution', 'didtheylikeit']
    const html = '<div class="review-item">BigThumbs on didtheylikeit</div>' +
      '<img src="https://didtheylikeit.com/thumbs-up/thumb-8.png">';
    const baseline = [{ outletId: 'nytimes', criticName: 'Jesse Green', url: 'https://nytimes.com/a' }];
    const result = await llmFallbackExtractIfNeeded(html, baseline, {
      aggregator: 'dtli', showTitle: 'Some Show', showId: 'some-show',
    });
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result, baseline);
  });
});

describe('llmFallbackExtract: graceful degradation without an API key', () => {
  test('returns empty array instead of throwing when ANTHROPIC_API_KEY is unset', async () => {
    const result = await llmFallbackExtract(BWW_MARKERS_HTML, {
      aggregator: 'bww', showTitle: 'Some Show', showId: 'some-show',
    });
    assert.deepStrictEqual(result, []);
  });
});

describe('wiring locks: partial-extraction fallback must stay wired at every call site', () => {
  test('opening-night-poller.js wires llmFallbackExtractIfNeeded for DTLI and BWW', () => {
    const src = readFileSync(join(ROOT, 'scripts/opening-night-poller.js'), 'utf8');
    assert.ok(
      /llmFallbackExtractIfNeeded\s*\(\s*dtli\.html/.test(src),
      'opening-night-poller.js no longer routes DTLI extraction through llmFallbackExtractIfNeeded — partial fallback disabled'
    );
    assert.ok(
      /llmFallbackExtractIfNeeded\s*\(\s*bww\.html/.test(src),
      'opening-night-poller.js no longer routes BWW extraction through llmFallbackExtractIfNeeded — partial fallback disabled'
    );
    assert.ok(
      !/\bhasStructuralMarkers\b/.test(src),
      'opening-night-poller.js should delegate structural-marker gating to llmFallbackExtractIfNeeded, not reimplement it inline'
    );
  });

  test('bww-rr-count-mismatch.check.js wires llmFallbackExtractIfNeeded so the parity check is not blind to its own extractor\'s partial misses', () => {
    const src = readFileSync(join(ROOT, 'scripts/lib/opening-night-checks/bww-rr-count-mismatch.check.js'), 'utf8');
    assert.ok(
      /llmFallbackExtractIfNeeded\s*\(\s*html\s*,\s*extracted/.test(src),
      'bww-rr-count-mismatch.check.js no longer runs extracted reviews through llmFallbackExtractIfNeeded'
    );
    assert.ok(
      /aggregator:\s*'bww'/.test(src),
      'bww-rr-count-mismatch.check.js fallback call is missing the bww aggregator option'
    );
  });

  test('dtli-count-mismatch.check.js wires llmFallbackExtractIfNeeded so the parity check is not blind to its own extractor\'s partial misses', () => {
    const src = readFileSync(join(ROOT, 'scripts/lib/opening-night-checks/dtli-count-mismatch.check.js'), 'utf8');
    assert.ok(
      /llmFallbackExtractIfNeeded\s*\(\s*html\s*,\s*extracted/.test(src),
      'dtli-count-mismatch.check.js no longer runs extracted reviews through llmFallbackExtractIfNeeded'
    );
    assert.ok(
      /aggregator:\s*'dtli'/.test(src),
      'dtli-count-mismatch.check.js fallback call is missing the dtli aggregator option'
    );
  });
});
