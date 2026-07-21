/**
 * cmux-workspaces — shared Cmux workspace helpers for bsc-next / bsc-prune.
 *
 * Conventions (owner, 2026-07-12; closing rules tightened 2026-07-15):
 *  - A finished session retitles its own workspace with a leading ✅ (wrap-up
 *    skill / workspace-mark-done hook). The mark is visual ONLY. Closing is
 *    owner-triggered exclusively: bsc-prune (run by the owner) closes ✅-marked
 *    workspaces. Nothing closes automatically — wrap-up self-close and the
 *    bsc-next dispatch-time sweep were both removed after three same-day
 *    incidents of tabs closing while the owner was typing in them.
 *  - "Idle" = no running claude_code process in the workspace (cmux top tag).
 *    Idle but un-marked workspaces are listed, never auto-closed.
 *
 * Pure parsers are exported for tests; only the run/close/list wrappers touch
 * the cmux socket.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

const CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux';

function cmuxAvailable() {
  return fs.existsSync(CMUX);
}

function run(args) {
  return execFileSync(CMUX, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// ── pure logic (exported for tests) ────────────────────────────────────────

// Parse `cmux list-workspaces` lines:
//   "* workspace:31  Build: Autonomous nightly loop (v4)  [selected]"
//   "  workspace:2  ⠂ Box office card improvements"
function parseWorkspaces(text) {
  return String(text).split('\n').map(line => {
    const m = /^\s*(\*)?\s*(workspace:\d+)\s+(.*)$/.exec(line);
    if (!m) return null;
    const selected = Boolean(m[1]) || /\[selected\]\s*$/.test(m[3]);
    const title = m[3].replace(/\s*\[selected\]\s*$/, '').trim();
    return { ref: m[2], title, selected };
  }).filter(Boolean);
}

// The done marker must LEAD the title. cmux prepends activity glyphs
// (braille spinners ⠂/⠐, ✳) before the title in list output, so tolerate a
// few non-word prefix chars — but a ✅ later in a real title must not count.
function isDoneTitle(title) {
  return String(title).trim().slice(0, 4).includes('✅');
}

// `cmux top --workspace X --processes --format tsv` emits one row per node;
// a live Claude Code session appears as a tag row whose columns are
// cpu\trss\tproc\ttype\tid\tparent\tstatus. Column-exact match — a substring
// test would false-positive on statuses like "NotRunning" or a title
// containing "Running" (ship-check reviewer finding, 2026-07-12).
function hasRunningClaude(tsvText) {
  return String(tsvText).split('\n').some(l => {
    const c = l.split('\t');
    return c[3] === 'tag' && /:tag:claude_code$/.test(c[4] || '')
      && (c[6] || '').trim() === 'Running';
  });
}

// A claude_code tag row with ANY status (or none). A claude waiting at the
// prompt has the tag row but NOT status "Running" — it is still a live
// session. 2026-07-21 incident: pruneDone used the Running-only check, so a
// conductor's sweep closed 10 ✅-marked tabs whose claude was alive and
// waiting on the owner (✅ auto-marks land when the task completes, even with
// user review pending). Prune's charter is sweeping sessions that DIED —
// process presence, not activity, is the closability test.
function hasLiveClaude(tsvText) {
  return String(tsvText).split('\n').some(l => {
    const c = l.split('\t');
    return c[3] === 'tag' && /:tag:claude_code$/.test(c[4] || '');
  });
}

// ── socket wrappers ─────────────────────────────────────────────────────────

function listWorkspaces() {
  return parseWorkspaces(run(['list-workspaces']));
}

function closeWorkspace(ref) {
  run(['close-workspace', '--workspace', ref]);
}

function claudeRunningIn(ref) {
  try {
    return hasRunningClaude(run(['top', '--workspace', ref, '--processes', '--format', 'tsv']));
  } catch {
    return false; // workspace vanished mid-check → not running
  }
}

function claudeAliveIn(ref) {
  try {
    return hasLiveClaude(run(['top', '--workspace', ref, '--processes', '--format', 'tsv']));
  } catch {
    return false; // workspace vanished mid-check → not alive
  }
}

// Close every ✅-marked workspace WITHOUT a LIVE claude process. Alive-but-
// waiting counts as live: ✅ auto-marks land when a task completes even while
// the owner is still reviewing in the tab, and closing kills claude (10 tabs
// lost mid-review, 2026-07-21). Only tabs whose claude process is GONE — the
// script's original charter, "sessions that died before self-closing" — are
// closable. Skipped tabs are reported; the owner closes them by hand.
// Returns { closed, skipped }; failures to close one workspace don't abort.
function pruneDone(opts = {}) {
  const done = listWorkspaces().filter(w => isDoneTitle(w.title));
  const closed = [];
  const skipped = [];
  for (const w of done) {
    if (claudeAliveIn(w.ref)) { skipped.push(w); continue; }
    if (opts.dryRun) { closed.push(w); continue; }
    try { closeWorkspace(w.ref); closed.push(w); }
    catch (e) { console.error(`[cmux-workspaces] failed to close ${w.ref}: ${e.message}`); }
  }
  return { closed, skipped };
}

module.exports = {
  CMUX, cmuxAvailable, run,
  parseWorkspaces, isDoneTitle, hasRunningClaude, hasLiveClaude,
  listWorkspaces, closeWorkspace, claudeRunningIn, claudeAliveIn, pruneDone,
};
