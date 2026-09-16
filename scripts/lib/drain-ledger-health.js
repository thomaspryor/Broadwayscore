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
// KNOWN OVER-COUNT IN CI (biases toward alerting, never toward silence) —
// scripts/linear-drain-parked.js:115 hardcodes
// `const REPO = '/Users/tompryor/Broadwayscore'` and derives its LEDGER_PATH
// from it, so on a GitHub Actions runner that path is absent, the read
// degrades to [] (ENOENT is swallowed, not thrown), and the dry-run applies
// NO park or 6h-cooldown exclusions. The count CI reports is therefore >= the
// count the Mac would really select. That can page when the Mac is correctly
// idle, but only if the ledger is ALSO >20h stale, and it can never hide a
// dead drain — which is the failure this exists to catch, and the direction
// to fail in. Fixing it properly means resolving REPO from __dirname so the
// drain finds its own committed ledger; that is a dispatch-layer change
// needing its own rule-18 review, tracked as BRO-3545.
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

// How far into the future a row's timestamp may sit before the ledger is
// treated as untrustworthy rather than merely clock-skewed. Same 60s the
// sibling drain uses for the same reason (scripts/backlog-drain.js:115-117).
const MAX_FUTURE_SKEW_MS = 60_000;

// KNOWN LIMIT — this answers "did the drain RUN?", NOT "did its dispatches
// SUCCEED". A `drain-parked-dispatch` row is written at the attempt
// (scripts/linear-drain-parked.js:~570), and the detached child can still be
// refused afterwards by linear-next.js's guard stack. A drain attempting the
// same doomed issue every tick therefore reports healthy here.
//
// That is not hypothetical: BRO-2292 was attempted on six consecutive runs,
// produced no launch on any of them, and reconciled to `card-fail` each time.
// Proving launch requires correlating against data/audit/dispatch-ledger.jsonl,
// which is gitignored and Mac-local (see scripts/lib/board-targeting-sources.js
// :59-67 — CI never sees it), so this CI-side check structurally cannot do it
// and deliberately does not pretend to. A green verdict here means "the
// launchd tick is alive and its ledger is reaching origin/main"; success rate
// is a separate, Mac-side question. Tracked as BRO-3544.

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
  const rawAgeMs = newestMs === null ? null : nowMs - newestMs;
  // Clamp ordinary skew to 0 so a row written seconds "ahead" still reads as
  // brand new rather than as a negative age flowing into the staleness test.
  const ageMs = rawAgeMs === null ? null : Math.max(0, rawAgeMs);
  const base = { newestDispatchTs: newestTs, ageMs, eligibleCount: eligibleCount == null ? null : eligibleCount };

  // A future-dated row is not evidence of a live drain, and left unhandled it
  // is the worst possible failure: one bad timestamp becomes the maximum,
  // ageMs goes NEGATIVE, `ageMs > staleAfterMs` is false, and the monitor
  // reports healthy — with "last dispatched -410.2h ago" — until that date
  // actually passes. A hand-edited ledger or a union-merge replay can produce
  // one.
  //
  // MAX_FUTURE_SKEW_MS, not zero: the rows are written on the Mac and read on
  // a GitHub runner, so a small negative age is ordinary clock disagreement,
  // not corruption — rejecting it outright would turn a one-second offset into
  // a red monitor. 60s matches the tolerance scripts/backlog-drain.js:115-117
  // already settled on for exactly this ("A future-dated ts (clock skew,
  // corrupted write) must not read as fresh forever — allow 60s of skew,
  // nothing more"). Within tolerance the age is clamped to 0 so the freshness
  // comparison below still behaves.
  //
  // Checked before the eligibleCount branches because a corrupt ledger is
  // worth surfacing whether or not there is queued work.
  if (rawAgeMs !== null && rawAgeMs < -MAX_FUTURE_SKEW_MS) {
    return { ok: false, status: 'future-dated', reason: `newest ${DISPATCH_EVENT} row is dated ${newestTs}, in the FUTURE relative to now — the ledger cannot be trusted to report drain liveness (clock skew, a hand edit, or a union-merge replay)`, ...base };
  }

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

// Every line the drain emits goes through its log() with this literal prefix,
// so anchoring to it at line start is what separates the drain's OWN summary
// from text it merely echoed. Without the anchor the count could be read out
// of an ISSUE TITLE: the dry-run preview line is
// `[linear-drain-parked] DRY RUN would dispatch BRO-N: <title>`
// (scripts/linear-drain-parked.js:538) with the title interpolated raw, and
// those lines print BEFORE the summary — so a Linear issue titled
// "... DRY RUN: 0 candidate ..." would have won a first-match search and
// silently declared the queue idle. Cards DO reference this script's
// --dry-run invocation in their text (see scripts/lib/card-arming-warning.js),
// so this is a reachable input, not a theoretical one.
const SUMMARY_RE = /^\[linear-drain-parked\] DRY RUN: (\d+) candidate/gm;

// The drain RETURNS EARLY on an empty selection (scripts/linear-drain-parked
// .js:465-468) and prints this instead — the `DRY RUN: N candidate(s)`
// summary is never reached when N would be 0. Without recognising it, a
// genuinely idle queue and a drain whose output changed shape are
// indistinguishable: both parse to null and report `inconclusive`, which
// exits 0. That would have made the idle path unreachable in CI.
const EMPTY_RE = /^\[linear-drain-parked\] no eligible parked issues this run\./m;

/**
 * Parse the drain's own stdout for the uncapped candidate count. Deliberately
 * reuses the drain's EXISTING lines rather than adding a machine-parsed log
 * line of its own: this workflow is already the only one of 18 check-*.yml
 * that regex-parses stdout, and deepening that outlier was a design blocker
 * on the first draft of this fix.
 * @returns {number|null} null means "could not determine", never "zero".
 */
function parseEligibleCount(stdout) {
  const text = String(stdout || '');
  // Last match, not first: the summary is the final thing the drain prints,
  // so even if an earlier line somehow slipped past the anchor, the real
  // summary is the one that wins.
  let last = null;
  for (const m of text.matchAll(SUMMARY_RE)) last = m;
  if (last) return Number(last[1]);
  if (EMPTY_RE.test(text)) return 0;
  return null;
}

module.exports = { assessDrainHealth, parseEligibleCount, STALE_AFTER_MS, DISPATCH_EVENT };
