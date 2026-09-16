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
const { findMissingLedgerCommits } = require('./alert-ledger-commit-check.js');

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
// withFileTypes + isFile(): a DIRECTORY named `something.yml` would otherwise
// be passed to readFileSync and throw EISDIR.
const files = entries
  .filter((e) => e.isFile() && e.name.endsWith('.yml'))
  .map((e) => e.name)
  .sort();

let total = 0;
for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, file), 'utf8');
  } catch (err) {
    console.error(`could not read ${file}: ${err.message}`);
    process.exit(2);
  }
  let violations;
  try {
    violations = findMissingLedgerCommits(text);
  } catch (err) {
    console.error(`checker threw on ${file}: ${err.message}`);
    process.exit(2);
  }
  for (const violation of violations) {
    console.log(`${file}: ${violation}`);
    total += 1;
  }
}
console.log(`TOTAL VIOLATIONS: ${total}`);
process.exit(total === 0 ? 0 : 1);
