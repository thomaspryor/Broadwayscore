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
let total = 0;
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yml')).sort()) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  for (const violation of findMissingLedgerCommits(text)) {
    console.log(`${file}: ${violation}`);
    total += 1;
  }
}
console.log(`TOTAL VIOLATIONS: ${total}`);
process.exit(total === 0 ? 0 : 1);
