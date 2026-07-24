/**
 * cmux-launch — shared "open a cmux workspace already running Claude Code"
 * primitive. Extracted from bsc-next.js launchCmux() (2026-07-24) so non-task
 * callers (opening-night monitor launcher) get the same verified launch
 * mechanics without fabricating a fake task object: seed/cmd wrapper files
 * (shell-init race, 2026-07-12), two launch attempts, a 30s claudeAliveIn
 * verification window (a mangled command never starts claude and nothing else
 * would notice), and the Blue auto-dispatch tab color.
 *
 * bsc-next.js composes its task-derived title/seedKey and delegates here with
 * seedKey = task.id, so the temp-file paths and typed command are
 * byte-identical to the pre-extraction behavior.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const cmuxws = require('./cmux-workspaces.js');

const CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux';

function sleepSec(s) { spawnSync('sleep', [String(s)]); }

// Poll fn() every second until it returns truthy or timeoutSec elapses.
function pollUntil(fn, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    sleepSec(1);
  }
}

// Best-effort color-code (scope add, card #168): auto-dispatched workspaces
// go Blue so the owner can distinguish "safe to ignore" tabs from ones they
// opened themselves at a glance. Never blocks or fails the dispatch — a
// verified-running claude session matters more than its tab color.
function setAutoColor(ref) {
  try { spawnSync(CMUX, ['workspace-action', '--action', 'set-color', '--color', 'Blue', '--workspace', ref], { encoding: 'utf8', timeout: 3000 }); } catch { /* cosmetic only */ }
}

/**
 * Launch a cmux workspace running `claude` on a seed prompt and verify a live
 * claude process actually started.
 *
 * @param {object} opts
 * @param {string} opts.title      workspace tab title (caller owns naming convention)
 * @param {string} opts.seed       full seed prompt text
 * @param {string} opts.seedKey    unique key for the temp seed/cmd filenames (bsc-next passes task.id)
 * @param {string} opts.cwd        working directory for the workspace
 * @param {string} [opts.model]    claude model (default sonnet — dispatched sessions
 *                                 never inherit the interactive default; 9 Fable
 *                                 workspaces in one night, 2026-07-13)
 * @param {boolean} [opts.focus]   focus the new tab (default true; false for
 *                                 late-night unattended launches — never steal
 *                                 the owner's screen)
 * @param {boolean} [opts.autoColor] color the tab Blue as auto-dispatched
 * @param {string}  [opts.settingsPath] optional --settings deny-list file
 * @param {string}  [opts.commandOverride] test seam — never set in real use
 * @returns {{ok: boolean, ref?: string, reason?: string, workspaceRef?: string|null, seedFile: string, command: string}}
 */
function launchCmuxSession({ title, seed, seedKey, cwd, model = 'sonnet', focus = true, autoColor = false, settingsPath = null, commandOverride = null }) {
  const seedFile = path.join(os.tmpdir(), `bsc-seed-${seedKey}.txt`);
  fs.writeFileSync(seedFile, seed);
  // The wrapper script expands $(cat …) so the multi-line prompt survives
  // without brittle inline quoting. `claude "<prompt>"` opens interactive on it.
  // --dangerously-skip-permissions: launched sessions must never permission-ping
  // (user rule 2026-07-12); explicit permissions.deny rules still outrank bypass.
  const settingsArg = settingsPath ? ` --settings ${settingsPath}` : '';
  const command = commandOverride || `claude --model ${model}${settingsArg} --dangerously-skip-permissions "$(cat ${seedFile})"`;
  // Shell-init race (real failure 2026-07-12): new-workspace TYPES the command
  // into the pane while zsh/direnv may still be initializing, so leading
  // keystrokes get swallowed ('nclaude' → command not found) and the session
  // never starts. Shrink the typed surface to a short constant string by
  // putting the real command in a script file.
  const cmdFile = path.join(os.tmpdir(), `bsc-cmd-${seedKey}.sh`);
  fs.writeFileSync(cmdFile, `#!/bin/bash\n${command}\n`);
  const typed = ` bash ${cmdFile}`; // leading space additionally survives a swallowed first key
  if (!fs.existsSync(CMUX)) return { ok: false, reason: 'cmux CLI not found', seedFile, command };

  let lastWs = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = new Set(cmuxws.listWorkspaces().map(w => w.ref));
    const r = spawnSync(CMUX, ['new-workspace', '--name', title, '--cwd', cwd, '--command', typed, '--focus', String(focus)],
      { encoding: 'utf8' });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.status !== 0) {
      if (r.stderr) process.stderr.write(r.stderr);
      if (attempt === 1) { sleepSec(2); continue; }
      return { ok: false, reason: `cmux exited ${r.status}`, seedFile, command };
    }
    // Resolve the created workspace: new-workspace prints "OK workspace:N"
    // (cmux 0.64.6); fall back to a before/after list diff if that changes.
    const m = /workspace:\d+/.exec(String(r.stdout || ''));
    const ws = m ? { ref: m[0] } : pollUntil(
      () => cmuxws.listWorkspaces().find(w => !before.has(w.ref)), 5);
    lastWs = ws || lastWs;
    // VERIFY the launch (scope add 3): a workspace whose command was mangled
    // never starts claude and never self-marks ✅, so nothing would notice.
    // Poll for a LIVE claude_code process (any status — a fast launch can
    // reach waiting-at-prompt inside the window, and the Running-only check
    // would kill that healthy session as a corpse; ship-check 2026-07-21).
    // 30s window: shell init (direnv) + claude cold start can exceed 15s
    // post-reboot, and a false timeout kills a healthy launch (2026-07-12).
    if (ws && pollUntil(() => cmuxws.claudeAliveIn(ws.ref), 30)) {
      if (autoColor) setAutoColor(ws.ref);
      return { ok: true, ref: ws.ref, seedFile, command };
    }
    if (attempt === 1) {
      // Verify-before-close: one last check after a beat, so a claude that
      // registered at the buzzer isn't killed as a corpse.
      sleepSec(2);
      if (ws && cmuxws.claudeAliveIn(ws.ref)) {
        if (autoColor) setAutoColor(ws.ref);
        return { ok: true, ref: ws.ref, seedFile, command };
      }
      if (ws) { try { cmuxws.closeWorkspace(ws.ref); } catch { /* already gone */ } }
      sleepSec(2);
    }
  }
  return {
    ok: false,
    reason: `no running claude in ${lastWs ? lastWs.ref : 'the new workspace'} after 2 attempts`,
    workspaceRef: lastWs ? lastWs.ref : null,
    seedFile, command,
  };
}

module.exports = { launchCmuxSession, CMUX, pollUntil, sleepSec, setAutoColor };
