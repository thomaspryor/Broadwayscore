'use strict';

/**
 * guard-escalation.js — pure decision functions for BRO-545 (pipeline
 * self-healing: auto-recovery when guards block >24h).
 *
 * Problem: a hard-blocking pipeline guard (e.g.
 * scripts/check-rebuild-staleness.js) is right to fail loudly on its FIRST
 * occurrence — a one-off race is worth flagging immediately. But if the same
 * guard blocks the SAME workflow run after run with nothing else changing,
 * failing loud forever just means reviews.json stops advancing until a human
 * happens to notice a red job and knows the override flag to pass. Nothing
 * here decides WHAT the guard checks — only how many times in a row it may
 * block before the pipeline auto-recovers instead of stalling, and what the
 * resulting alert says.
 *
 * Callers own all I/O (persisting state across CI runs, sending the actual
 * alert) — these functions take explicit state/now and return decisions, per
 * memory/feedback_test_extraction_pattern.md and the detectLauncherFailureRate
 * precedent in scripts/lib/dispatch-ledger.js (BRO-2318).
 */

const DEFAULT_ESCALATION_THRESHOLD = 2;
const DEFAULT_REMINDER_EVERY = 4;

/**
 * Guards already configured to log + write an audit trail and let the run
 * PROCEED regardless of what they find, never blocking the job:
 *   - 'review-count-regression' — rebuild-all-reviews.js's REVIEW COUNT
 *     REGRESSION GUARD (a >2% drop logs to data/audit/rebuild-regression.json
 *     and writes reviews.json anyway; --force-write only silences the log).
 *   - 'review-count-drift' — check-review-count-drift.js's default report
 *     mode (exit 0); only its --strict mode can fail a job. NOTE (found during
 *     BRO-545's /what-else pass): --strict is NOT limited to the opening-night
 *     broadcast gate as originally documented here — check-review-count-drift.yml
 *     passes it on every SCHEDULED (daily cron) run too, so that workflow's
 *     daily job can genuinely hard-exit(2) on a breach. Its escalation is
 *     `severity: 'warning'` (digest-only, no page) — the same shape BRO-545
 *     fixed for check-rebuild-staleness.js. Not fixed here (out of BRO-545's
 *     scope, a different workflow) — tracked as a follow-up.
 * Listed here as the single source of truth for that decision so a future
 * edit that accidentally reintroduces a hard block is at least documented
 * against, and so isSoftWarnGuard()/shouldAutoRecover() below have one place
 * to check membership instead of re-deriving it per caller.
 */
const SOFT_WARN_GUARDS = new Set(['review-count-regression', 'review-count-drift']);

function isSoftWarnGuard(guardId) {
  return SOFT_WARN_GUARDS.has(guardId);
}

/**
 * Advance a guard's persisted escalation state after one evaluation.
 * `priorState` is whatever the caller last saved (or null/undefined for a
 * guard with no history yet); `blocked` is whether THIS run's guard check
 * would block; `now` is an injected ms-epoch timestamp (no Date.now() inside
 * — callers pass it explicitly so this stays deterministic under test).
 *
 * A non-blocking run resets the streak to 0 — the whole point of "consecutive"
 * is that an interleaved success means the pipeline is not actually stuck.
 */
function nextGuardState(priorState, blocked, now) {
  if (!Number.isFinite(now)) throw new Error('nextGuardState requires now (ms epoch)');
  if (!blocked) {
    return { consecutiveBlocks: 0, firstBlockedAt: null, lastBlockedAt: null, lastClearedAt: now };
  }
  const priorCount = (priorState && priorState.consecutiveBlocks) || 0;
  return {
    consecutiveBlocks: priorCount + 1,
    firstBlockedAt: (priorState && priorState.firstBlockedAt) || now,
    lastBlockedAt: now,
    lastClearedAt: (priorState && priorState.lastClearedAt) || null,
  };
}

/**
 * Should a blocked guard now auto-recover (let the run proceed) instead of
 * failing the job? Soft-warn guards always answer true (they never blocked to
 * begin with). A hard guard answers true only once it has blocked `threshold`
 * runs in a row — its first block still fails loud, unchanged from today.
 */
function shouldAutoRecover(guardId, consecutiveBlocks, { threshold = DEFAULT_ESCALATION_THRESHOLD } = {}) {
  if (isSoftWarnGuard(guardId)) return true;
  return Number.isInteger(consecutiveBlocks) && consecutiveBlocks >= threshold;
}

/**
 * Should THIS evaluation actually send an escalating alert? Fires exactly at
 * `threshold`, then again every `reminderEvery` blocks past it — a real
 * multi-day outage should keep reminding, not page once and go silent.
 * Below `threshold` this is always false: a single blip never pages.
 */
function shouldEscalate(consecutiveBlocks, { threshold = DEFAULT_ESCALATION_THRESHOLD, reminderEvery = DEFAULT_REMINDER_EVERY } = {}) {
  if (!Number.isInteger(consecutiveBlocks) || consecutiveBlocks < threshold) return false;
  return (consecutiveBlocks - threshold) % reminderEvery === 0;
}

/**
 * The exact, copy-pasteable command to unblock the named workflow. One
 * function so every escalation message quotes identical text — a guard whose
 * alert names the wrong flag just wastes the responder's next ten minutes.
 */
function buildOverrideCommand({ workflowDisplayName, reason = 'Guard-escalation auto-recovery', extraFlags = [] } = {}) {
  if (!workflowDisplayName) throw new Error('buildOverrideCommand requires workflowDisplayName');
  const flags = [`-f reason="${reason}"`, ...extraFlags];
  return `gh workflow run "${workflowDisplayName}" ${flags.join(' ')}`;
}

/**
 * Builds the {title, description} pair for an escalating guard-blocked
 * alert. Pure formatting — callers decide where this text goes (email,
 * digest queue, step summary, all three).
 */
function buildGuardBlockedAlert({ guardId, guardLabel, consecutiveBlocks, threshold = DEFAULT_ESCALATION_THRESHOLD, workflowDisplayName, overrideCommand, runUrl }) {
  if (!guardId) throw new Error('buildGuardBlockedAlert requires guardId');
  if (!Number.isInteger(consecutiveBlocks)) throw new Error('buildGuardBlockedAlert requires consecutiveBlocks');
  const label = guardLabel || guardId;
  const pipeline = workflowDisplayName || 'the pipeline';
  const title = `${pipeline} blocked ${consecutiveBlocks}x in a row (${label})`;
  const lines = [
    `${label} has blocked ${consecutiveBlocks} consecutive run(s) of ${pipeline} — reviews.json has not advanced.`,
    `Auto-recovery threshold is ${threshold}: this run proceeds anyway instead of stalling further.`,
    overrideCommand ? `Manual override: ${overrideCommand}` : null,
    runUrl ? `Latest run: ${runUrl}` : null,
  ].filter(Boolean);
  return { title, description: lines.join('\n') };
}

module.exports = {
  DEFAULT_ESCALATION_THRESHOLD,
  DEFAULT_REMINDER_EVERY,
  SOFT_WARN_GUARDS,
  isSoftWarnGuard,
  nextGuardState,
  shouldAutoRecover,
  shouldEscalate,
  buildOverrideCommand,
  buildGuardBlockedAlert,
};
