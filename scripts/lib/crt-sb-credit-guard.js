/**
 * crt-sb-credit-guard.js — the per-run ScrapingBee page-credit budget decision
 * used by scripts/collect-review-texts.js, extracted so it can be tested
 * against the real function rather than a copy (CLAUDE.md §15).
 *
 * Why this exists (BRO-3009 S1-T5): the call site used to compute credits and
 * then compare `stats.scrapingBeePageCredits + credits > SB_PAGE_CREDIT_BUDGET`
 * inline, with nothing asserting either side was a number. Two ways that
 * comparison silently evaluates to false and DISABLES the budget guard:
 *
 *   1. an unknown proxyType — a NaN/undefined credit cost, `NaN > budget`
 *      is false, so an unpriced tier bills forever;
 *   2. a malformed SB_PAGE_CREDIT_BUDGET env value — `parseInt('abc')` is
 *      NaN, and `spent + credits > NaN` is also false, so the cap the
 *      operator thought they set never trips.
 *
 * Both now throw. A spend guard that fails open is worse than no guard,
 * because the operator believes it is holding.
 *
 * Pure: no I/O, no process.env reads, no mutation of the caller's stats — the
 * caller passes the numbers in and acts on the returned decision.
 */
'use strict';

const { creditsFor, assertFiniteCost } = require('./provider-credits');

/**
 * @param {object} args
 * @param {number} args.spentCredits  credits already billed this run
 * @param {string} args.mode          ScrapingBee proxyType ('standard' |
 *                                    'premium_proxy' | 'stealth_proxy') — the
 *                                    real API param value, looked up in
 *                                    provider-credits.js; unknown values throw
 * @param {number} args.budget        per-run ceiling (SB_PAGE_CREDIT_BUDGET)
 * @returns {{credits: number, projected: number, exhausted: boolean}}
 * @throws if the mode is unknown, or any of the three numbers is not finite
 *         and non-negative
 */
function sbPageBudgetDecision({ spentCredits, mode, budget }) {
  const credits = creditsFor('sb', mode);
  assertFiniteCost(spentCredits, 'sbPageBudgetDecision: spentCredits');
  assertFiniteCost(credits, `sbPageBudgetDecision: credits for mode "${mode}"`);
  assertFiniteCost(budget, 'sbPageBudgetDecision: budget (SB_PAGE_CREDIT_BUDGET)');
  const projected = assertFiniteCost(
    spentCredits + credits,
    'sbPageBudgetDecision: projected',
  );
  return { credits, projected, exhausted: projected > budget };
}

module.exports = { sbPageBudgetDecision };
