#!/usr/bin/env node
/** PreToolUse hook entry (BRO-6088): stdin = hook JSON, stdout = hook JSON or nothing. Always exits 0. */
'use strict';
const { execFileSync } = require('child_process');
const lib = require('./lib/plan-only-create-session');
const { fetchCard, startReminder } = require('./coordinator-check');

(async () => {
  try {
    const raw = require('fs').readFileSync(0, 'utf8');
    const input = JSON.parse(raw);
    let branch = '';
    try { branch = execFileSync('git', ['branch', '--show-current'], { cwd: input.cwd || process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a repo */ }
    const out = lib.toHookOutput(await lib.evaluateWithDeadline(input, { fetchCard, startReminder, branch }));
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  } catch { /* fail open */ }
  process.exit(0);
})();
