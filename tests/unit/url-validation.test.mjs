/**
 * Unit tests for roundup URL content validation guard
 *
 * Tests shouldValidateUrl() — the decision function that determines
 * which review URLs need content-checking via fetchPage + validatePageMatchesShow.
 *
 * Pattern: require() the real function, never copy logic into tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { shouldValidateUrl, ROUNDUP_URL_SOURCES } = require('../../scripts/gather-reviews.js');

describe('ROUNDUP_URL_SOURCES', () => {
  test('includes all expected aggregator sources', () => {
    const expected = [
      'show-score', 'show-score-playwright', 'dtli',
      'bww-roundup', 'lbo-roundup',
      'westendtheatre', 'theatre-reviews', 'stagedoor', 'thestage-roundup',
    ];
    for (const source of expected) {
      assert.ok(ROUNDUP_URL_SOURCES.has(source), `missing: ${source}`);
    }
    assert.strictEqual(ROUNDUP_URL_SOURCES.size, expected.length, 'unexpected extra sources');
  });

  test('does NOT include SERP or manual sources', () => {
    assert.ok(!ROUNDUP_URL_SOURCES.has('serp-discovery'));
    assert.ok(!ROUNDUP_URL_SOURCES.has('gather-reviews'));
    assert.ok(!ROUNDUP_URL_SOURCES.has('wrongUrl-retry'));
    assert.ok(!ROUNDUP_URL_SOURCES.has('manual'));
  });
});

describe('shouldValidateUrl', () => {
  // --- Roundup sources: SHOULD validate ---

  test('show-score review with URL -> true', () => {
    assert.strictEqual(shouldValidateUrl({
      url: 'https://variety.com/review/some-show',
      source: 'show-score',
    }), true);
  });

  test('show-score-playwright review with URL -> true', () => {
    assert.strictEqual(shouldValidateUrl({
      url: 'https://nytimes.com/review/show',
      source: 'show-score-playwright',
    }), true);
  });

  test('dtli review with URL -> true', () => {
    assert.strictEqual(shouldValidateUrl({
      url: 'https://timeout.com/review',
      source: 'dtli',
    }), true);
  });

  test('bww-roundup review with URL -> true', () => {
    assert.strictEqual(shouldValidateUrl({
      url: 'https://broadwayworld.com/article/review',
      source: 'bww-roundup',
    }), true);
  });

  test('lbo-roundup review with URL -> true', () => {
    assert.strictEqual(shouldValidateUrl({
      url: 'https://londonboxoffice.co.uk/review',
      source: 'lbo-roundup',
    }), true);
  });

  test('westendtheatre review with URL -> true', () => {
    assert.strictEqual(shouldValidateUrl({
      url: 'https://theguardian.com/review',
      source: 'westendtheatre',
    }), true);
  });

  test('theatre-reviews review with URL -> true', () => {
    assert.strictEqual(shouldValidateUrl({
      url: 'https://thestage.co.uk/review',
      source: 'theatre-reviews',
    }), true);
  });

  test('stagedoor review with URL -> true', () => {
    assert.strictEqual(shouldValidateUrl({
      url: 'https://whatsonstage.com/review',
      source: 'stagedoor',
    }), true);
  });

  test('thestage-roundup review with URL -> true', () => {
    assert.strictEqual(shouldValidateUrl({
      url: 'https://thestage.co.uk/roundup',
      source: 'thestage-roundup',
    }), true);
  });

  // --- Non-roundup sources: should NOT validate ---

  test('serp-discovery review -> false', () => {
    assert.strictEqual(shouldValidateUrl({
      url: 'https://variety.com/review/some-show',
      source: 'serp-discovery',
    }), false);
  });

  test('gather-reviews (default) source -> false', () => {
    assert.strictEqual(shouldValidateUrl({
      url: 'https://variety.com/review',
      source: 'gather-reviews',
    }), false);
  });

  test('wrongUrl-retry source -> false', () => {
    assert.strictEqual(shouldValidateUrl({
      url: 'https://example.com/review',
      source: 'wrongUrl-retry',
    }), false);
  });

  // --- Edge cases ---

  test('no URL -> false', () => {
    assert.strictEqual(shouldValidateUrl({
      url: null,
      source: 'show-score',
    }), false);
  });

  test('empty URL -> false', () => {
    assert.strictEqual(shouldValidateUrl({
      url: '',
      source: 'show-score',
    }), false);
  });

  test('no source -> false', () => {
    assert.strictEqual(shouldValidateUrl({
      url: 'https://variety.com/review',
      source: null,
    }), false);
  });

  test('undefined source -> false', () => {
    assert.strictEqual(shouldValidateUrl({
      url: 'https://variety.com/review',
    }), false);
  });

  test('empty review object -> false', () => {
    assert.strictEqual(shouldValidateUrl({}), false);
  });
});
