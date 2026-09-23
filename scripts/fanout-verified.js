#!/usr/bin/env node
/**
 * fanout-verified.js — record that a session checked the COMBINED result of
 * two or more dispatched children (writes the `fanout-verified` ledger row
 * Gate O v2 requires before a fan-out session may CLOSE ME / IDLE).
 *
 * Owner escalation 2026-09-20 (BRO-3939): per-child LANDED lines are not the
 * same as verifying that the whole suite of things works together. This CLI
 * runs the combined check for real (safe-form command, must exit 0), refuses
 * unless every ref has landed, and appends one row naming all refs. The
 * decision is scripts/lib/fanout-verified-core.js (pure, tested).
 *
 * Usage:
 *   node scripts/fanout-verified.js --refs BRO-1,BRO-2 --verify "<safe-form command>" \
 *     --reason "<what the command exercises across the children>" [--acked-by <id>]
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const ledger = require('./lib/dispatch-ledger.js');
const { isSafeCheckCommand, explainUnsafeCheckCommand } = require('./lib/autonomous-triage-core.js');
const core = require('./lib/fanout-verified-core.js');

const REPO = '/Users/tompryor/Broadwayscore';
const VERIFY_TIMEOUT_MS = 15 * 60 * 1000;

const USAGE = `fanout-verified.js — record a real combined check across >= 2 dispatched children (the ledger row Gate O v2 reads before CLOSE ME).

Usage:
  node scripts/fanout-verified.js --refs BRO-1,BRO-2 --verify "<safe-form command>" --reason "<what it exercised across the children, >=15 chars>" [--acked-by <id>]
`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(0, eq) : a;
    const val = () => (eq > 0 ? a.slice(eq + 1) : argv[++i]);
    switch (key) {
      case '--refs': out.refs = String(val() || '').split(/[,\s]+/).filter(Boolean); break;
      case '--verify': out.verify = val(); break;
      case '--reason': out.reason = val(); break;
      case '--acked-by': out.ackedBy = val(); break;
      default: return { error: `unknown argument: ${a}` };
    }
  }
  return out;
}

function refuse(refusals) {
  console.error(`❌ REFUSED: fan-out not recorded — ${refusals.length} failed precondition(s):`);
  for (const r of refusals) console.error(`   - ${r}`);
  console.error('   Nothing was written to the dispatch ledger.');
  process.exit(1);
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); process.exit(0); }
  const args = parseArgs(argv);
  if (args.error) { console.error(args.error); console.log(USAGE); process.exit(2); }
  const ackedBy = args.ackedBy || process.env.CLAUDE_CODE_SESSION_ID || 'unknown';
  const entries = ledger.readEntries();
  const cmd = String(args.verify || '').trim();
  const verify = { cmd, safe: cmd ? isSafeCheckCommand(cmd) : false, unsafeReason: null, exitCode: null };
  if (cmd && !verify.safe) verify.unsafeReason = (explainUnsafeCheckCommand(cmd) || {}).reason || null;

  // Decide everything that does not need the run BEFORE spending the run.
  const dry = core.decideFanout({ refs: args.refs, entries, verify: { ...verify, exitCode: 0 }, reason: args.reason, ackedBy });
  if (!dry.ok) refuse(dry.refusals);

  console.error(`→ running combined check in ${REPO}: ${cmd}`);
  const run = spawnSync('bash', ['-c', cmd], { cwd: REPO, encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  verify.exitCode = run.status === null ? -1 : run.status;
  if (verify.exitCode !== 0) {
    const tail = `${run.stdout || ''}\n${run.stderr || ''}`.trim().split('\n').slice(-15).join('\n   | ');
    console.error(`   | ${tail}`);
  }
  const decision = core.decideFanout({ refs: args.refs, entries, verify, reason: args.reason, ackedBy });
  if (!decision.ok) refuse(decision.refusals);

  const written = ledger.appendEntry(decision.row); // self-stamps ts
  console.error(`→ ledger row appended: ${JSON.stringify(written)}`);
  console.log(core.formatFanoutLine(written));
}

module.exports = { parseArgs, VERIFY_TIMEOUT_MS };
if (require.main === module) main();
