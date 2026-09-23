/**
 * claude-tab-relaunch — restart the claude inside an existing cmux tab, in
 * that tab's own shell, with the login token guaranteed (BRO-4065).
 *
 * BRO-4056 only DETECTED logged-out tabs. The cause: every claude
 * authenticates through CLAUDE_CODE_OAUTH_TOKEN (the keychain sentinel purges
 * the stored login every 5 min), and any claude started from an agent's Bash
 * tool, launchd, or `cmux respawn-pane` lacks it. What demonstrably worked on
 * 2026-09-21: typing the relaunch into the tab's OWN pty with `cmux send`.
 * This module does exactly that, and types relaunch-claude-tab.sh rather than
 * bare `claude` so the token is re-exported from .env even when the tab's
 * shell somehow lacks it.
 *
 * Steps (healTab):
 *   1. find the tab's claude process from `cmux top` (tagged claude_code row,
 *      or an untagged process row whose ps command is claude — a logged-out
 *      claude never registers the tag), confirm via ps that it IS claude and
 *      that its parent is an INTERACTIVE shell (so the tab survives the exit
 *      and there is a prompt to type into);
 *   2. refuse if the tab is busy (tag status Running, or a spinner on screen);
 *   3. read the session id / model / flags from the process's own command
 *      line (fallback: cmux's saved hook record for the workspace), and its
 *      cwd from lsof;
 *   4. SIGTERM the dead claude, wait for it to exit;
 *   5. `cmux send` the helper command + Enter;
 *   6. poll the screen until the normal "ctx NN%" status bar is drawn with no
 *      login text. Anything short of that is a failure the caller surfaces.
 *
 * All I/O is injectable (CLAUDE.md rule 15); the pure pieces are exported.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const cmuxws = require('./cmux-workspaces.js');
const { isBusy, lastRealContentLine, detectAuthStall } = require('./cmux-auth-stall.js');

const RELAUNCH_SCRIPT = path.join(__dirname, 'relaunch-claude-tab.sh');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGIN_TEXT_RE = /not logged in|please run `?\/login|invalid[\s_-]?api[\s_-]?key|authentication_error/i;

// Single-quote for POSIX sh; the typed line must stay one line (cmux send
// treats a newline as Enter).
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Pull what a relaunch needs out of a claude ps command line. Regex over the
// whole line, not an argv split: --mcp-config JSON embeds "Application
// Support" (a space), so whitespace-splitting is wrong. Pure.
function parseClaudeCommand(command) {
  const c = String(command || '');
  const resume = /(?:^|\s)(?:--resume|-r)[ =]([0-9a-f-]{36})(?=\s|$)/i.exec(c);
  const sid = /(?:^|\s)--session-id[ =]([0-9a-f-]{36})(?=\s|$)/i.exec(c);
  const model = /(?:^|\s)--model[ =]([A-Za-z0-9._:\[\]-]+)(?=\s|$)/.exec(c);
  return {
    sessionId: (resume && resume[1]) || (sid && sid[1]) || null,
    sessionFlag: resume ? 'resume' : sid ? 'session-id' : null,
    model: model ? model[1] : null,
    skipPermissions: /(?:^|\s)--dangerously-skip-permissions(?=\s|$)/.test(c),
  };
}

// ps command → is this a claude binary (argv0 basename exactly `claude`)? Pure.
function isClaudeCommand(command) {
  const argv0 = String(command || '').trim().split(/\s+/)[0] || '';
  return path.basename(argv0) === 'claude';
}

// ps command of the parent → an INTERACTIVE shell (login `-zsh`, `/bin/zsh`,
// `zsh -l`, `bash -i`...), never `zsh -c ...` (its pane would close when
// claude exits, leaving nothing to type into). Pure.
function isInteractiveShellCommand(command) {
  const c = String(command || '').trim();
  return /^-?(?:\S*\/)?(?:zsh|bash)(?:\s+-[li]+)*$/.test(c);
}

// Candidate claude pids for a workspace from `cmux top --processes --format
// tsv` (cpu, rss, n, type, id, parent, status). Tagged claude_code process
// rows first; then untagged process rows directly under a surface (verified
// live 2026-09-23: a logged-out/restored claude appears as `process <pid>
// surface:N 2.1.278` with no tag row). Also reports whether the tag row says
// Running (busy). Pure.
function parseTopForClaude(tsvText) {
  const tagged = [];
  const untagged = [];
  let running = false;
  for (const line of String(tsvText).split('\n')) {
    const c = line.split('\t');
    if (c[3] === 'tag' && /:tag:claude_code$/.test(c[4] || '') && (c[6] || '').trim() === 'Running') running = true;
    if (c[3] !== 'process') continue;
    const pid = parseInt(c[4], 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (/:tag:claude_code$/.test(c[5] || '')) tagged.push(pid);
    else if (/^surface:/.test(c[5] || '')) untagged.push(pid);
  }
  return { pids: [...tagged, ...untagged], running };
}

// Pick the cmux hook record for this workspace: active one first, then the
// most recently updated. Pure — takes `cmux sessions --json` text.
function pickSessionRecord(jsonText) {
  let parsed;
  try { parsed = JSON.parse(String(jsonText)); } catch { return null; }
  const rows = (parsed && Array.isArray(parsed.sessions) ? parsed.sessions : [])
    .filter(r => r && r.agent === 'claude' && UUID_RE.test(String(r.session_id || '')));
  if (!rows.length) return null;
  rows.sort((a, b) => (Number(!!b.active_for_workspace) - Number(!!a.active_for_workspace))
    || String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const r = rows[0];
  const args = Array.isArray(r.launch_arguments) ? r.launch_arguments.join(' ') : '';
  const parsedArgs = parseClaudeCommand(args);
  return {
    sessionId: r.session_id,
    cwd: r.launch_working_directory || r.cwd || null,
    model: parsedArgs.model,
    skipPermissions: parsedArgs.skipPermissions,
    transcriptBacked: !!r.transcript_backed,
  };
}

function transcriptExists(sessionId, projectsDir = path.join(os.homedir(), '.claude', 'projects')) {
  try {
    return fs.readdirSync(projectsDir).some(d => fs.existsSync(path.join(projectsDir, d, `${sessionId}.jsonl`)));
  } catch { return false; }
}

/**
 * The single line typed into the tab. A session with a transcript resumes;
 * one that died before its first message (no transcript) restarts under the
 * same id; no id at all starts a fresh claude in the same directory. Pure.
 */
