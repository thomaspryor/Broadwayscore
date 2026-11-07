'use strict';
/**
 * Per-call timeout + per-review time budget for LLM scoring calls (BRO-6549).
 *
 * Why: the poller's "Score reviews inline" step has a 10-minute step timeout.
 * Gemini had no call timeout, Anthropic used the SDK default (10 min), and
 * OpenAI/Kimi allowed 300s x 5 retries, so one stuck call consumed the whole
 * step and every later show was reported as "score: all failed".
 *
 * Defaults preserve the old behaviour for the bulk crons (300s per call, no
 * review budget; their long backoffs ride out quota outages). Inline steps opt
 * in via env: LLM_CALL_TIMEOUT_MS and LLM_REVIEW_BUDGET_MS.
 *
 * Each scorer retry loop does:
 *   const budget = createReviewBudget();
 *   for (attempt...) {
 *     if (attempt > 1 && !budget.canRetry()) break;      // covers paths that never sleep
 *     await withTimeout(() => call({ timeout: budget.callTimeout() }), budget.callTimeout(), ...)
 *     ...catch: if (!(await budget.sleepOrGiveUp(waitTime))) break;
 *   }
 * callWithTimeout only stops the wait. The request itself is also aborted by the
 * SDK/fetch timeout passed alongside it (Anthropic and Gemini `timeout`,
 * fetch `AbortSignal.timeout`), so abandoned sockets do not linger.
 */
const { withTimeout } = require('./with-timeout');

const DEFAULT_CALL_TIMEOUT_MS = 300000;

function envMs(name) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function createReviewBudget(opts = {}) {
  const now = opts.now || Date.now;
  const callMs = opts.callTimeoutMs || envMs('LLM_CALL_TIMEOUT_MS') || DEFAULT_CALL_TIMEOUT_MS;
  const budgetMs = opts.reviewBudgetMs || envMs('LLM_REVIEW_BUDGET_MS') || Infinity;
  const startedAt = now();
  const remainingMs = () => Math.max(0, budgetMs - (now() - startedAt));
  return {
    remainingMs,
    // Another attempt may start only while budget is left.
    canRetry: () => remainingMs() > 0,
    // Per-call timeout, clamped so a late attempt cannot overrun the budget.
    callTimeout: () => Math.max(1000, Math.min(callMs, remainingMs())),
    // Sleep unless the backoff would consume the rest of the budget. false = give up.
    sleepOrGiveUp: async (waitMs) => {
      if (waitMs >= remainingMs()) return false;
      await new Promise(r => setTimeout(r, waitMs));
      return true;
    },
  };
}

/** Bound how long we wait on fn(); rejects with code LLM_CALL_TIMEOUT. */
async function callWithTimeout(fn, ms, label = 'LLM call') {
  try {
    return await withTimeout(fn, ms, { label });
  } catch (e) {
    if (e && /timed out after/.test(e.message || '')) e.code = 'LLM_CALL_TIMEOUT';
    throw e;
  }
}

module.exports = { DEFAULT_CALL_TIMEOUT_MS, createReviewBudget, callWithTimeout };
