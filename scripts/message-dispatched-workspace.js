#!/usr/bin/env node
/**
 * message-dispatched-workspace — find and message the LIVE cmux workspace a
 * task was auto-dispatched to, without manual `cmux list-workspaces`
 * archaeology (card #1465).
 *
 * Usage:
 *   node scripts/message-dispatched-workspace.js --task=1464 "message text"
 *   node scripts/message-dispatched-workspace.js --task=1464 --status [--lines=200]
 */

'use strict';

const { execFileSync } = require('child_process');
const { readEntries } = require('./lib/dispatch-ledger.js');
const { parseWorkspaceListing, resolveWorkspaceForTask } = require('./lib/dispatched-workspace-lookup.js');

const CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux';

function usage() {
  console.error('Usage: node scripts/message-dispatched-workspace.js --task=<id> [--status] [--lines=<n>] ["message text"]');
  process.exit(1);
}

// A raw execFileSync throw is a Node stack trace, not an actionable error —
// the cmux binary can fail transiently (surface not rendered yet, workspace
// closed mid-command) and callers of this CLI need a one-line diagnosis, not
// a crash dump.
function cmux(args) {
  try {
    return execFileSync(CMUX, args, { encoding: 'utf8' });
  } catch (err) {
    console.error(`cmux ${args.join(' ')} failed: ${err.message}`);
    process.exit(1);
  }
}

function parseArgs(argv) {
  let taskId = null;
  let status = false;
  let lines = 200;
  const rest = [];
  for (const a of argv) {
    if (a.startsWith('--task=')) taskId = a.slice('--task='.length);
    else if (a === '--status') status = true;
    else if (a.startsWith('--lines=')) lines = Number(a.slice('--lines='.length));
    else rest.push(a);
  }
  return { taskId, status, lines, message: rest.join(' ') };
}

function main() {
  const { taskId, status, lines, message } = parseArgs(process.argv.slice(2));
  if (!taskId) usage();
  if (!status && !message) usage();

  const listing = cmux(['list-workspaces']);
  const liveWorkspaces = parseWorkspaceListing(listing);
  const resolved = resolveWorkspaceForTask(taskId, readEntries(), liveWorkspaces);

  if (!resolved) {
    console.error(`No live dispatched workspace found for task #${taskId}.`);
    console.error('Checked dispatch-ledger.js openTaskWorkspaceLaunches() + a title-match fallback against `cmux list-workspaces`.');
    process.exit(1);
  }

  console.error(`task #${taskId} -> ${resolved.ref} ("${resolved.title}") [${resolved.source}]`);

  if (status) {
    const screen = cmux(['read-screen', '--workspace', resolved.ref, '--lines', String(lines)]);
    process.stdout.write(screen);
    return;
  }

  cmux(['send', '--workspace', resolved.ref, '--', message]);
  cmux(['send-key', '--workspace', resolved.ref, '--', 'enter']);
  console.error(`Sent message to ${resolved.ref}.`);
}

main();
