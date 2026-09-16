#!/usr/bin/env node
'use strict';
// Repo-wide runner for alert-ledger-commit-check.js (BRO-3662).
//
// The checker itself is a pure function over ONE workflow's YAML; the only
// production caller is scripts/lint-workflow-guards.sh, which shells out to a
// `node -e` one-liner per file. That made "what does the whole repo look like
// right now?" an ad-hoc inline snippet every time — unquotable in a commit
// message, unverifiable in a session log, and easy to get subtly wrong.
//
// Usage: node scripts/lib/scan-alert-ledger-gaps.js
//
// Exit contract (load-bearing — callers key on it):
//   0  scanned a real tree, no violations
//   1  scanned a real tree, violations printed to stdout
//   2  could NOT scan (cannot load the checker, cannot read the dir or a file,
//      or too few workflows to be a real tree) — deliberately NOT 1, because an
//      uncaught throw exits 1 and a broken guard must never be mistaken for a
//      guard that found something.
//
// scanWorkflows() is exported so the three-way contract is unit-testable
// (CLAUDE.md rule 15) — it was previously all top-level code with no
// require.main guard, so nothing could import it and a regression in the exit
// contract would have shipped unnoticed.
const fs = require('fs');
const path = require('path');

// Below this, refuse to render a verdict at all. A workflows directory that
// EXISTS but yields almost no matches — sparse checkout, wrong tree, this file
// vendored elsewhere — would otherwise print "TOTAL VIOLATIONS: 0" and exit 0:
// a guard reporting CLEAN having scanned NOTHING, which is the exact failure
// shape this whole card is about. The repo has ~244 workflow files.
const MIN_EXPECTED_WORKFLOWS = 50;

// GitHub Actions honours BOTH extensions. Matching only .yml would let a future
// `alerting.yaml` with an unstaged-ledger routeAlert() call go unscanned while
// the scanner still printed "TOTAL VIOLATIONS: 0" — the same under-report this
// scanner exists to prevent. (No .yaml files exist today;
// scripts/lint-workflow-guards.sh has the same .yml-only glob, tracked in
// BRO-3671 as a class-level gap.)
const WORKFLOW_EXT_RE = /\.ya?ml$/;

/**
 * Scan a workflows directory. Pure-ish: does IO, but takes its directory and
 * checker as arguments and RETURNS the verdict instead of exiting, so tests can
 * drive every branch of the exit contract.
 *
 * @param {string} dir - directory of workflow files
 * @param {(text: string) => string[]} check - the checker (injected for tests)
 * @returns {{code: 0|1|2, violations: string[], scanned: number, error?: string}}
 */
function scanWorkflows(dir, check) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { code: 2, violations: [], scanned: 0, error: `could not read ${dir}: ${err.message}` };
  }

  // A symlink must be FOLLOWED to decide whether it is a file. Filtering on the
  // dirent's isFile() alone excluded every symlinked workflow (silently
  // under-reporting); accepting every symlink let one POINTING AT A DIRECTORY
  // through to readFileSync, where it throws EISDIR and — with fail-fast below,
  // over a .sort()ed list — could abort the whole scan from an early-sorting
  // name. statSync follows the link and answers the question actually being
  // asked. A broken symlink makes statSync throw, so it is skipped here and
  // cannot wedge the scan; throwIfNoEntry:false returns undefined instead.
  const files = entries
    .filter((e) => {
      if (!WORKFLOW_EXT_RE.test(e.name)) return false;
      if (e.isFile()) return true;
      if (!e.isSymbolicLink()) return false;
      try {
        return fs.statSync(path.join(dir, e.name), { throwIfNoEntry: false })?.isFile() === true;
      } catch {
        return false;
      }
    })
    .map((e) => e.name)
    .sort();

  if (files.length < MIN_EXPECTED_WORKFLOWS) {
    return {
      code: 2,
      violations: [],
      scanned: files.length,
      error:
        `refusing to report a verdict: found only ${files.length} workflow file(s) in ${dir}, ` +
        `expected at least ${MIN_EXPECTED_WORKFLOWS}. A near-empty scan would report "clean" having scanned nothing.`,
    };
  }

  const violations = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch (err) {
      return { code: 2, violations, scanned: files.length, error: `could not read ${file}: ${err.message}` };
    }
    let found;
    try {
      found = check(text);
    } catch (err) {
      return { code: 2, violations, scanned: files.length, error: `checker threw on ${file}: ${err.message}` };
    }
    for (const v of found) violations.push(`${file}: ${v}`);
  }

  return { code: violations.length === 0 ? 0 : 1, violations, scanned: files.length };
}

module.exports = { scanWorkflows, MIN_EXPECTED_WORKFLOWS, WORKFLOW_EXT_RE };

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  let findMissingLedgerCommits;
  try {
    ({ findMissingLedgerCommits } = require('./alert-ledger-commit-check.js'));
  } catch (err) {
    console.error(`could not load alert-ledger-commit-check.js: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  const result = scanWorkflows(path.join(__dirname, '..', '..', '.github', 'workflows'), findMissingLedgerCommits);
  for (const v of result.violations) console.log(v);

  if (result.code === 2) {
    // No TOTAL line on a failed scan: the count would be a PARTIAL scan's, and
    // printing it as the verdict is the same lie in a smaller shape.
    console.error(result.error);
  } else {
    console.log(`TOTAL VIOLATIONS: ${result.violations.length}`);
  }
  // process.exitCode, never process.exit(): stdout is ASYNC when piped and
  // process.exit() truncates it mid-flush. Measured at 60k lines through a pipe,
  // the TOTAL line itself was lost while the exit code stayed correct.
  process.exitCode = result.code;
}
