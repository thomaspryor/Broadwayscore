import { test, describe } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  classify,
  audit,
  HEDGE_FAIL_MINORITY_THRESHOLD,
  HEDGE_WARN_MINORITY_THRESHOLD,
  STRONG_SPLIT_MAJORITY_THRESHOLD,
  MIN_REVIEWS_FOR_AUDIT,
} = require('./audit-false-balance.js');

describe('HEDGE_VS_NEAR_UNANIMOUS', () => {
  test('fires on the BRO-164 reference pattern (90% majority, hedge clause)', () => {
    const result = classify({
      text: "Critics embrace this farce, praising its wordplay and pace, though some find the puns groanworthy and the formula wearing thin.",
      bucketBreakdown: { positive: 37, mixed: 4, negative: 0 },
    });
    const flag = result.flags.find(f => f.startsWith('HEDGE_VS_NEAR_UNANIMOUS_FAIL'));
    assert.ok(flag, `expected HEDGE_VS_NEAR_UNANIMOUS_FAIL, got: ${result.flags.join(',')}`);
  });

  test('downgrades to warn once the minority share crosses the fail threshold', () => {
    // 6/40 = 15% minority: above the 10% fail line, within the 20% warn line.
    const result = classify({
      text: "Critics praise the cast, though some found the second act sluggish.",
      bucketBreakdown: { positive: 34, mixed: 6, negative: 0 },
    });
    assert.ok(1 - 34 / 40 > HEDGE_FAIL_MINORITY_THRESHOLD, 'fixture must sit above the fail threshold');
    assert.ok(1 - 34 / 40 <= HEDGE_WARN_MINORITY_THRESHOLD, 'fixture must sit within the warn threshold');
    const flag = result.flags.find(f => f.startsWith('HEDGE_VS_NEAR_UNANIMOUS_WARN'));
    assert.ok(flag, `expected HEDGE_VS_NEAR_UNANIMOUS_WARN, got: ${result.flags.join(',')}`);
  });

  test('does NOT fire when the text carries no hedge language', () => {
    const result = classify({
      text: "Critics hail this production as a triumph, praising the cast and design.",
      bucketBreakdown: { positive: 38, mixed: 3, negative: 0 },
    });
    assert.strictEqual(result.flags.length, 0, `expected no flags, got: ${result.flags.join(',')}`);
  });

  test('does NOT fire once the minority is a genuinely large share', () => {
    // 15/40 = 37.5% minority: real disagreement, hedge language is accurate.
    const result = classify({
      text: "Critics praise the cast, though some found the production overlong.",
      bucketBreakdown: { positive: 25, mixed: 15, negative: 0 },
    });
    const flag = result.flags.find(f => f.startsWith('HEDGE_VS_NEAR_UNANIMOUS'));
    assert.strictEqual(flag, undefined, `expected no HEDGE flag, got: ${result.flags.join(',')}`);
  });
});

describe('STRONG_SPLIT_LANGUAGE_VS_MAJORITY', () => {
  test('fires when "divided" language pairs with a dominant majority', () => {
    const result = classify({
      text: "Critics are divided on this revival, with most praising the cast but some panning the direction.",
      bucketBreakdown: { positive: 32, mixed: 4, negative: 0 },
    });
    assert.ok(32 / 36 >= STRONG_SPLIT_MAJORITY_THRESHOLD, 'fixture majority must clear the threshold');
    const flag = result.flags.find(f => f.startsWith('STRONG_SPLIT_LANGUAGE_VS_MAJORITY'));
    assert.ok(flag, `expected STRONG_SPLIT_LANGUAGE_VS_MAJORITY, got: ${result.flags.join(',')}`);
  });

  test('does NOT fire on "divided" language when the split is genuinely close', () => {
    const result = classify({
      text: "Critics are divided on this revival, with some praising the cast and others panning the direction.",
      bucketBreakdown: { positive: 12, mixed: 10, negative: 8 },
    });
    assert.ok(12 / 30 < STRONG_SPLIT_MAJORITY_THRESHOLD, 'fixture majority must be below the threshold');
    const flag = result.flags.find(f => f.startsWith('STRONG_SPLIT_LANGUAGE_VS_MAJORITY'));
    assert.strictEqual(flag, undefined, `expected no STRONG_SPLIT flag for a genuine near-even split, got: ${result.flags.join(',')}`);
  });
});

describe('classify() guard rails', () => {
  test('returns null below the minimum review-count floor', () => {
    const result = classify({
      text: "Critics are divided, though some find it uneven.",
      bucketBreakdown: { positive: 3, mixed: 1, negative: 0 },
    });
    assert.ok(3 + 1 < MIN_REVIEWS_FOR_AUDIT);
    assert.strictEqual(result, null);
  });

  test('returns null when bucketBreakdown is missing', () => {
    const result = classify({ text: 'Critics are divided.' });
    assert.strictEqual(result, null);
  });
});

test('live data: BRO-164 reference case (comedy-about-spies) is flagged if present', () => {
  if (!existsSync(path.join(repoRoot, 'data', 'critic-consensus.json'))) {
    return; // gitignored/generated file — not present in every checkout
  }
  const issues = audit();
  const target = issues.find(i => i.id === 'the-comedy-about-spies-west-end-2026');
  if (!target) return; // consensus may have been regenerated away from the reported pattern
  assert.strictEqual(target.severity, 'fail', `expected fail severity, got: ${JSON.stringify(target)}`);
});
