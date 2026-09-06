'use strict';

/**
 * Classify a single file carried by a git stash entry.
 *
 * Why this exists: `merge-worktree-to-main.sh` deliberately stashes the shared
 * main checkout's dirty tree before integrating a worktree, and those
 * `wt-integ-*` entries are deliberately NOT dropped — tests in
 * tests/unit/merge-worktree-push-verification.test.mjs assert they survive as
 * the recovery trace for another session's WIP. So the stack grows, and the
 * session-start hook tells the next session to "inspect before dropping".
 *
 * That advice is safe for telemetry churn and dangerous for anything else. On
 * 2026-09-06 the entry `wt-integ-94224` held scripts/lib/backlog-drain.js as a
 * single 37-byte line, `module.exports = { drain: () => 1 };`, against 231
 * lines on origin/main. backlog-drain.js is the session dispatch layer, so
 * APPLYING that stash to "recover" it would have replaced fleet dispatch with a
 * stub. Nothing in the repo could tell you that before you applied it.
 *
 * This module is the decision; scripts/audit-wt-integ-stashes.js is the I/O.
 */

/**
 * Paths that are pure machine-written churn — safe to discard, never work.
 *
 * `scratchpad/` deliberately does NOT belong here even though it looks like
 * scrap: it is not gitignored and carries tracked files on main today
 * (dispatch-s3-morning.sh among them). Calling it telemetry would let a stash
 * that truncates a tracked script roll up to `telemetry-only`, print "no entry
 * would destroy a file if applied" and exit 0 — the exact false-safe verdict
 * this module exists to prevent.
 */
const TELEMETRY_PREFIXES = ['data/audit/'];

/**
 * Below this many base lines a file is too small for a ratio to mean anything
 * (a 6-line file dropping to 2 is not evidence of anything).
 */
const MIN_BASE_LINES_FOR_RATIO = 20;

/** Kept <= this fraction of the base file: a truncation, not an edit. */
const TRUNCATION_RATIO = 0.2;

/** Kept <= this fraction: worth a human look before applying. */
const SHRUNK_RATIO = 0.6;

function isTelemetryPath(filePath) {
  return TELEMETRY_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

/**
 * @param {object} file
 * @param {string} file.path            repo-relative path
 * @param {number|null} file.stashedLines line count in the stash tree, or null if absent (deleted)
 * @param {number|null} file.baseLines    line count in the stash's base commit, or null if absent (added)
 * @param {string|null} [file.infraTier]  tier from infra-review-scope classifyPath, if any
 * @returns {{verdict: string, severity: string, reason: string}}
 */
/**
 * Render a kept-fraction without ever printing "0%" for a file that still has
 * content — 1 line against 231 is 0.4%, and rounding it to "0% kept" makes the
 * one evidence string an operator reads self-contradictory.
 */
function formatKept(stashedLines, baseLines) {
  const pct = (stashedLines / baseLines) * 100;
  if (pct === 0) return '0%';
  if (pct < 1) return '<1%';
  return Math.round(pct) + '%';
}

function classifyStashedFile(file) {
  const { path: filePath, stashedLines, baseLines, infraTier = null, binary = false } = file;

  if (isTelemetryPath(filePath)) {
    return {
      verdict: 'telemetry',
      severity: 'none',
      reason: 'machine-written churn (data/audit or scratchpad); discardable',
    };
  }

  const critical = infraTier === 'critical';

  if (stashedLines === null) {
    return {
      verdict: 'deleted',
      severity: critical ? 'danger' : 'warn',
      reason: critical
        ? 'stash DELETES a critical shared-infrastructure file; applying it removes that file'
        : 'stash deletes this file; applying it removes the file',
    };
  }

  if (baseLines === null) {
    return {
      verdict: 'added',
      severity: 'info',
      reason: 'new file introduced by the stash; nothing is overwritten',
    };
  }

  // Line counts are meaningless for binary blobs (a PNG "line count" is just
  // how many 0x0a bytes it happens to contain), so never ratio-judge one.
  if (binary) {
    return {
      verdict: 'code',
      severity: critical ? 'warn' : 'info',
      reason: 'binary file; not line-comparable — inspect manually before applying',
    };
  }

  if (baseLines >= MIN_BASE_LINES_FOR_RATIO) {
    const kept = stashedLines / baseLines;
    if (kept <= TRUNCATION_RATIO) {
      return {
        verdict: 'truncated',
        severity: 'danger',
        reason:
          `${stashedLines} line(s) against ${baseLines} at the stash base ` +
          `(${formatKept(stashedLines, baseLines)} kept)${critical ? ' in a CRITICAL shared-infrastructure file' : ''}; ` +
          'this is a truncation stub, not recoverable work — do NOT apply',
      };
    }
    if (kept <= SHRUNK_RATIO) {
      return {
        verdict: 'shrunk',
        severity: 'warn',
        reason:
          `${stashedLines} line(s) against ${baseLines} at the stash base ` +
          `(${formatKept(stashedLines, baseLines)} kept); inspect the diff before applying`,
      };
    }
  }

  return {
    verdict: 'code',
    severity: critical ? 'warn' : 'info',
    reason: critical
      ? 'code change to a critical shared-infrastructure file; review before applying'
      : 'ordinary code change; review before applying',
  };
}

/**
 * Roll per-file verdicts up to one verdict for a whole stash entry.
 * @param {Array<{verdict: string, severity: string}>} fileVerdicts
 */
function classifyStashEntry(fileVerdicts, options = {}) {
  const { enumerationFailed = false } = options;

  // A guard that examined NOTHING must never report what a guard that passed
  // reports. This is the failure shape the whole module is about: silence
  // reads as safety. If git could not tell us what the entry contains, that is
  // an unknown, and an unknown blocks.
  if (enumerationFailed) {
    return { verdict: 'unreadable', severity: 'danger', danger: true };
  }

  if (fileVerdicts.some((f) => f.verdict === 'error')) {
    return { verdict: 'unreadable', severity: 'danger', danger: true };
  }

  if (fileVerdicts.length === 0) {
    return { verdict: 'empty', severity: 'none', danger: false };
  }
  if (fileVerdicts.every((f) => f.verdict === 'telemetry')) {
    return { verdict: 'telemetry-only', severity: 'none', danger: false };
  }
  const danger = fileVerdicts.some((f) => f.severity === 'danger');
  if (danger) {
    return { verdict: 'dangerous-to-apply', severity: 'danger', danger: true };
  }
  if (fileVerdicts.some((f) => f.severity === 'warn')) {
    return { verdict: 'inspect', severity: 'warn', danger: false };
  }
  return { verdict: 'carries-code', severity: 'info', danger: false };
}

module.exports = {
  classifyStashedFile,
  classifyStashEntry,
  isTelemetryPath,
  formatKept,
  TELEMETRY_PREFIXES,
  MIN_BASE_LINES_FOR_RATIO,
  TRUNCATION_RATIO,
  SHRUNK_RATIO,
};
