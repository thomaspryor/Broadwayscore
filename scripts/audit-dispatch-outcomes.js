#!/usr/bin/env node
/**
 * audit-dispatch-outcomes.js — the owner of "did dispatched work actually land?"
 *
 * Nothing owned this before (owner escalation 2026-08-05). Evidence:
 *   - autonomous-acceptance-recheck.js queries `--status Done,Paused` only, so a
 *     dispatch that died mid-flight is invisible to it forever.
 *   - the supervisor-SESSION answer was tried four times and rotted: #696, #706,
 *     #708, #877 were all appointed to "verify live workspaces" and are all still
 *     `in_progress` weeks later. A session cannot own something that outlives it.
 * First real run found 37 abandoned dispatches, including #1002 ("Drive main to
 * GREEN") — dispatched, workspace gone, card never closed, nobody noticed.
 *
 * Usage:
 *   node scripts/audit-dispatch-outcomes.js            summary + abandoned list
 *   node scripts/audit-dispatch-outcomes.js --json     machine-readable
 *   --help, -h
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { classifyCmuxError } = require('./lib/cmux-socket-auth.js');
const { classifyDispatches, OUTCOMES } = require('./lib/dispatch-outcome.js');

const USAGE = `audit-dispatch-outcomes.js — did dispatched work land?

Usage:
  node scripts/audit-dispatch-outcomes.js          summary + abandoned list
  node scripts/audit-dispatch-outcomes.js --json   machine-readable
  --help, -h   show this message, do nothing else
`;

const REPO = '/Users/tompryor/Broadwayscore';
const LIST_ID = process.env.CLAUDE_CODE_TASK_LIST_ID || 'broadwayscore';

/**
 * MUST union live + archive/. task-store-archive.js moves COMPLETED cards into
 * archive/, so reading only the live dir makes finished work look unfinished —
 * which on the first run of this very script reported 317 false "abandoned"
 * instead of the true 37. That is the #1075 class (a check that cannot observe
 * its subject reports a confident wrong verdict), and it bit the script written
 * to catch exactly that class. Do not "simplify" this to one directory.
 */
function loadTasksUnioned() {
  const base = path.join(os.homedir(), '.claude', 'tasks', LIST_ID);
  const tasks = new Map();
  for (const dir of [base, path.join(base, 'archive')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(n => /^\d+\.json$/.test(n))) {
      try {
        const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        // archive wins on completed: it is the terminal record.
        if (!tasks.has(String(t.id)) || t.status === 'completed') tasks.set(String(t.id), t);
      } catch { /* skip unreadable */ }
    }
  }
  if (tasks.size === 0) throw new Error(`no tasks readable under ${base} — refusing to report (would call every dispatch abandoned)`);
  return tasks;
}

// cmux-workspaces.js is the shared, tested cmux-liveness abstraction — the same
// one health-check.js:2775 reuses "rather than re-parsing `cmux list-workspaces`
// a second way". This used to shell out to a bare `cmux` on PATH with no socket
// credential, no stderr, and its own copy of the workspace:N regex, which broke
// three ways at once (BRO-3001): under launchd `cmux` is not on PATH; under any
// non-ancestry socket mode the call is rejected outright; and the discarded
// stderr made both look identical to "cmux isn't running".
//
// Returning null on ANY doubt is the point — classifyDispatches treats a missing
// set as "don't judge liveness at all" and falls back to the ledger.
function liveWorkspaceRefs() {
  try {
    const { cmuxAvailable, listWorkspaces } = require('./lib/cmux-workspaces.js');
    if (!cmuxAvailable()) return null;
    const refs = listWorkspaces().map(w => w.ref).filter(Boolean);
    // An EMPTY result is treated the same as cmux being unavailable (the
    // #1106 vacuous-gate class). listWorkspaces() returns [] on a daemon
    // hiccup or malformed output rather than throwing, and an empty Set is
    // still TRUTHY — so it would sail through the `live ? {...} : {}` guard
    // below and make dispatch-outcome.js's `!live.has(ref)` true for every
    // launch at once, reporting the entire in-flight fleet ABANDONED off one
    // bad read. health-check.js:2773 already guards its mirror of this call
    // with `refs.length > 0`, and its comment claims THIS helper's "never
    // guess" rule governs there — it did not; the rule was in the comment
    // only. Now it is in the code.
    return refs.length > 0 ? new Set(refs) : null;
  } catch (e) {
    // Say WHY. A silent degrade to ledger-only is how an auth rejection hid
    // for two hours on 2026-09-07: the audit kept reporting, just blind.
    console.error(`[audit-dispatch-outcomes] cmux liveness unavailable (${classifyCmuxError(e)}) — falling back to ledger-only: ${e.message}`);
    return null;
  }
}

function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const asJson = argv.includes('--json');

  const raw = fs.readFileSync(path.join(REPO, 'data', 'audit', 'dispatch-ledger.jsonl'), 'utf8');
  const entries = raw.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const tasks = loadTasksUnioned();
  const live = liveWorkspaceRefs();

  const results = classifyDispatches(entries, tasks, live ? { liveWorkspaceRefs: live } : {});
  const counts = {};
  for (const r of results) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
  const abandoned = results
    .filter(r => r.outcome === OUTCOMES.ABANDONED)
    .sort((a, b) => new Date(b.launchedAt || 0) - new Date(a.launchedAt || 0));

  if (asJson) {
    console.log(JSON.stringify({ counts, abandoned, cmuxObserved: !!live }, null, 2));
    return 0;
  }

  console.log(`dispatch outcomes: ${JSON.stringify(counts)}${live ? '' : '  (cmux unavailable — ledger-only)'}`);
  if (!abandoned.length) { console.log('no abandoned dispatches — everything landed or is in flight'); return 0; }
  console.log(`\n${abandoned.length} ABANDONED (dispatched, workspace gone, card never completed):`);
  for (const a of abandoned.slice(0, 20)) {
    console.log(`  #${a.taskId}  ${(a.launchedAt || '').slice(0, 10)}  ${(a.subject || '').slice(0, 60)}`);
  }
  if (abandoned.length > 20) console.log(`  … and ${abandoned.length - 20} more (--json for all)`);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { main, loadTasksUnioned, USAGE };
