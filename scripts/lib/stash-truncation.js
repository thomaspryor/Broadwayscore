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

/** Same idea for binary blobs, measured in bytes. */
const MIN_BASE_BYTES_FOR_RATIO = 512;

/** Kept <= this fraction of the base file: a truncation, not an edit. */
const TRUNCATION_RATIO = 0.2;

/** Kept <= this fraction: worth a human look before applying. */
const SHRUNK_RATIO = 0.6;

function isTelemetryPath(filePath) {
  return TELEMETRY_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

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

/**
 * @param {object} file
 * @param {string} file.path                 repo-relative path
 * @param {number|null} file.stashedLines    line count in the stash tree, null if absent (deleted)
 * @param {number|null} file.baseLines       line count at the stash base, null if absent (added)
 * @param {string|null} [file.infraTier]     tier from infra-review-scope classifyPath, if any
 * @param {boolean} [file.binary]            git reports the path as undiffable
 * @param {number|null} [file.stashedBytes]  blob size in the stash tree (used when binary)
 * @param {number|null} [file.baseBytes]     blob size at the stash base (used when binary)
 * @returns {{verdict: string, severity: string, reason: string}}
 */
function classifyStashedFile(file) {
  const {
    path: filePath,
    stashedLines,
    baseLines,
    infraTier = null,
    binary = false,
    stashedBytes = null,
    baseBytes = null,
  } = file;

  if (isTelemetryPath(filePath)) {
    return {
      verdict: 'telemetry',
      severity: 'none',
      reason: 'machine-written churn under data/audit/; discardable',
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

  // Binary blobs cannot be judged by line count (a PNG "line count" is just how
  // many 0x0a bytes it happens to contain) — but they must still be judged.
  //
  // An earlier version of this file simply exempted them, and that reopened the
  // false-safe: git calls ANY file containing a NUL byte undiffable, including
  // a half-written text stub, which is exactly the shape of a truncation. A
  // single `-diff` line in .gitattributes did the same thing. So binaries fall
  // through to the SAME ratio test, measured in bytes instead of lines. A file
  // git cannot diff that also lost 99% of its bytes is more suspicious, not
  // less.
  const useBytes = binary;
  const stashedSize = useBytes ? stashedBytes : stashedLines;
  const baseSize = useBytes ? baseBytes : baseLines;
  const unit = useBytes ? 'byte' : 'line';
  const minBase = useBytes ? MIN_BASE_BYTES_FOR_RATIO : MIN_BASE_LINES_FOR_RATIO;

  if (useBytes && (typeof stashedSize !== 'number' || typeof baseSize !== 'number')) {
    // Undiffable AND unmeasurable is an unknown, and an unknown blocks.
    return {
      verdict: 'error',
      severity: 'danger',
      reason: 'binary file whose size could not be read — cannot rule out a truncation',
    };
  }

  if (baseSize >= minBase) {
    const kept = stashedSize / baseSize;
    if (kept <= TRUNCATION_RATIO) {
      return {
        verdict: 'truncated',
        severity: 'danger',
        reason:
          `${stashedSize} ${unit}(s) against ${baseSize} at the stash base ` +
          `(${formatKept(stashedSize, baseSize)} kept)${critical ? ' in a CRITICAL shared-infrastructure file' : ''}` +
          `${useBytes ? ', measured in bytes because git cannot diff it' : ''}; ` +
          'this is a truncation stub, not recoverable work — do NOT apply',
      };
    }
    if (kept <= SHRUNK_RATIO) {
      return {
        verdict: 'shrunk',
        severity: 'warn',
        reason:
          `${stashedSize} ${unit}(s) against ${baseSize} at the stash base ` +
          `(${formatKept(stashedSize, baseSize)} kept)` +
          `${useBytes ? ', measured in bytes because git cannot diff it' : ''}; ` +
          'inspect the diff before applying',
      };
    }
  }

  return {
    verdict: 'code',
    severity: critical ? 'warn' : 'info',
    reason:
      (useBytes ? 'binary file, not line-comparable; ' : '') +
      (critical
        ? 'code change to a critical shared-infrastructure file; review before applying'
        : 'ordinary code change; review before applying'),
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
  MIN_BASE_BYTES_FOR_RATIO,
  TRUNCATION_RATIO,
  SHRUNK_RATIO,
};
