#!/usr/bin/env node
// scripts/lib/github-rate-limit-retry.js — pure retry decisions for private-repo
// git checkouts authenticated with REVIEW_TEXTS_TOKEN (a classic PAT, 5000
// req/hr across ALL API calls from that token — shared by every workflow that
// checks out core-data or review-texts). No fetch, no fs, no timers, no
// process: every function here is a pure input→output decision so the retry
// timing is unit-testable without spinning up a real git clone.
//
// BRO-66: opening-night-poller.yml's "Checkout review-texts (private repo)"
// step failed with "API rate limit exceeded for user ID 3475675" during a
// 46-run/hour burst on an aggressive 10-min polling cadence. The composite
// actions (checkout-core-data, checkout-review-texts) previously retried ANY
// clone failure with a flat sleep — this gives the rate-limit case its own
// detection + 30s-base exponential backoff, per the card's acceptance
// criteria, instead of treating it the same as a generic network blip.
//
// CLAUDE.md rule 15 — tests require() these functions rather than restating
// the logic; tests/unit/checkout-rate-limit-retry.test.mjs is the caller.

'use strict';

// GitHub's classic-PAT REST/git-over-HTTPS rate-limit error. Seen verbatim in
// the BRO-66 incident: "API rate limit exceeded for user ID 3475675 (or one
// of its API partners)." Secondary limits use different wording ("You have
// exceeded a secondary rate limit") — matched too since the git clone path
// can trip either one, and both call for the same backoff-and-retry response.
const RATE_LIMIT_MESSAGE_RE = /api rate limit exceeded|secondary rate limit|rate limit exceeded/i;

// Never sleep longer than this in one wait — a checkout retry loop is inside
// a job with its own timeout-minutes; an unbounded wait just burns that
// budget without giving the job a chance to fail visibly and get retried by
// the next cron/orchestrator iteration.
const MAX_DELAY_MS = 300_000; // 5 min
// 30s base per the BRO-66 acceptance criteria ("30s backoff").
const DEFAULT_BASE_MS = 30_000;
// 3 attempts at a 30s base = 30 + 60 = 90s of sleeping worst case (last
// attempt's failure doesn't sleep), well inside a 60s-scoped composite-action
// step and small relative to the poller's 60-min job timeout.
const DEFAULT_MAX_ATTEMPTS = 3;

function isRateLimitError(text) {
  return RATE_LIMIT_MESSAGE_RE.test(String(text || ''));
}

/**
 * How long to wait before the next attempt. Full-jitter exponential from a
 * 30s base: attempt 1 waits ~30s, attempt 2 waits ~60s, capped at MAX_DELAY_MS.
 *
 * @param {number} attempt 1-based attempt that just failed
 * @param {{baseMs?: number, capMs?: number, random?: () => number}} opts
 */
function retryDelayMs(attempt, opts = {}) {
  const baseMs = Number.isFinite(opts.baseMs) ? opts.baseMs : DEFAULT_BASE_MS;
  const capMs = Number.isFinite(opts.capMs) ? opts.capMs : MAX_DELAY_MS;
  const random = typeof opts.random === 'function' ? opts.random : Math.random;

  const exp = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  // Half the spread (like linear-retry-policy.js's exponential branch) so a
  // retry storm still spreads out but no single attempt collapses to ~0ms.
  return Math.min(capMs, Math.round(exp * (0.5 + 0.5 * random())));
}

/**
 * Decide whether a failed checkout attempt should retry.
 *
 * @param {{attempt: number, exitCode: number, stderr?: string, maxAttempts?: number}} input
 * @returns {{retry: boolean, reason: string}}
 */
function shouldRetry({ attempt, exitCode, stderr = '', maxAttempts } = {}) {
  const cap = Number.isFinite(maxAttempts) ? maxAttempts : DEFAULT_MAX_ATTEMPTS;
  if (exitCode === 0) return { retry: false, reason: 'success' };
  if (!isRateLimitError(stderr)) return { retry: false, reason: 'not-rate-limit' };
  if (attempt >= cap) return { retry: false, reason: 'max-attempts-reached' };
  return { retry: true, reason: 'rate-limited' };
}

module.exports = {
  isRateLimitError,
  retryDelayMs,
  shouldRetry,
  MAX_DELAY_MS,
  DEFAULT_BASE_MS,
  DEFAULT_MAX_ATTEMPTS,
};
