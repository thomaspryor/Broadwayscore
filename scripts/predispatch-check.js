#!/usr/bin/env node
/**
 * predispatch-check — classify a queued task's Notion card before dispatch,
 * the CLI wrapper for scripts/lib/predispatch-guard.js (task #1794, Notion
 * 3c0637c5-416f-8165-89bd-e7df0ecebe41). Replaces the scratchpad
 * predispatch-check.sh/pd_meta.py/pd_cmd.py trio every BRO-343 crown session
 * used to rebuild by hand.
 *
 * Reads the task straight out of the local task mirror (~/.claude/tasks/) and
 * resolves its Notion id via the SAME `[notion:<uuid>]` tag notionIdOf()
 * already trusts elsewhere in the fleet (dispatch-guards.js), rather than
 * shelling out to `bsc-next --dry-run` and regex-scraping its printed text —
 * that stdout-scraping shape is exactly what produced failure mode 6 in the
 * scratchpad tool (a slug-parsing regex broke on an underscore). Falls back
 * to resolveNotionUuid() over the task description only if the structured
 * tag is somehow absent.
 *
 * Usage:
 *   node scripts/predispatch-check.js --id N
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { notionIdOf } = require('./lib/dispatch-guards.js');
const { classifyCandidate, resolveNotionUuid } = require('./lib/predispatch-guard.js');

const REPO = path.join(__dirname, '..');
const LIST_ID = process.env.CLAUDE_CODE_TASK_LIST_ID || 'broadwayscore';
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', LIST_ID);

const USAGE = `predispatch-check — classify a queued task's Notion card before dispatch.

Usage:
  node scripts/predispatch-check.js --id N   classify task #N
  node scripts/predispatch-check.js --help   show this message, do nothing else

Exit code: 0 for OK-TO-DISPATCH/CHECK-FIRST, 1 for DO-NOT-DISPATCH/REOPEN-SUSPECT,
2 for a lookup failure (task or card not found).
`;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) a[k] = true;
      else { a[k] = n; i++; }
    }
  }
  return a;
}

function loadTask(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function fetchCard(uuid) {
  const out = execFileSync('node', [path.join(REPO, 'scripts', 'notion-brain.js'), 'get', uuid], { encoding: 'utf8' });
  return JSON.parse(out);
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const args = parseArgs(process.argv.slice(2));
  if (!args.id) {
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const task = loadTask(args.id);
  if (!task) {
    console.error(`predispatch-check: no local task mirror entry for #${args.id} (looked in ${TASKS_DIR})`);
    process.exit(2);
  }

  const uuid = notionIdOf(task) || resolveNotionUuid(task.description || '');
  if (!uuid) {
    console.log(`SKIP-UNKNOWN #${args.id}: no Notion id found on the task mirror entry`);
    process.exit(2);
  }

  let card;
  try {
    card = fetchCard(uuid);
  } catch (err) {
    console.error(`predispatch-check: notion-brain.js get ${uuid} failed: ${err.message}`);
    process.exit(2);
  }

  const result = classifyCandidate({ card, task });
  console.log(`${result.verdict} #${args.id} (${result.status}) ${result.name || ''}`);
  if (result.flags.length) console.log(`  flags: ${result.flags.join(', ')}`);
  if (result.acceptanceCommand) console.log(`  run first: ${result.acceptanceCommand}`);

  process.exit(result.verdict === 'DO-NOT-DISPATCH' || result.verdict === 'REOPEN-SUSPECT' ? 1 : 0);
}

if (require.main === module) main();

module.exports = { loadTask, fetchCard, TASKS_DIR };
