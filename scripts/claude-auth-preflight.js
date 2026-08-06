#!/usr/bin/env node
/**
 * claude-auth-preflight — cheap "can a launchd job spawn `claude` right now?"
 * gate for wrapper scripts (task #1107).
 *
 * Six LaunchAgents (overhaul-driver, action-dispatcher, bsc-reconcile,
 * bway-inv-sync, claude-email-worker, weekly-retro) used to embed a session
 * OAuth token snapshot directly in their plist's EnvironmentVariables. That
 * snapshot rotates out from under automation the moment `/login` runs
 * interactively again (same root cause as task #713/#1076) — and a launchd
 * job that just spawns `claude` blind gets a 401, produces nothing, and
 * reports nothing. Measured 2026-08-06: every one of the six embedded tokens
 * was revoked, and the jobs kept firing on schedule accomplishing nothing.
 *
 * This wraps preflightAuth() (scripts/lib/claude-cli.js) — the SAME probe
 * cmux-launch.js and notion-action-poll.js already gate real launches on —
 * behind a plain exit code, so a bash wrapper or a Python worker can call it
 * as a one-line guard before spawning `claude` for real:
 *
 *   node scripts/claude-auth-preflight.js || { echo "auth broken, not running"; exit 1; }
 *
 * Deliberately does NOT page/alert — that's scripts/check-claude-auth-health.js's
 * job (task #1076/#1088), already running once daily on its own schedule.
 * Calling routeAlert from every wrapper on every tick would duplicate paging
 * and give this script a network/email dependency it doesn't need for a
 * plain "should I run" gate.
 */
'use strict';

const { preflightAuth } = require('./lib/claude-cli.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const REPAIR_STEPS = 'claude auth logout && claude auth login && claude -p "say ok"';

const USAGE = `claude-auth-preflight.js — cheap gate: can a headless \`claude\` actually authenticate right now?

Usage:
  node scripts/claude-auth-preflight.js   probe once, exit 0 (ok) or 1 (not ok)
  --help, -h                              show this message, do nothing else

Wraps preflightAuth() (scripts/lib/claude-cli.js) — the same probe cmux-launch.js
and notion-action-poll.js already gate real launches on. Call this before
spawning \`claude\` directly from a bash/python launchd wrapper so a revoked or
shadowed token aborts the job loudly instead of it running blind. Does not
alert/page — scripts/check-claude-auth-health.js does that once daily.
`;

// Pure — testable without spawning a real `claude` (CLAUDE.md rule 15: the
// decision of what to print/exit must never be re-derived in a test, only
// require()d).
function formatPreflightResult(auth) {
  if (auth && auth.ok) {
    return { exitCode: 0, message: `[claude-auth-preflight] ok (mode=${auth.mode})` };
  }
  const detail = (auth && auth.detail) || 'no working credential';
  return {
    exitCode: 1,
    message: `[claude-auth-preflight] REFUSING: claude cannot authenticate — ${detail}\n`
      + `[claude-auth-preflight] Repair: ${REPAIR_STEPS}`,
  };
}

function main(argv = process.argv.slice(2), { preflightAuthFn = preflightAuth } = {}) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const auth = preflightAuthFn({ log: msg => console.error(`[claude-auth-preflight] ${msg}`) });
  const { exitCode, message } = formatPreflightResult(auth);
  console.error(message);
  return exitCode;
}

if (require.main === module) process.exit(main());

module.exports = { main, formatPreflightResult, REPAIR_STEPS };
