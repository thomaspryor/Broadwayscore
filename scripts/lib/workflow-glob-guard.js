'use strict';
/**
 * Shared floor guard for every lint-workflow-guards.sh check_* function that
 * scans `.github/workflows/*.yml` (BRO-3686).
 *
 * BRO-3684 fixed exactly ONE call site (check_alert_ledger_commit) for the
 * failure where `fs.readdirSync(dir).filter(f => f.endsWith('.yml'))` against
 * an empty or wrong-cwd `.github/workflows` just makes the `for` loop run
 * zero times — `any` stays false and the check prints `__CLEAN__` having
 * scanned nothing. check_ledger_coverage, check_ledger_step_guard and
 * check_swallowed_audit_writers reimplemented the identical readdirSync+filter
 * line with no floor, so the fix never reached them. Centralizing the
 * read-and-check-the-floor step here means the next new check that globs
 * .github/workflows can't reintroduce this gap by copy-pasting the unguarded
 * one-liner again.
 *
 * Reuses scan-alert-ledger-gaps.js's MIN_EXPECTED_WORKFLOWS rather than a
 * second hardcoded number — see that file's header for why 50 was chosen
 * (a "is this a real workflow tree at all" sanity floor, not a completeness
 * check).
 */
const fs = require('fs');
const { MIN_EXPECTED_WORKFLOWS } = require('./scan-alert-ledger-gaps.js');

const TOO_FEW_WORKFLOWS_PREFIX = '__TOO_FEW_WORKFLOWS__:';

/**
 * @param {string} dir - directory of workflow files (e.g. '.github/workflows')
 * @returns {string[]} the `.yml` filenames in dir
 * @throws {Error} message `${TOO_FEW_WORKFLOWS_PREFIX}${count}` if dir yields
 *   fewer than MIN_EXPECTED_WORKFLOWS files — callers must treat this as
 *   "refuse to report a verdict", never as a clean scan.
 */
function readWorkflowFilesOrFailClosed(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml'));
  if (files.length < MIN_EXPECTED_WORKFLOWS) {
    throw new Error(TOO_FEW_WORKFLOWS_PREFIX + files.length);
  }
  return files;
}

module.exports = { readWorkflowFilesOrFailClosed, TOO_FEW_WORKFLOWS_PREFIX, MIN_EXPECTED_WORKFLOWS };