function buildRelaunchCommand({ sessionId = null, hasTranscript = false, cwd = null, model = null, skipPermissions = false, script = RELAUNCH_SCRIPT } = {}) {
  if (sessionId && !UUID_RE.test(sessionId)) throw new Error(`refusing to type a non-uuid session id: ${sessionId}`);
  if (cwd && (!path.isAbsolute(cwd) || /[\n\r]/.test(cwd))) throw new Error(`refusing to type a non-absolute/multiline cwd: ${cwd}`);
  if (model && !/^[A-Za-z0-9._:\[\]-]+$/.test(model)) throw new Error(`refusing to type an odd model name: ${model}`);
  const parts = [shQuote(script)];
  if (cwd) parts.push('--cwd', shQuote(cwd));
  if (sessionId) parts.push(hasTranscript ? '--resume' : '--session-id', sessionId);
  if (model) parts.push('--model', model);
  if (skipPermissions) parts.push('--dangerously-skip-permissions');
  return parts.join(' ');
}

// A healed tab draws the normal "ctx NN%" status bar (a logged-out claude
// never does — cmux-auth-stall.js's chrome-absence contract) and its last
// real line is not a login error. Deliberately NOT "no login text anywhere":
// a resumed session replays its history, which can quote this exact error
// (every BRO-4056/4065 session does). Pure.
function looksHealthy(screenText) {
  const t = String(screenText || '');
  return cmuxws.hasClaudeChrome(t) && !LOGIN_TEXT_RE.test(lastRealContentLine(t));
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function defaultDeps() {
  const ps = (pid, field) => execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).trim();
  return {
    runFn: cmuxws.run,
    psCommandFn: (pid) => ps(pid, 'command'),
    ppidFn: (pid) => parseInt(ps(pid, 'ppid'), 10),
    cwdFn: (pid) => {
      const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 5000 });
      const m = /^n(.+)$/m.exec(out);
      return m ? m[1] : null;
    },
    isAliveFn: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } },
    killFn: (pid, sig) => process.kill(pid, sig),
    sessionsFn: (workspaceId) => cmuxws.run(['sessions', '--agent', 'claude', '--workspace', workspaceId, '--json', '--all']),
    workspaceIdFn: (ref) => {
      const j = JSON.parse(cmuxws.run(['workspace', 'list', '--json']));
      const w = (j.workspaces || []).find(x => x.ref === ref);
      return w ? { id: w.id, cwd: w.current_directory || null } : null;
    },
    transcriptExistsFn: transcriptExists,
    sleepFn: sleepMs,
    now: () => Date.now(),
  };
}

/**
 * Relaunch the claude in `ref` inside that tab's own shell.
 * @param {string} ref workspace:N
 * @param {object} [opts] { requireLoggedOut=true, dryRun=false, confirmTimeoutMs=90000, deps }
 * @returns {{healed: boolean, reason: string, command?: string, pid?: number}}
 */
