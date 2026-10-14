#!/usr/bin/env node
/**
 * claim-ci-red.js — CLI over scripts/lib/ci-red-claims.js, closing the
 * evaluateCiRedClaim wiring gap left by task #542/#584: a session can now
 * check "is another in_progress task already fixing this CI red" against a
 * real file, and record its own claim, before pushing a fix.
 *
 * Usage:
 *   node scripts/claim-ci-red.js claim --task <taskId> [--symbol <name>] [--run-id <id>]
 *   node scripts/claim-ci-red.js check [--symbol <name>] [--run-id <id>] [--own-task <taskId>]
 *     Exit 0 + ALLOW: ... when no OTHER in_progress task claims it.
 *     Exit 1 + REFUSE: ... when another in_progress task already claims it.
 *     Exit 3 + ERROR: ... for anything unexpected (never surfaces as REFUSE —
 *     same crash-vs-refuse separation as scripts/check-worktree-collision.js).
 *
 * Pass --own-task <taskId> to `check` if you already called `claim` yourself
 * for this symbol/run — without it, your own prior claim looks identical to
 * someone else's and you'll get a false REFUSE against yourself (adversarial
 * review finding, task #584).
 */

'use strict';

const { hasHelpFlag } = require('./lib/cli-help');
const { appendClaim, activeClaimsAsTasks } = require('./lib/ci-red-claims');
const { evaluateCiRedClaim } = require('./lib/duplicate-dispatch-guard');

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') out.task = argv[++i];
    else if (a === '--symbol') out.symbol = argv[++i];
    else if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--own-task') out.ownTask = argv[++i];
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    console.log(
      'usage:\n' +
      '  node scripts/claim-ci-red.js claim --task <taskId> [--symbol <name>] [--run-id <id>]\n' +
      '  node scripts/claim-ci-red.js check [--symbol <name>] [--run-id <id>] [--own-task <taskId>]'
    );
    process.exit(0);
    return;
  }

  const [sub, ...rest] = argv;
  const flags = parseFlags(rest);

  if (sub === 'claim') {
    if (!flags.task) { console.error('claim requires --task <taskId>'); process.exit(2); return; }
    const entry = appendClaim({ symbol: flags.symbol || null, runId: flags.runId || null, taskId: flags.task });
    console.log(`CLAIMED: ${JSON.stringify(entry)}`);
    process.exit(0);
    return;
  }

  if (sub === 'check') {
    if (!flags.symbol && !flags.runId) { console.error('check requires --symbol and/or --run-id'); process.exit(2); return; }
    const claims = activeClaimsAsTasks(undefined, undefined, flags.ownTask || null);
    const verdict = evaluateCiRedClaim({ symbol: flags.symbol, runId: flags.runId }, claims);
    console.log(`${verdict.allow ? 'ALLOW' : 'REFUSE'}: ${verdict.reason}`);
    process.exit(verdict.allow ? 0 : 1);
    return;
  }

  console.error('usage: claim-ci-red.js <claim|check> ... (--help for details)');
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.log(`ERROR: ${err && err.message}`);
    process.exit(3);
  }
}

module.exports = { parseFlags };
