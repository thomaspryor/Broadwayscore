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
const { sbPageBudgetDecision, resolveSbPageCreditBudget } = require('./crt-sb-credit-guard.js');

test('unknown proxyType THROWS (inherited from creditsFor, pinned here)', () => {
  // Not new in BRO-3009 — BRO-3057 already routed the credits side through
  // creditsFor. Pinned so a future refactor of this guard cannot quietly
  // reintroduce a lookup that returns undefined: `undefined + spent` is NaN,
  // and `NaN > budget` is false, so the call would proceed as if under
  // budget, forever.
  assert.throws(
    () => sbPageBudgetDecision({ spentCredits: 0, mode: 'no_such_proxy', budget: 200 }),
    /creditsFor: unknown provider\/mode "sb\/no_such_proxy"/,
  );

  // Prove the silent alternative really is silent, so the throw above is the
  // only thing standing between an unpriced tier and an uncapped spend.
  const credits = { no_such_proxy: undefined }.no_such_proxy;
  assert.equal(0 + credits > 200, false, 'NaN > budget is false — fails open');
});

test('malformed budget (NaN) THROWS rather than disabling the cap — the genuinely new guard', () => {
  // This is the hole BRO-3009 actually closed. Defence in depth: the env is
  // now strictly parsed at startup (resolveSbPageCreditBudget), so a NaN
  // should never reach here — but if it ever does, it must not fail open.
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

// ---- startup env parsing -----------------------------------------------

test('resolveSbPageCreditBudget: unset/empty falls back to the default', () => {
  assert.equal(resolveSbPageCreditBudget(undefined, 200), 200);
  assert.equal(resolveSbPageCreditBudget('', 200), 200);
  assert.equal(resolveSbPageCreditBudget('   ', 200), 200);
});

test('resolveSbPageCreditBudget: a valid override parses', () => {
  assert.equal(resolveSbPageCreditBudget('1000', 200), 1000);
  assert.equal(resolveSbPageCreditBudget(' 1000 ', 200), 1000);
  assert.equal(resolveSbPageCreditBudget('0', 200), 0);
});

test('resolveSbPageCreditBudget: partial garbage THROWS — parseInt would have read 200', () => {
  // parseInt('200oops', 10) === 200, so a finite-number check alone would
  // accept a value the operator never meant to type.
  assert.equal(Number.parseInt('200oops', 10), 200, 'parseInt really is this lenient');
  assert.throws(() => resolveSbPageCreditBudget('200oops', 200), /must be a non-negative integer/);
  assert.throws(() => resolveSbPageCreditBudget('abc', 200), /must be a non-negative integer/);
  assert.throws(() => resolveSbPageCreditBudget('-5', 200), /must be a non-negative integer/);
  assert.throws(() => resolveSbPageCreditBudget('1e3', 200), /must be a non-negative integer/);
});
