#!/usr/bin/env node
// scripts/check-linear-drain-health.js — CI-side liveness check for the
// Mac-side parked-issue drain (scripts/linear-drain-parked.js).
//
// Replaces the stdout-grep gate that lived inline in
// .github/workflows/check-linear-drain-health.yml, which could never fire —
// see scripts/lib/drain-ledger-health.js's header for the full why. Follows
// the shape every other check-*.yml in this repo already uses
// (check-push-ledger.yml, check-arm-yield.yml, check-flag-parity.yml): a
// script that owns its own threshold and exits non-zero, rather than YAML
// regex-parsing a number out of another script's log line.
//
// Reads only committed state (data/audit/linear-drain-parked-ledger.jsonl),
// so it needs no Linear credentials of its own. The eligible-candidate count
// comes from the workflow's existing `--dry-run` step, piped in via --eligible
// or stdin.
//
// Exit 0 healthy/idle/inconclusive, 1 unhealthy, 2 bad usage.

'use strict';

const fs = require('fs');
const path = require('path');
const { assessDrainHealth, parseEligibleCount } = require('./lib/drain-ledger-health.js');

const REPO = path.resolve(__dirname, '..');
const LEDGER_PATH = path.join(REPO, 'data/audit/linear-drain-parked-ledger.jsonl');

const USAGE = `check-linear-drain-health.js — is the Mac-side parked-issue drain actually running?

Usage:
  node scripts/check-linear-drain-health.js --eligible N
  node scripts/linear-drain-parked.js --dry-run --cap 1000 | node scripts/check-linear-drain-health.js

  --eligible N   how many issues the drain currently reports as selectable.
                 Omit it to parse the drain's own "DRY RUN: N candidate(s)"
                 line from stdin instead.
  --ledger PATH  override the drain ledger (default data/audit/linear-drain-parked-ledger.jsonl)
  --help, -h     show this message

Exits 1 when there IS queued work and the drain has recorded no dispatch for
it inside the staleness window. Both conditions are required: an idle queue
correctly produces no ledger rows and must not page anyone.
`;

function readLedger(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn append is not a reason to fail the monitor */ }
  }
  return out;
}

function readStdin() {
  if (process.stdin.isTTY) return '';
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return 0; }

  let ledgerPath = LEDGER_PATH;
  let eligible = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--eligible') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 0) {
        console.error(`check-linear-drain-health: --eligible needs a non-negative integer, got ${JSON.stringify(argv[i + 1])}`);
        return 2;
      }
      eligible = n; i++;
    } else if (argv[i] === '--ledger') {
      ledgerPath = argv[i + 1]; i++;
    }
  }

  if (eligible === null) eligible = parseEligibleCount(readStdin());

  const verdict = assessDrainHealth({
    ledgerEntries: readLedger(ledgerPath),
    eligibleCount: eligible,
    nowMs: Date.now(),
  });

  console.log(`check-linear-drain-health: ${verdict.status} — ${verdict.reason}`);
  if (!verdict.ok) {
    console.log('::warning::linear-drain-parked.js is not dispatching: ' + verdict.reason);
    console.log('Investigate: tail -40 /tmp/linear-drain-parked-launchd.log; launchctl print gui/$(id -u)/com.broadwayscore.linear-drain-parked');
    return 1;
  }
  return 0;
}

module.exports = { readLedger };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
