#!/usr/bin/env node
// scripts/lib/drain-ledger-health.js — decide whether the Mac-side parked-issue
// drain (scripts/linear-drain-parked.js, launchd 10:30/14:30/18:30 local) is
// actually running, from the evidence it leaves behind in its own committed
// ledger.
//
// WHY THIS EXISTS — the monitor it replaces could never fire:
// .github/workflows/check-linear-drain-health.yml gated on
// `[ "$N" -gt 3 ]` where N came from the drain's `DRY RUN: N candidate(s)`
// line. But scripts/linear-drain-parked.js:445 passes `limit: cap` with
// cap = DISPATCH_CAP = 3, and scripts/lib/linear-drain-parked.js:85 does
// `.slice(0, Math.max(0, limit))` — so N <= 3 ALWAYS and `-gt 3` was dead
// code. The workflow whose entire purpose was catching silent drain
// starvation had never been able to report it.
//
// WHY NOT JUST RAISE THE CAP AND KEEP A COUNT THRESHOLD — because backlog
// SIZE is a lagging, noisy proxy for the thing we actually care about. The
// queue sat at 36 eligible when this was written, which is a normal ~4-day
// working depth at 2-3 dispatches per tick; a fixed count gate would page
// every single day and be muted within a week. What the workflow is really
// asking is "did the Mac-side drain run?", and a drain that ran leaves a
// `drain-parked-dispatch` row. That is the direct measurement.
//
// WHY BOTH SIGNALS ARE REQUIRED — ledger freshness ALONE false-positives on
// an idle queue: a drain with nothing eligible to dispatch correctly writes
// no rows, and would look identical to a drain that is not running at all.
// So this reports unhealthy only when there IS queued work AND the drain has
// recorded no dispatch for it. That conjunction is what makes the signal
// actionable rather than mutable.
//
// Same shape as scripts/check-push-ledger.js's MAX_AGE_MS (:267): an age
// threshold owned in JS next to the thing it describes, not hardcoded in
// YAML, so the cadence assumption and the constant live together.
//
// Pure — no fs, no network, no process. The ledger read and the exit code
// live in scripts/check-linear-drain-health.js (CLAUDE.md rule 15: the test
// require()s this function, it does not restate it).

'use strict';

// The launchd plist ticks at 10:30, 14:30 and 18:30 local, so the longest
// legitimate gap between two runs is the overnight one: 18:30 -> 10:30 =
// 16h. STALE_AFTER_MS is that gap plus four hours of slack, which covers a
// late-firing launchd job (memory/feedback_github_cron_delays.md documents
// 30min-3h drift as routine) without letting a genuinely dead drain hide for
// a second full day.
const STALE_AFTER_MS = 20 * 60 * 60 * 1000;

// Only a real dispatch counts as proof of life. The drain also appends
// `card-pass`/`card-fail` reconciliation rows (scripts/linear-drain-parked.js
// :419), but those are derived from the SHARED dispatch ledger and can be
// written by a run that dispatched nothing — treating them as evidence the
// drain is working is how a starved drain would look healthy.
const DISPATCH_EVENT = 'drain-parked-dispatch';

/**
 * @param {object} opts
 * @param {Array<object>} opts.ledgerEntries - parsed rows of
 *   data/audit/linear-drain-parked-ledger.jsonl, any order.
 * @param {number|null} opts.eligibleCount - how many issues the drain's own
 *   `--dry-run --cap <big>` reported as selectable right now. null means the
 *   caller could not determine it (e.g. the kill switch short-circuited the
 *   run before the count line printed), which is reported as inconclusive
 *   rather than healthy.
 * @param {number} opts.nowMs
 * @param {number} [opts.staleAfterMs]
 * @returns {{ok: boolean, status: string, reason: string, newestDispatchTs: string|null, ageMs: number|null, eligibleCount: number|null}}
 */
function assessDrainHealth({ ledgerEntries, eligibleCount, nowMs, staleAfterMs = STALE_AFTER_MS }) {
  const rows = Array.isArray(ledgerEntries) ? ledgerEntries : [];
  let newestMs = null;
  let newestTs = null;
  for (const r of rows) {
    if (!r || r.event !== DISPATCH_EVENT) continue;
    const ms = Date.parse(r.ts);
    if (!Number.isFinite(ms)) continue;
    if (newestMs === null || ms > newestMs) { newestMs = ms; newestTs = r.ts; }
  }
  const ageMs = newestMs === null ? null : nowMs - newestMs;
  const base = { newestDispatchTs: newestTs, ageMs, eligibleCount: eligibleCount == null ? null : eligibleCount };

  if (eligibleCount == null) {
    return { ok: true, status: 'inconclusive', reason: 'eligible-candidate count unavailable — cannot distinguish an idle queue from a dead drain this run', ...base };
  }
  if (eligibleCount === 0) {
    return { ok: true, status: 'idle', reason: 'nothing eligible to dispatch — a drain with an empty queue correctly writes no ledger rows', ...base };
  }
  // There IS queued work from here down, so silence is meaningful.
  if (newestMs === null) {
    return { ok: false, status: 'never-dispatched', reason: `${eligibleCount} issue(s) eligible but the drain ledger holds no ${DISPATCH_EVENT} row at all — the Mac-side drain has never recorded a dispatch`, ...base };
  }
  if (ageMs > staleAfterMs) {
    const hrs = (ageMs / 3600000).toFixed(1);
    const limit = (staleAfterMs / 3600000).toFixed(0);
    return { ok: false, status: 'stale', reason: `${eligibleCount} issue(s) eligible but the newest ${DISPATCH_EVENT} row is ${hrs}h old (limit ${limit}h, newest ${newestTs}) — the Mac-side drain (launchd) is not running, or its ledger writes are not reaching origin/main`, ...base };
  }
  const hrs = (ageMs / 3600000).toFixed(1);
  return { ok: true, status: 'healthy', reason: `${eligibleCount} issue(s) eligible and the drain last dispatched ${hrs}h ago (${newestTs})`, ...base };
}

/**
 * Parse the drain's own stdout for the uncapped candidate count. The drain
 * prints `DRY RUN: N candidate(s), no dispatch/ledger writes`
 * (scripts/linear-drain-parked.js:563). Deliberately reuses that EXISTING
 * line rather than adding a second machine-parsed log line: this workflow is
 * already the only one of 18 check-*.yml that regex-parses stdout, and
 * deepening that outlier was a design blocker on the first draft of this fix.
 * @returns {number|null}
 */
function parseEligibleCount(stdout) {
  const m = /DRY RUN:\s*(\d+)\s*candidate/.exec(String(stdout || ''));
  return m ? Number(m[1]) : null;
}

module.exports = { assessDrainHealth, parseEligibleCount, STALE_AFTER_MS, DISPATCH_EVENT };
