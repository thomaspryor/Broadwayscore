#!/usr/bin/env node
/** PreToolUse hook entry for create_session (BRO-6684): stdin = hook JSON, stdout = deny JSON or nothing. Always exits 0. */
'use strict';
const { hasHelpFlag } = require('./lib/cli-help.js');
const lib = require('./lib/opus-launch-check.js');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: opus-launch-check-hook.js < hook-input.json   (PreToolUse hook for create_session, BRO-6684; fails open, always exits 0)');
  process.exit(0);
}

(async () => {
  try {
    const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    if (!lib.isOpus(input && input.tool_input && input.tool_input.model)) process.exit(0);
    require('./lib/load-env').loadEnv();
    const deps = {
      getIssue: (id) => require('./lib/linear-client.js').getIssue(id),
      loadBudget: () => require('./lib/opus-budget.js').loadOpusBudget(),
    };
    const out = lib.toHookOutput(await lib.evaluateWithDeadline(input, deps));
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  } catch { /* fail open */ }
  process.exit(0);
})();
