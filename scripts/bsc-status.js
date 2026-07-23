#!/usr/bin/env node
/**
 * bsc-status — one-glance answer to "what is every cmux tab doing, which are
 * safe to close, and what did the tabs that already vanished ship?"
 *
 * Owner pain (2026-07-22 night): the overnight loop spins up tabs, finished
 * tabs get reaped after their claude exits (taking the wrap-up with them),
 * and the owner had to open every remaining tab to judge its state. This
 * prints, read-only:
 *
 *   1. Open workspaces — verdict per tab (SAFE TO CLOSE / WORKING / DONE
 *      still open / DIED un-marked), with dispatch-ledger task attribution.
 *   2. Recently finished sessions (default 24h) whose tab may already be
 *      gone — session label + the final "SAFE TO EXIT — …" wrap-up line,
 *      recovered from the jsonl transcripts that survive tab closure.
 *
 * Never closes, marks, or dispatches anything. Closing stays owner-run via
 * bsc-prune (feedback_never_close_unmarked_cmux_workspaces).
 *
 *   bsc-status                 both sections, 24h window
 *   bsc-status --hours=48      widen the finished-sessions window
 *   bsc-status --help, -h      usage only, no cmux/fs side effects
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const {
  cmuxAvailable, listWorkspaces, isDoneTitle, claudeAliveIn,
} = require('./lib/cmux-workspaces.js');
const {
  parseJsonLines, firstUserMessage, sessionLabel, finalAssistantText,
  statusLine, workspaceVerdict,
} = require('./lib/session-wrapups.js');
const { hasHelpFlag } = require('./lib/cli-help.js');
const dispatchLedger = require('./lib/dispatch-ledger.js');

const USAGE = `bsc-status — one-glance status of every cmux tab + recently finished sessions.

Usage:
  bsc-status                 open-workspace verdicts + finished sessions (24h)
  bsc-status --hours=48      widen the finished-sessions window
  bsc-status --help, -h      show this message, do nothing else

Read-only: never closes, marks, or dispatches anything.
`;

// Same hardcoded-repo rationale as dispatch-ledger.js: this is an owner tool
// routinely run from inside a worktree, and the transcript dir is keyed to
// the MAIN repo cwd.
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects', '-Users-tompryor-Broadwayscore');

// Transcripts run 5-50MB; the label lives in the head and the wrap-up in the
// tail, so bounded reads keep a 40-file scan under a second.
const HEAD_BYTES = 96 * 1024;
const TAIL_BYTES = 512 * 1024;

function readSlice(file, position, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, position);
    return buf.toString('utf8', 0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function transcriptSummary(file) {
  const size = fs.statSync(file).size;
  const head = parseJsonLines(readSlice(file, 0, Math.min(HEAD_BYTES, size)));
  const tail = size > TAIL_BYTES
    ? parseJsonLines(readSlice(file, size - TAIL_BYTES, TAIL_BYTES))
    : head.concat(parseJsonLines(readSlice(file, Math.min(HEAD_BYTES, size), Math.max(0, size - HEAD_BYTES))));
  const final = finalAssistantText(tail);
  return {
    label: sessionLabel(firstUserMessage(head)),
    status: statusLine(final),
  };
}

// Session ids with a live claude process — those sessions still own an open
// tab and are covered by the workspace section, not "finished".
function liveSessionIds(psOutput) {
  const ids = new Set();
  const re = /--(?:session-id|resume)[ =]([0-9a-f-]{36})/g;
  let m;
  while ((m = re.exec(String(psOutput)))) ids.add(m[1]);
  return ids;
}

function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const hoursArg = argv.find(a => a.startsWith('--hours='));
  const hours = hoursArg ? Math.max(1, Number(hoursArg.split('=')[1]) || 24) : 24;

  // ── 1. Open workspaces ────────────────────────────────────────────────
  if (cmuxAvailable()) {
    let ledgerEntries = [];
    try { ledgerEntries = dispatchLedger.readEntries(); } catch { /* ledger optional */ }
    const workspaces = listWorkspaces();
    console.log(`Open cmux workspaces (${workspaces.length}):\n`);
    const rows = workspaces.map(w => {
      const done = isDoneTitle(w.title);
      const alive = claudeAliveIn(w.ref);
      const launch = dispatchLedger.launchByRef(w.ref, ledgerEntries);
      return {
        verdict: workspaceVerdict({ done, alive }),
        ref: w.ref,
        title: w.title,
        task: launch ? `task #${launch.taskId}` : '',
      };
    });
    // Actionable first: closable, then dead-needs-review, then working.
    const order = v => v.startsWith('SAFE') ? 0 : v.startsWith('IDLE') ? 1 : v.startsWith('DONE') ? 2 : 3;
    rows.sort((a, b) => order(a.verdict) - order(b.verdict));
    for (const r of rows) {
      console.log(`  [${r.verdict}] ${r.ref}  ${r.title}${r.task ? `  (${r.task})` : ''}`);
    }
  } else {
    console.log('cmux CLI not found — skipping workspace section.');
  }

  // ── 2. Recently finished sessions (tab may be gone) ───────────────────
  let files = [];
  try {
    const cutoff = Date.now() - hours * 3600 * 1000;
    files = fs.readdirSync(PROJECTS_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, full: path.join(PROJECTS_DIR, f), mtime: fs.statSync(path.join(PROJECTS_DIR, f)).mtimeMs }))
      .filter(e => e.mtime >= cutoff)
      .sort((a, b) => b.mtime - a.mtime);
  } catch (e) {
    console.log(`\n(no transcript dir at ${PROJECTS_DIR}: ${e.message})`);
    return;
  }

  let live = new Set();
  try { live = liveSessionIds(execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })); }
  catch { /* ps failure → show everything rather than hide */ }

  const finished = files.filter(e => !live.has(e.f.replace(/\.jsonl$/, '')));
  console.log(`\nFinished sessions, last ${hours}h — tabs may already be closed (${finished.length}):\n`);
  for (const e of finished) {
    let s;
    try { s = transcriptSummary(e.full); } catch (err) { s = { label: e.f, status: `(unreadable: ${err.message})` }; }
    if (!s.label && !s.status) continue; // empty shell transcript
    const when = new Date(e.mtime).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    console.log(`  ${when}  ${s.label || '(no prompt)'}`);
    console.log(`          ${s.status || '(no SESSION STATUS line — ended without wrap-up)'}`);
  }
  console.log('\nClose ✅ tabs in bulk with: node scripts/bsc-prune.js  (owner-run only)');
}

if (require.main === module) main();

module.exports = { main, USAGE };
