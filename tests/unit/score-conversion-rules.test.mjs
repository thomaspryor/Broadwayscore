/**
 * Unit tests for score conversion rules
 *
 * Sprint 3 - Score Conversion Audit
 *
 * Run with: npm run test:unit
 * Or: node --test tests/unit/score-conversion-rules.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  parseRating,
  validateScore,
  getExpectedScore
} = require('../../scripts/lib/score-conversion-rules');

describe('Score Conversion Rules', () => {
  describe('Letter Grade Conversions', () => {
    it('A+ = 97', () => {
      assert.strictEqual(getExpectedScore('A+'), 97);
    });

    it('A = 93', () => {
      assert.strictEqual(getExpectedScore('A'), 93);
    });

    it('A- = 90', () => {
      assert.strictEqual(getExpectedScore('A-'), 90);
    });

    it('B+ = 87', () => {
      assert.strictEqual(getExpectedScore('B+'), 87);
    });

    it('B = 83', () => {
      assert.strictEqual(getExpectedScore('B'), 83);
    });

    it('B- = 80', () => {
      assert.strictEqual(getExpectedScore('B-'), 80);
    });

    it('C+ = 77', () => {
      assert.strictEqual(getExpectedScore('C+'), 77);
    });

    it('C = 73', () => {
      assert.strictEqual(getExpectedScore('C'), 73);
    });

    it('C- = 70', () => {
      assert.strictEqual(getExpectedScore('C-'), 70);
    });

    it('D = 60', () => {
      assert.strictEqual(getExpectedScore('D'), 60);
    });

    it('F = 50', () => {
      assert.strictEqual(getExpectedScore('F'), 50);
    });

    it('case insensitive', () => {
      assert.strictEqual(getExpectedScore('b+'), 87);
      assert.strictEqual(getExpectedScore('a-'), 90);
    });
  });

  describe('Letter Grade Ranges', () => {
    it('B+/A- averages to 88.5', () => {
      const result = parseRating('B+/A-');
      assert.strictEqual(result.type, 'letter_range');
      assert.strictEqual(result.expected, 88.5);
    });

    it('B+ to A- averages to 88.5', () => {
      const result = parseRating('B+ to A-');
      assert.strictEqual(result.type, 'letter_range');
      assert.strictEqual(result.expected, 88.5);
    });
  });

  describe('Star Rating Conversions (out of 5)', () => {
    it('5 stars = 100', () => {
      assert.strictEqual(getExpectedScore('5 stars'), 100);
    });

    it('4.5 stars = 90', () => {
      assert.strictEqual(getExpectedScore('4.5 stars'), 90);
    });

    it('4 stars = 80', () => {
      assert.strictEqual(getExpectedScore('4 stars'), 80);
    });

    it('3.5 stars = 70', () => {
      assert.strictEqual(getExpectedScore('3.5 stars'), 70);
    });

    it('3 stars = 60', () => {
      assert.strictEqual(getExpectedScore('3 stars'), 60);
    });

    it('2.5 stars = 50', () => {
      assert.strictEqual(getExpectedScore('2.5 stars'), 50);
    });

    it('2 stars = 40', () => {
      assert.strictEqual(getExpectedScore('2 stars'), 40);
    });

    it('1 star = 20', () => {
      assert.strictEqual(getExpectedScore('1 star'), 20);
    });

    it('0 stars = 0', () => {
      assert.strictEqual(getExpectedScore('0 stars'), 0);
    });
  });

  describe('Star Rating Variations', () => {
    it('3.5 out of 5 = 70', () => {
      assert.strictEqual(getExpectedScore('3.5 out of 5'), 70);
    });

    it('4/5 = 80', () => {
      assert.strictEqual(getExpectedScore('4/5'), 80);
    });

    it('3/5 stars = 60', () => {
      assert.strictEqual(getExpectedScore('3/5 stars'), 60);
    });
  });

  describe('Star Rating Conversions (out of 4)', () => {
    it('4/4 = 100', () => {
      assert.strictEqual(getExpectedScore('4/4'), 100);
    });

    it('3.5/4 = 88', () => {
      assert.strictEqual(getExpectedScore('3.5/4'), 88);
    });

    it('3/4 = 75', () => {
      assert.strictEqual(getExpectedScore('3/4'), 75);
    });

    it('2.5/4 = 63', () => {
      assert.strictEqual(getExpectedScore('2.5/4'), 63);
    });

    it('2/4 = 50', () => {
      assert.strictEqual(getExpectedScore('2/4'), 50);
    });

    it('1/4 = 25', () => {
      assert.strictEqual(getExpectedScore('1/4'), 25);
    });

    it('0/4 = 0', () => {
      assert.strictEqual(getExpectedScore('0/4'), 0);
    });
  });

  describe('Sentiment Conversions', () => {
    it('Rave = 90', () => {
      assert.strictEqual(getExpectedScore('Rave'), 90);
    });

    it('Positive = 75', () => {
      assert.strictEqual(getExpectedScore('Positive'), 75);
    });

    it('Mixed = 60', () => {
      assert.strictEqual(getExpectedScore('Mixed'), 60);
    });

    it('Negative = 40', () => {
      assert.strictEqual(getExpectedScore('Negative'), 40);
    });

    it('Pan = 25', () => {
      assert.strictEqual(getExpectedScore('Pan'), 25);
    });

    it('Sentiment: Positive format = 75', () => {
      assert.strictEqual(getExpectedScore('Sentiment: Positive'), 75);
    });

    it('case insensitive', () => {
      assert.strictEqual(getExpectedScore('RAVE'), 90);
      assert.strictEqual(getExpectedScore('positive'), 75);
    });
  });

  describe('Thumb Conversions', () => {
    it('Up = 80', () => {
      assert.strictEqual(getExpectedScore('Up'), 80);
    });

    it('Meh = 60', () => {
      assert.strictEqual(getExpectedScore('Meh'), 60);
    });

    it('Flat = 60', () => {
      assert.strictEqual(getExpectedScore('Flat'), 60);
    });

    it('Down = 40', () => {
      assert.strictEqual(getExpectedScore('Down'), 40);
    });
  });

  describe('Numeric Ratings', () => {
    it('direct numeric value 80 = 80', () => {
      assert.strictEqual(getExpectedScore(80), 80);
    });

    it('string numeric "88" = 88', () => {
      assert.strictEqual(getExpectedScore('88'), 88);
    });

    it('numeric 100 = 100', () => {
      assert.strictEqual(getExpectedScore(100), 100);
    });

    it('numeric 0 = 0', () => {
      assert.strictEqual(getExpectedScore(0), 0);
    });
  });

  describe('Designation-Only Entries', () => {
    it('Recommended is not scoreable', () => {
      const result = parseRating('Recommended');
      assert.strictEqual(result.isDesignation, true);
      assert.strictEqual(result.expected, null);
    });

    it('Critics Pick is not scoreable', () => {
      const result = parseRating('Critics Pick');
      assert.strictEqual(result.isDesignation, true);
    });

    it('Must See is not scoreable', () => {
      const result = parseRating('Must See');
      assert.strictEqual(result.isDesignation, true);
    });
  });

  describe('Null/Missing Ratings', () => {
    it('null rating returns null expected', () => {
      const result = parseRating(null);
      assert.strictEqual(result.type, 'null');
      assert.strictEqual(result.expected, null);
      assert.strictEqual(result.unparseable, false);
    });

    it('undefined rating returns null expected', () => {
      const result = parseRating(undefined);
      assert.strictEqual(result.type, 'null');
      assert.strictEqual(result.expected, null);
    });

    it('empty string returns null expected', () => {
      const result = parseRating('');
      assert.strictEqual(result.type, 'null');
      assert.strictEqual(result.expected, null);
    });
  });

  describe('validateScore', () => {
    it('correct score within tolerance passes', () => {
      const result = validateScore('B+', 85, 10);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.expected, 87);
      assert.strictEqual(result.difference, 2);
    });

    it('incorrect score outside tolerance fails', () => {
      const result = validateScore('A', 50, 10);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.expected, 93);
      assert.strictEqual(result.difference, 43);
    });

    it('null rating is skipped', () => {
      const result = validateScore(null, 75);
      assert.strictEqual(result.skipped, true);
      assert.strictEqual(result.reason, 'null_rating');
    });

    it('designation is skipped', () => {
      const result = validateScore('Recommended', 75);
      assert.strictEqual(result.skipped, true);
      assert.strictEqual(result.reason, 'designation_only');
    });

    it('unparseable rating fails', () => {
      const result = validateScore('gibberish123', 75);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, 'unparseable');
    });
  });
});
