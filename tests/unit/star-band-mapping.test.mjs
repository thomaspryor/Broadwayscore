/**
 * Unit tests for starToBand + letterGradeToBand + clampScoreToBand
 *
 * Pure functions in scripts/llm-scoring/config.ts that project a critic's
 * star rating or letter grade onto a score band [floor, ceiling]. The LLM
 * ensemble is constrained to score within the band, picking the within-band
 * position from prose warmth.
 *
 * Run: node --test tests/unit/star-band-mapping.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

process.env.TS_NODE_PROJECT = new URL('../../scripts/tsconfig.json', import.meta.url).pathname;
require('ts-node/register');

const {
  starToBand,
  letterGradeToBand,
  clampScoreToBand,
} = require('../../scripts/llm-scoring/config');

describe('starToBand — /5 scale', () => {
  it('5/5 → top band [91,100]', () => {
    assert.deepStrictEqual(starToBand(5, 5), { fraction: 1, floor: 91, ceiling: 100 });
  });
  it('4.5/5 (90%) → top band [91,100]', () => {
    assert.deepStrictEqual(starToBand(4.5, 5), { fraction: 0.9, floor: 91, ceiling: 100 });
  });
  it('4/5 (80%) → 4★ band [71,90]', () => {
    assert.deepStrictEqual(starToBand(4, 5), { fraction: 0.8, floor: 71, ceiling: 90 });
  });
  it('3.5/5 (70%) → 4★ band floor', () => {
    assert.deepStrictEqual(starToBand(3.5, 5), { fraction: 0.7, floor: 71, ceiling: 90 });
  });
  it('3/5 (60%) → 3★ band [51,70]', () => {
    assert.deepStrictEqual(starToBand(3, 5), { fraction: 0.6, floor: 51, ceiling: 70 });
  });
  it('2/5 (40%) → 2★ band [31,50]', () => {
    assert.deepStrictEqual(starToBand(2, 5), { fraction: 0.4, floor: 31, ceiling: 50 });
  });
  it('1/5 (20%) → 1★ band [0,30]', () => {
    assert.deepStrictEqual(starToBand(1, 5), { fraction: 0.2, floor: 0, ceiling: 30 });
  });
  it('0/5 → bottom band [0,30]', () => {
    assert.deepStrictEqual(starToBand(0, 5), { fraction: 0, floor: 0, ceiling: 30 });
  });
});

describe('starToBand — /4 scale (USA Today, NY Post)', () => {
  it('4/4 (100%) → top band [91,100]', () => {
    assert.deepStrictEqual(starToBand(4, 4), { fraction: 1, floor: 91, ceiling: 100 });
  });
  it('3.5/4 (87.5%) → 4★ band [71,90]', () => {
    assert.deepStrictEqual(starToBand(3.5, 4), { fraction: 0.875, floor: 71, ceiling: 90 });
  });
  it('3/4 (75%) → 4★ band [71,90]', () => {
    assert.deepStrictEqual(starToBand(3, 4), { fraction: 0.75, floor: 71, ceiling: 90 });
  });
  it('2.5/4 (62.5%) → 3★ band [51,70]', () => {
    assert.deepStrictEqual(starToBand(2.5, 4), { fraction: 0.625, floor: 51, ceiling: 70 });
  });
  it('1.5/4 (37.5%) → 2★ band [31,50]', () => {
    assert.deepStrictEqual(starToBand(1.5, 4), { fraction: 0.375, floor: 31, ceiling: 50 });
  });
  it('1/4 (25%) → 1★ band [0,30]', () => {
    assert.deepStrictEqual(starToBand(1, 4), { fraction: 0.25, floor: 0, ceiling: 30 });
  });
});

describe('starToBand — /10 scale', () => {
  it('9/10 → top band', () => {
    assert.deepStrictEqual(starToBand(9, 10), { fraction: 0.9, floor: 91, ceiling: 100 });
  });
  it('7/10 → 4★ band', () => {
    assert.deepStrictEqual(starToBand(7, 10), { fraction: 0.7, floor: 71, ceiling: 90 });
  });
});

describe('starToBand — boundary semantics', () => {
  it('rank-preservation: max-4★ (90) just below min-5★ (91)', () => {
    const fourStar = starToBand(4, 5);
    const fiveStar = starToBand(5, 5);
    assert.strictEqual(fourStar.ceiling + 1, fiveStar.floor);
  });
  it('rank-preservation: max-3★ (70) just below min-4★ (71)', () => {
    assert.strictEqual(starToBand(3, 5).ceiling + 1, starToBand(4, 5).floor);
  });
  it('default max defaults to 5', () => {
    assert.deepStrictEqual(starToBand(4), starToBand(4, 5));
  });
});

describe('letterGradeToBand — full grade table', () => {
  const expected = {
    'A+': [95, 100],
    'A':  [89, 94],
    'A-': [83, 88],
    'B+': [77, 82],
    'B':  [71, 76],
    'B-': [65, 70],
    'C+': [59, 64],
    'C':  [53, 58],
    'C-': [47, 52],
    'D+': [41, 46],
    'D':  [35, 40],
    'D-': [29, 34],
    'F':  [0,  28],
  };
  for (const [grade, [floor, ceiling]] of Object.entries(expected)) {
    it(`${grade} → [${floor},${ceiling}]`, () => {
      assert.deepStrictEqual(letterGradeToBand(grade), { floor, ceiling });
    });
  }
});

describe('letterGradeToBand — robust input', () => {
  it('lowercase a- treated same as A-', () => {
    assert.deepStrictEqual(letterGradeToBand('a-'), { floor: 83, ceiling: 88 });
  });
  it('whitespace tolerated: "  B+  "', () => {
    assert.deepStrictEqual(letterGradeToBand('  B+  '), { floor: 77, ceiling: 82 });
  });
  it('unrecognized returns null', () => {
    assert.strictEqual(letterGradeToBand('foo'), null);
  });
  it('null returns null', () => {
    assert.strictEqual(letterGradeToBand(null), null);
  });
  it('non-string returns null', () => {
    assert.strictEqual(letterGradeToBand(42), null);
  });
  it('empty string returns null', () => {
    assert.strictEqual(letterGradeToBand(''), null);
  });
});

describe('letterGradeToBand — rank preservation', () => {
  it('A+ floor (95) > A ceiling (94)', () => {
    assert.ok(letterGradeToBand('A+').floor > letterGradeToBand('A').ceiling);
  });
  it('every adjacent pair is rank-preserving', () => {
    const order = ['A+','A','A-','B+','B','B-','C+','C','C-','D+','D','D-','F'];
    for (let i = 0; i < order.length - 1; i++) {
      const higher = letterGradeToBand(order[i]);
      const lower  = letterGradeToBand(order[i + 1]);
      assert.ok(higher.floor > lower.ceiling,
        `${order[i]} floor=${higher.floor} should be > ${order[i+1]} ceiling=${lower.ceiling}`);
    }
  });
});

describe('clampScoreToBand', () => {
  it('clamps above ceiling to ceiling', () => {
    assert.strictEqual(clampScoreToBand(105, { floor: 91, ceiling: 100 }), 100);
  });
  it('clamps below floor to floor', () => {
    assert.strictEqual(clampScoreToBand(50, { floor: 91, ceiling: 100 }), 91);
  });
  it('passes through values inside the band', () => {
    assert.strictEqual(clampScoreToBand(95, { floor: 91, ceiling: 100 }), 95);
  });
  it('passes through floor and ceiling exactly', () => {
    assert.strictEqual(clampScoreToBand(91, { floor: 91, ceiling: 100 }), 91);
    assert.strictEqual(clampScoreToBand(100, { floor: 91, ceiling: 100 }), 100);
  });
});