function healTab(ref, opts = {}) {
  const { requireLoggedOut = true, dryRun = false, confirmTimeoutMs = 90000, exitTimeoutMs = 10000 } = opts;
  const d = { ...defaultDeps(), ...(opts.deps || {}) };
  const readScreen = () => d.runFn(['read-screen', '--workspace', ref]);

  let screen;
  try { screen = readScreen(); } catch (e) { return { healed: false, reason: `cannot read the tab's screen (${e.message})` }; }
  if (isBusy(screen)) return { healed: false, reason: 'tab is busy (spinner on screen) — left alone' };
  const stall = detectAuthStall(screen);
  if (requireLoggedOut && !(stall && stall.kind === 'logged-out')) {
    return { healed: false, reason: 'tab is not showing a lost-login screen — left alone' };
  }

  let top;
  try { top = d.runFn(['top', '--workspace', ref, '--processes', '--format', 'tsv']); }
  catch (e) { return { healed: false, reason: `cannot list the tab's processes (${e.message})` }; }
  const { pids, running } = parseTopForClaude(top);
  // The tag's Running status is NOT trusted for a screen-verified logged-out
  // tab: a prompt that failed auth never fires the Stop hook, so the tag sits
  // at Running forever (verified live 2026-09-23, BRO-4065 scratch tab). A
  // logged-out claude cannot be doing work (every API call fails), and a real
  // in-flight turn draws a spinner, which isBusy() above already refused.
  const screenSaysLoggedOut = !!(stall && stall.kind === 'logged-out');
  if (running && !screenSaysLoggedOut) return { healed: false, reason: 'tab is busy (claude reports Running) — left alone' };

  let pid = null; let command = null;
  for (const p of pids) {
    let cmd;
    try { cmd = d.psCommandFn(p); } catch { continue; }
    if (isClaudeCommand(cmd)) { pid = p; command = cmd; break; }
  }
  if (!pid) return { healed: false, reason: 'no claude process found in the tab' };

  let parentCmd;
  try { parentCmd = d.psCommandFn(d.ppidFn(pid)); } catch { parentCmd = ''; }
  if (!isInteractiveShellCommand(parentCmd)) {
    return { healed: false, reason: `claude is not running under an interactive shell (${parentCmd || 'unknown parent'}) — exiting it could close the tab` };
  }

  const fromPs = parseClaudeCommand(command);
  let sessionId = fromPs.sessionId;
  let model = fromPs.model;
  let skipPermissions = fromPs.skipPermissions;
  let cwd = null;
  try { cwd = d.cwdFn(pid); } catch { /* fall through to the hook record */ }
  if (!sessionId || !cwd) {
    try {
      const ws = d.workspaceIdFn(ref);
      const rec = ws ? pickSessionRecord(d.sessionsFn(ws.id)) : null;
      if (rec && !sessionId) { sessionId = rec.sessionId; model = model || rec.model; skipPermissions = skipPermissions || rec.skipPermissions; }
      if (!cwd) cwd = (rec && rec.cwd) || (ws && ws.cwd) || null;
    } catch { /* no record — a fresh claude in the tab's cwd is still a heal */ }
  }

  let typed;
  try {
    typed = buildRelaunchCommand({
      sessionId, cwd, model, skipPermissions,
      hasTranscript: !!sessionId && d.transcriptExistsFn(sessionId),
    });
  } catch (e) { return { healed: false, reason: e.message }; }
  if (dryRun) return { healed: false, reason: 'dry-run', command: typed, pid };

  try { d.killFn(pid, 'SIGTERM'); } catch (e) { return { healed: false, reason: `could not stop the dead claude (${e.message})`, pid }; }
  const exitDeadline = d.now() + exitTimeoutMs;
  while (d.isAliveFn(pid) && d.now() < exitDeadline) d.sleepFn(250);
  if (d.isAliveFn(pid)) {
    try { d.killFn(pid, 'SIGKILL'); } catch { /* checked below */ }
    d.sleepFn(500);
    if (d.isAliveFn(pid)) return { healed: false, reason: 'the dead claude would not exit', pid };
  }
  d.sleepFn(1000); // let the shell redraw its prompt before typing

  try {
    d.runFn(['send', '--workspace', ref, '--', typed]);
    d.runFn(['send-key', '--workspace', ref, 'Enter']);
  } catch (e) { return { healed: false, reason: `could not type into the tab (${e.message})`, command: typed, pid }; }

  const deadline = d.now() + confirmTimeoutMs;
  let last = '';
  while (d.now() < deadline) {
    d.sleepFn(3000);
    try { last = readScreen(); } catch { continue; }
    if (looksHealthy(last)) return { healed: true, reason: 'relaunched in the tab and the normal prompt is back', command: typed, pid };
  }
  const why = LOGIN_TEXT_RE.test(last) ? 'still shows a login error after relaunch' : 'normal prompt never came back after relaunch';
  return { healed: false, reason: why, command: typed, pid };
}

module.exports = {
  RELAUNCH_SCRIPT, LOGIN_TEXT_RE,
  shQuote, parseClaudeCommand, isClaudeCommand, isInteractiveShellCommand,
  parseTopForClaude, pickSessionRecord, transcriptExists, buildRelaunchCommand,
  looksHealthy, healTab,
};
