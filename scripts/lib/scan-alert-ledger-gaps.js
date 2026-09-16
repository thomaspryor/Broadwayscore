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
// Exits 0 when clean, 1 when any workflow has a violation (prints each).
const fs = require('fs');
const path = require('path');

// Loading the checker is inside the exit-2 boundary too (review finding): a
// missing, unreadable or syntactically broken alert-ledger-commit-check.js
// would otherwise throw at require time and exit 1 — indistinguishable from
// "violations found", i.e. a broken guard would look like a real finding.
let findMissingLedgerCommits;
try {
  ({ findMissingLedgerCommits } = require('./alert-ledger-commit-check.js'));
} catch (err) {
  console.error(`could not load alert-ledger-commit-check.js: ${err.message}`);
  process.exit(2);
}

const dir = path.join(__dirname, '..', '..', '.github', 'workflows');

// Exit codes are load-bearing: 0 clean, 1 violations, 2 could-not-scan. An
// uncaught throw exits 1, which would be READ AS "violations found" by anything
// checking the status — so every read below is caught and routed to 2 instead
// (review finding). The path is __dirname-relative, so this cannot be caused by
// the caller's cwd; a failure here means the tree is genuinely not scannable.
let entries;
try {
  entries = fs.readdirSync(dir, { withFileTypes: true });
} catch (err) {
  console.error(`could not read ${dir}: ${err.message}`);
  process.exit(2);
}
// withFileTypes excludes a DIRECTORY named `something.yml`, which would
// otherwise reach readFileSync and throw EISDIR. Symlinks are deliberately
// INCLUDED (review finding): a plain readdirSync would have followed them, and
// silently skipping a symlinked workflow would under-report violations — the
// one failure mode this scanner must not have. A broken symlink then fails the
// read below and exits 2 (cannot scan), which is the honest answer.
const files = entries
  .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith('.yml'))
  .map((e) => e.name)
  .sort();

// Scan floor (review finding). Without it, a directory that EXISTS but yields
// no .yml entries — sparse checkout, or this file vendored somewhere else —
// prints "TOTAL VIOLATIONS: 0" and exits 0: a guard reporting CLEAN having
// scanned nothing. That is the exact failure shape this whole card is about, so
// it must be loud. Mirrors the colocated test's own `files.length > 50` sanity
// assert; the repo has ~244 workflow files, so 50 is far below any real floor.
const MIN_EXPECTED_WORKFLOWS = 50;
if (files.length < MIN_EXPECTED_WORKFLOWS) {
  console.error(
    `refusing to report a verdict: found only ${files.length} .yml file(s) in ${dir}, ` +
      `expected at least ${MIN_EXPECTED_WORKFLOWS}. A near-empty scan would report "clean" having scanned nothing.`
  );
  process.exit(2);
}

// Exit via process.exitCode, NOT process.exit(): stdout is ASYNC when piped, and
// process.exit() truncates it mid-flush. Measured at 60k lines through a pipe,
// the TOTAL line itself was lost while the exit code stayed correct — a caller
// reading stdout would have seen a partial list with no terminator.
let total = 0;
let fatal = 0;
for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, file), 'utf8');
  } catch (err) {
    console.error(`could not read ${file}: ${err.message}`);
    fatal = 2;
    break;
  }
  let violations;
  try {
    violations = findMissingLedgerCommits(text);
  } catch (err) {
    console.error(`checker threw on ${file}: ${err.message}`);
    fatal = 2;
    break;
  }
  for (const violation of violations) {
    console.log(`${file}: ${violation}`);
    total += 1;
  }
}

if (fatal) {
  // No TOTAL line on a fatal: the count would be a partial scan's count, and
  // printing it as if it were the verdict is exactly the lie to avoid.
  process.exitCode = fatal;
} else {
  console.log(`TOTAL VIOLATIONS: ${total}`);
  process.exitCode = total === 0 ? 0 : 1;
}
