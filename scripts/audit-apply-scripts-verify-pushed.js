#!/usr/bin/env node

/**
 * Advisory scan (BRO-3954): lists every top-level scripts/*.js file that
 * supports --apply and writes review-text JSON via safeWriteReview() but
 * does NOT require scripts/lib/verify-review-texts-pushed.js — the shared
 * helper that would have caught the BRO-3862 incident (a --apply write
 * landed on local disk, the session claimed verified+pushed, and the data
 * repo never received it).
 *
 * Wraps main() in try/catch and always exits 0 — same "advisory can't turn
 * into an accidental hard gate" shape as scripts/audit-push-retry-budgets.js.
 * The gap this reports is real but pre-existing across ~30 scripts (only
 * audit-review-type-wrong-show.js, the incident script, has been wired so
 * far) — failing CI on it would block unrelated PRs on already-triaged debt
 * instead of raising visibility, the same call test.yml's push-retry-budgets
 * step comment already documents for its own advisory scan.
 *
 * Usage:
 *   node scripts/audit-apply-scripts-verify-pushed.js [--json]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { scanApplyScriptsForVerifyGap } = require('./lib/apply-scripts-verify-pushed-scan');

const USAGE = `audit-apply-scripts-verify-pushed.js — advisory: which --apply scripts writing review-texts lack the BRO-3954 verify-pushed helper (scripts/lib/verify-review-texts-pushed.js)

Usage:
  node scripts/audit-apply-scripts-verify-pushed.js [--json]
`;

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');

function loadTopLevelScripts() {
  const entries = fs.readdirSync(SCRIPTS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.js') && !e.name.endsWith('.test.mjs'))
    .map((e) => {
      const filePath = path.join(SCRIPTS_DIR, e.name);
      return { path: `scripts/${e.name}`, content: fs.readFileSync(filePath, 'utf8') };
    });
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const json = argv.includes('--json');

  const files = loadTopLevelScripts();
  const { scanned, flagged } = scanApplyScriptsForVerifyGap(files);

  if (json) {
    console.log(JSON.stringify({ scanned, count: flagged.length, flagged }, null, 2));
    return;
  }

  console.log(`Apply-scripts verify-pushed scan: ${scanned} top-level scripts/*.js file(s) scanned, ${flagged.length} lack the BRO-3954 push-verification helper.`);
  for (const f of flagged) console.log(`  ${f.path}`);
  if (flagged.length > 0) {
    console.log('\nEach of these supports --apply and writes review-text JSON via safeWriteReview() but does not');
    console.log('require scripts/lib/verify-review-texts-pushed.js. See scripts/audit-review-type-wrong-show.js for');
    console.log('the wired reference implementation (--verify-pushed flag reads the applied hits back and diffs');
    console.log('them against origin/main before a session may report the fix done).');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`audit-apply-scripts-verify-pushed.js crashed (advisory only, not failing the build): ${e.message}`);
  }
}

module.exports = { main, loadTopLevelScripts };
