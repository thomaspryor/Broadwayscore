/**
 * crt-sb-credit-guard.js — the per-run ScrapingBee page-credit budget decision
 * used by scripts/collect-review-texts.js, extracted so it can be tested
 * against the real function rather than a copy (CLAUDE.md §15).
 *
 * Why this exists (BRO-3009 S1-T5): the call site compared
 * `stats.scrapingBeePageCredits + credits > SB_PAGE_CREDIT_BUDGET` inline,
 * with nothing asserting either side was a number. The credits side was
 * already safe — BRO-3057 had routed it through creditsFor(), which throws on
 * an unknown proxyType. The BUDGET side was not: `parseInt('abc')` is NaN, and
 * `spent + credits > NaN` is false, so a fat-fingered SB_PAGE_CREDIT_BUDGET
 * silently disabled the cap the operator thought they had set.
 *
 * Both sides are now asserted here. A spend guard that fails open is worse
 * than no guard, because the operator believes it is holding.
 *
 * The env value itself is parsed at STARTUP by resolveSbPageCreditBudget()
 * below, not here — see that function for why a per-call throw would have been
 * the wrong fix.
 *
 * Pure: no I/O, no process.env reads, no mutation of the caller's stats — the
 * caller passes the numbers in and acts on the returned decision.
 */
'use strict';

const { creditsFor, assertFiniteCost } = require('./provider-credits');

/**
 * Parse SB_PAGE_CREDIT_BUDGET at STARTUP, strictly.
 *
 * Called once at module load in collect-review-texts.js so a malformed value
 * kills the run immediately with a clear message. Doing this per-call instead
 * would be worse than the bug it replaces: the per-review tier runner catches
 * a thrown tier error and falls through to the NEXT provider
 * (collect-review-texts.js's `catch (error) { ... continue; }`), so a typo'd
 * budget would silently reroute every ScrapingBee fetch to Bright Data — a
 * config mistake presenting as a provider miss, at ~15x the per-call cost.
 * Configuration corruption must stop the run, not quietly re-route it.
 *
 * `parseInt` is not enough on its own: parseInt('200oops') is 200, so a
 * fat-fingered value would pass a finite-number check while meaning something
 * the operator never typed. Require the whole string to be an integer.
 *
 * @param {string|undefined} raw   process.env.SB_PAGE_CREDIT_BUDGET
 * @param {number} fallback        default when the env var is unset/empty
 * @returns {number}
 */
function resolveSbPageCreditBudget(raw, fallback = 200) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(
      `SB_PAGE_CREDIT_BUDGET must be a non-negative integer, got "${raw}". ` +
        'Refusing to start: an unparseable budget silently disables the ScrapingBee ' +
        'spend cap and reroutes those fetches to Bright Data.',
    );
  }
  return Number(text);
}

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

module.exports = { sbPageBudgetDecision, resolveSbPageCreditBudget };
