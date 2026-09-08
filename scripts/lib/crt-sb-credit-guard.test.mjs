/**
 * crt-sb-credit-guard.test.mjs — BRO-3009 S1-T5.
 *
 * Tests the REAL function collect-review-texts.js calls (CLAUDE.md §15), not a
 * copy: if the production guard regresses to a bare `>` comparison, these fail.
 *
 * The headline case is the one the old inline comparison got wrong — an
 * unknown proxyType must THROW, because the silent alternative (`NaN > budget`
 * is false) reads as "budget not exceeded" and disables the cap.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sbPageBudgetDecision } = require('./crt-sb-credit-guard.js');

test('unknown proxyType THROWS instead of silently passing the budget check', () => {
  // The regression this guard exists for: with no throw, credits would be
  // undefined, `undefined + spent` is NaN, and `NaN > budget` is false — the
  // call would proceed as if it were under budget, forever.
  assert.throws(
    () => sbPageBudgetDecision({ spentCredits: 0, mode: 'no_such_proxy', budget: 200 }),
    /creditsFor: unknown provider\/mode "sb\/no_such_proxy"/,
  );

  // Prove the silent alternative really is silent, so the throw above is the
  // only thing standing between an unpriced tier and an uncapped spend.
  const credits = { no_such_proxy: undefined }.no_such_proxy;
  assert.equal(0 + credits > 200, false, 'NaN > budget is false — fails open');
});

test('malformed SB_PAGE_CREDIT_BUDGET (NaN) THROWS rather than disabling the cap', () => {
  // parseInt('abc') === NaN at scripts/collect-review-texts.js:262.
  assert.throws(
    () => sbPageBudgetDecision({ spentCredits: 0, mode: 'standard', budget: NaN }),
    /assertFiniteCost: sbPageBudgetDecision: budget/,
  );
});

test('non-finite spentCredits THROWS', () => {
  assert.throws(
    () => sbPageBudgetDecision({ spentCredits: undefined, mode: 'standard', budget: 200 }),
    /assertFiniteCost: sbPageBudgetDecision: spentCredits/,
  );
  assert.throws(
    () => sbPageBudgetDecision({ spentCredits: -5, mode: 'standard', budget: 200 }),
    /assertFiniteCost: sbPageBudgetDecision: spentCredits/,
  );
});

test('credits come from the shared provider-credits table, per real proxyType', () => {
  assert.equal(sbPageBudgetDecision({ spentCredits: 0, mode: 'standard', budget: 200 }).credits, 1);
  assert.equal(sbPageBudgetDecision({ spentCredits: 0, mode: 'premium_proxy', budget: 200 }).credits, 10);
  assert.equal(sbPageBudgetDecision({ spentCredits: 0, mode: 'stealth_proxy', budget: 200 }).credits, 75);
});

test('under budget is allowed; the boundary (projected === budget) is allowed', () => {
  const under = sbPageBudgetDecision({ spentCredits: 100, mode: 'standard', budget: 200 });
  assert.deepEqual(under, { credits: 1, projected: 101, exhausted: false });

  // Matches the original `spent + credits > budget` semantics exactly: landing
  // exactly on the ceiling still bills, one more credit does not.
  const exact = sbPageBudgetDecision({ spentCredits: 199, mode: 'standard', budget: 200 });
  assert.equal(exact.exhausted, false, 'projected === budget must not trip');
});

test('over budget trips, including the stealth tier a single call can blow past', () => {
  const over = sbPageBudgetDecision({ spentCredits: 200, mode: 'standard', budget: 200 });
  assert.equal(over.exhausted, true);

  // 75-credit stealth call from a nearly-full budget: the expensive tier is
  // exactly where a fail-open guard costs the most.
  const stealth = sbPageBudgetDecision({ spentCredits: 190, mode: 'stealth_proxy', budget: 200 });
  assert.deepEqual(stealth, { credits: 75, projected: 265, exhausted: true });
});

test('a zero budget blocks every call rather than being treated as "unset"', () => {
  assert.equal(
    sbPageBudgetDecision({ spentCredits: 0, mode: 'standard', budget: 0 }).exhausted,
    true,
  );
});
