#!/usr/bin/env node
/**
 * relaunch-claude-tab — the sanctioned way for an AGENT session to restart
 * the claude in another cmux tab (BRO-4065).
 *
 * Never launch claude for another tab from your own Bash tool (`claude
 * --resume`, `script -q /dev/null cmux restore ...`, `cmux respawn-pane`):
 * Claude Code strips CLAUDE_CODE_OAUTH_TOKEN from its Bash env and the
 * keychain login is purged every 5 min, so that claude comes up
 * "Not logged in" (BRO-4056). This stops the tab's claude and resumes the
 * same session INSIDE the tab's own shell via scripts/lib/relaunch-claude-tab.sh,
 * then confirms the normal prompt is back. Same code path the
 * cmux-auth-stall-watchdog uses to auto-heal.
 *
 *   node scripts/relaunch-claude-tab.js --workspace workspace:N            logged-out tabs only
 *   node scripts/relaunch-claude-tab.js --workspace workspace:N --dry-run  show what would be typed
 *   node scripts/relaunch-claude-tab.js --workspace workspace:N --even-if-logged-in
 *
 * Refuses busy tabs, and tabs whose claude isn't sitting directly in an
 * interactive shell. Exit 0 = healed (or dry-run), 1 = not healed, 2 = usage.
 */
'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');
const { healTab } = require('./lib/claude-tab-relaunch.js');

const USAGE = `relaunch-claude-tab — restart a cmux tab's claude in its own shell, with the login token.

Usage:
  node scripts/relaunch-claude-tab.js --workspace workspace:N [--dry-run] [--even-if-logged-in] [--allow-fresh]

  --dry-run             print the command that would be typed; change nothing
  --even-if-logged-in   also relaunch a tab that is not showing a lost-login screen
                        (still refuses a busy tab)
  --allow-fresh         if the session has nothing saved to resume, start a fresh claude
                        in the same folder instead of refusing
`;

function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const i = argv.indexOf('--workspace');
  const ref = i >= 0 ? argv[i + 1] : null;
  if (!ref || !/^workspace:\S+$/.test(ref)) { console.error(USAGE); return 2; }
  const result = healTab(ref, {
    dryRun: argv.includes('--dry-run'),
    requireLoggedOut: !argv.includes('--even-if-logged-in'),
    allowFresh: argv.includes('--allow-fresh'),
  });
  console.log(JSON.stringify({ ref, ...result }, null, 2));
  return result.healed || result.reason === 'dry-run' ? 0 : 1;
}

if (require.main === module) process.exit(main());

module.exports = { main, USAGE };
