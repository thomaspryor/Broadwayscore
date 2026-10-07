// Tests scripts/lib/context-budget-policy.js's pure tier-decision logic — the
// canonical spec ~/.claude/hooks/context-budget-nudge.sh's bash threshold
// ladder must match by hand (CLAUDE.md rule 15: require() the real function).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  WARN_TOKENS, COMPACT_NOW_TOKENS, HANDOFF_TOKENS, WARN_PCT, FABLE_WARN_PCT, HANDOFF_PCT,
  TIERS, classifyBudgetTier,
} = require('../../scripts/lib/context-budget-policy.js');

test('classifyBudgetTier: below every threshold -> none', () => {
  assert.equal(classifyBudgetTier({ usedTokens: 50000, pct: 20 }), TIERS.NONE);
});

test('classifyBudgetTier: no signals at all -> none', () => {
  assert.equal(classifyBudgetTier({}), TIERS.NONE);
  assert.equal(classifyBudgetTier(), TIERS.NONE);
});

test('classifyBudgetTier: WARN_TOKENS boundary — one under is none, at it is advise-compact', () => {
  assert.equal(classifyBudgetTier({ usedTokens: WARN_TOKENS - 1, pct: null }), TIERS.NONE);
  assert.equal(classifyBudgetTier({ usedTokens: WARN_TOKENS, pct: null }), TIERS.ADVISE_COMPACT);
});

test('classifyBudgetTier: WARN_PCT boundary (non-fable) — 69 none, 70 advise-compact', () => {
  assert.equal(classifyBudgetTier({ usedTokens: null, pct: 69 }), TIERS.NONE);
  assert.equal(classifyBudgetTier({ usedTokens: null, pct: 70 }), TIERS.ADVISE_COMPACT);
});

test('classifyBudgetTier: fable uses the lower 50% threshold', () => {
  assert.equal(classifyBudgetTier({ usedTokens: null, pct: 49, isFable: true }), TIERS.NONE);
  assert.equal(classifyBudgetTier({ usedTokens: null, pct: 50, isFable: true }), TIERS.ADVISE_COMPACT);
  // A non-fable session at the same 50% pct stays below its own 70% bar.
  assert.equal(classifyBudgetTier({ usedTokens: null, pct: 50, isFable: false }), TIERS.NONE);
});

test('classifyBudgetTier: COMPACT_NOW_TOKENS boundary — one under is advise-compact, at it is advise-compact-now', () => {
  assert.equal(classifyBudgetTier({ usedTokens: COMPACT_NOW_TOKENS - 1, pct: null }), TIERS.ADVISE_COMPACT);
  assert.equal(classifyBudgetTier({ usedTokens: COMPACT_NOW_TOKENS, pct: null }), TIERS.ADVISE_COMPACT_NOW);
});

test('classifyBudgetTier: pct crossing HANDOFF_PCT wins over the token-driven compact-now tier', () => {
  // pct >= 80 is itself a handoff-eligible signal (small-window session, e.g. pct
  // reflects a tight context_window) even though usedTokens alone would only
  // reach the softer compact-now tier — the OR is evaluated on both axes at
  // each tier, handoff checked before compact-now (mirrors the bash order).
  assert.equal(classifyBudgetTier({ usedTokens: 190000, pct: 95 }), TIERS.ADVISE_HANDOFF_ELIGIBLE);
});

test('classifyBudgetTier: HANDOFF_TOKENS boundary — one under is advise-compact-now, at it is advise-handoff-eligible', () => {
  assert.equal(classifyBudgetTier({ usedTokens: HANDOFF_TOKENS - 1, pct: null }), TIERS.ADVISE_COMPACT_NOW);
  assert.equal(classifyBudgetTier({ usedTokens: HANDOFF_TOKENS, pct: null }), TIERS.ADVISE_HANDOFF_ELIGIBLE);
});

test('classifyBudgetTier: HANDOFF_PCT boundary (non-fable) — 79 stays below handoff, 80 reaches it', () => {
  assert.equal(classifyBudgetTier({ usedTokens: null, pct: 79 }), TIERS.ADVISE_COMPACT);
  assert.equal(classifyBudgetTier({ usedTokens: null, pct: 80 }), TIERS.ADVISE_HANDOFF_ELIGIBLE);
});

test('classifyBudgetTier: handoff-eligible via pct short-circuits even with tokens well under COMPACT_NOW_TOKENS', () => {
  assert.equal(classifyBudgetTier({ usedTokens: 5000, pct: 80 }), TIERS.ADVISE_HANDOFF_ELIGIBLE);
});

test('classifyBudgetTier: either axis alone is enough to trip a tier (OR, not AND)', () => {
  // tokens over COMPACT_NOW_TOKENS (but under HANDOFF_TOKENS), pct null (unprobeable
  // window) still fires the compact-now tier on the token axis alone.
  assert.equal(classifyBudgetTier({ usedTokens: 200001, pct: null }), TIERS.ADVISE_COMPACT_NOW);
  // pct over threshold, tokens null still fires.
  assert.equal(classifyBudgetTier({ usedTokens: null, pct: 71 }), TIERS.ADVISE_COMPACT);
});

test('exported constants match the values context-budget-nudge.sh must mirror', () => {
  assert.equal(WARN_TOKENS, 180000);
  assert.equal(COMPACT_NOW_TOKENS, 200000);
  assert.equal(HANDOFF_TOKENS, 500000);
  assert.equal(WARN_PCT, 70);
  assert.equal(FABLE_WARN_PCT, 50);
  assert.equal(HANDOFF_PCT, 80);
});
