#!/usr/bin/env node
// scripts/lib/alert-dispatch-streak.js — pure summary of the CURRENT
// auto-dispatch failure streak, for scripts/health-check.js's
// checkAlertRouterDeadman.
//
// Why this exists: that check fires on "the MOST RECENT attempt failed" (a
// deliberate ship-check decision — one stale success must not mask an outage
// that started right after it). But its alert title hardcoded "has been
// silently failing for 7 days", which is a different claim entirely. On
// 2026-08-31 the owner was paged with a 7-day subject for a breakage roughly
// 12h old (LINEAR_API_KEY missing from audit-imageless-scored-shows.yml), and
// the wrong window sent triage looking days back through unrelated history.
//
// Extracted rather than left inline so the test can require() the real
// function (CLAUDE.md §15) instead of restating the arithmetic.
'use strict';

const HOUR_MS = 3_600_000;

/**
 * @param {Array<{ts: string, ok: boolean}>} attempts oldest→newest, as
 *   readDispatchAttempts() returns them.
 * @param {number} [now] epoch ms, injectable so the test is not clock-dependent.
 * @returns {{consecutiveFailures: number, streakHours: number, forHowLong: string}}
 *   `forHowLong` is display-ready: '<1h', 'Nh', or 'N days'.
 */
function summarizeFailureStreak(attempts, now = Date.now()) {
  const list = Array.isArray(attempts) ? attempts : [];

  let consecutiveFailures = 0;
  for (let i = list.length - 1; i >= 0 && list[i] && !list[i].ok; i--) consecutiveFailures++;

  if (consecutiveFailures === 0) {
    return { consecutiveFailures: 0, streakHours: 0, forHowLong: '<1h' };
  }

  const oldestInStreak = list[list.length - consecutiveFailures];
  const parsed = oldestInStreak ? new Date(oldestInStreak.ts).getTime() : NaN;
  // A malformed/absent ts must not render "NaN days" into an owner-facing
  // subject line — degrade to the unknown-duration form instead.
  const streakHours = Number.isFinite(parsed) ? Math.max(0, (now - parsed) / HOUR_MS) : 0;

  const forHowLong =
    streakHours >= 48
      ? `${Math.round(streakHours / 24)} days`
      : streakHours >= 1
        ? `${Math.round(streakHours)}h`
        : '<1h';

  return { consecutiveFailures, streakHours, forHowLong };
}

module.exports = { summarizeFailureStreak };
