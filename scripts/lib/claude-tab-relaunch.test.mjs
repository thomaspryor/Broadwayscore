import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('./claude-tab-relaunch.js');

const SID = '3f7ce600-7a1a-415f-8d87-566b441b4bdf';
// Shape of a real logged-out restored tab's claude (ps -o command=, 2026-09-23),
// including the --mcp-config JSON with "Application Support" (a space).
const REAL_PS = `/Users/x/.local/bin/claude --settings /var/folders/T/cmux-claude-settings.ww --mcp-config={"mcpServers":{"a":{"env":{"D":"/Users/x/Library/Application Support/cmux"}}}} --resume ${SID} --model claude-opus-5 --dangerously-skip-permissions`;
const LOGGED_OUT = 'Welcome back\n\n> hi\n  ⎿  Not logged in · Please run /login\n';
const HEALTHY = 'Resumed\n\n────────\n❯ \n────────\n🔮 OPUS │ ctx 12% │ main │ Broadwayscore\n';
const TOP_UNTAGGED = [
  '0.9\t1\t8\tworkspace\tworkspace:9\twindow:1\tT',
  '0.8\t1\t1\tprocess\t64577\tsurface:5\t2.1.278',
  '0.0\t0\t1\tprocess\t29965\tsurface:5\tlogin',
].join('\n');

test('parseClaudeCommand: real ps line with a spaced --mcp-config JSON', () => {
  assert.deepEqual(R.parseClaudeCommand(REAL_PS), { sessionId: SID, sessionFlag: 'resume', model: 'claude-opus-5', skipPermissions: true });
  assert.equal(R.parseClaudeCommand(`claude --session-id ${SID}`).sessionFlag, 'session-id');
  assert.equal(R.parseClaudeCommand('claude').sessionId, null);
});

test('isClaudeCommand / isInteractiveShellCommand', () => {
  assert.equal(R.isClaudeCommand(REAL_PS), true);
  assert.equal(R.isClaudeCommand('node /x/claude-cli.js'), false);
  for (const ok of ['-/bin/zsh', '-zsh', '/bin/zsh', 'zsh -l', 'bash -i', '/bin/bash']) assert.equal(R.isInteractiveShellCommand(ok), true, ok);
  for (const bad of ['/bin/zsh -c claude --resume x', 'bash -c exec -l /bin/zsh', '/usr/bin/login -flp x', 'node', '']) assert.equal(R.isInteractiveShellCommand(bad), false, bad);
});

test('parseTopForClaude: tagged first, untagged surface children, Running = busy', () => {
  const tagged = '0.8\t1\t4\ttag\tworkspace:U:tag:claude_code\tworkspace:27\tRunning\n0.8\t1\t1\tprocess\t69366\tworkspace:U:tag:claude_code\t2.1.280';
  assert.deepEqual(R.parseTopForClaude(tagged), { pids: [69366], running: true });
  assert.deepEqual(R.parseTopForClaude(TOP_UNTAGGED), { pids: [64577, 29965], running: false });
});

test('pickSessionRecord: prefers the active record, parses model/flags', () => {
  const json = JSON.stringify({ sessions: [
    { agent: 'claude', session_id: '11111111-1111-1111-1111-111111111111', updated_at: '2026-09-23', launch_arguments: ['claude'] },
    { agent: 'claude', session_id: SID, active_for_workspace: true, updated_at: '2026-09-01', launch_working_directory: '/w', launch_arguments: ['claude', '--model', 'opus', '--dangerously-skip-permissions'] },
  ] });
  assert.deepEqual(R.pickSessionRecord(json), { sessionId: SID, cwd: '/w', model: 'opus', skipPermissions: true, transcriptBacked: false });
  assert.equal(R.pickSessionRecord('not json'), null);
});

test('buildRelaunchCommand: resume vs session-id vs fresh; refuses unsafe input', () => {
  const cmd = R.buildRelaunchCommand({ sessionId: SID, hasTranscript: true, cwd: "/Users/x/it's here", model: 'claude-opus-5', skipPermissions: true, script: '/r/relaunch-claude-tab.sh' });
  assert.equal(cmd, `'/r/relaunch-claude-tab.sh' --cwd '/Users/x/it'\\''s here' --resume ${SID} --model claude-opus-5 --dangerously-skip-permissions`);
  assert.match(R.buildRelaunchCommand({ sessionId: SID, hasTranscript: false }), new RegExp(`--session-id ${SID}$`));
  assert.match(R.buildRelaunchCommand({}), /relaunch-claude-tab\.sh'$/);
  assert.doesNotMatch(cmd, /\n/);
  assert.throws(() => R.buildRelaunchCommand({ sessionId: 'x; rm -rf ~' }));
  assert.throws(() => R.buildRelaunchCommand({ cwd: 'relative' }));
  assert.throws(() => R.buildRelaunchCommand({ cwd: '/a\nb' }));
  assert.throws(() => R.buildRelaunchCommand({ model: 'opus; echo' }));
});

test('looksHealthy: chrome + last real line not a login error (history quoting it is fine)', () => {
  assert.equal(R.looksHealthy(HEALTHY), true);
  assert.equal(R.looksHealthy(LOGGED_OUT), false);
  assert.equal(R.looksHealthy('earlier: Not logged in · Please run /login\n' + HEALTHY), true);
  assert.equal(R.looksHealthy('> hi\n  ⎿  Not logged in · Please run /login\n────────\n❯ \n────────\n🔮 OPUS │ ctx 1% │ main\n'), false);
});

// ---- healTab with fake I/O ----
function fakeDeps({ screens = [LOGGED_OUT, HEALTHY], top = TOP_UNTAGGED, parent = '-/bin/zsh', aliveAfterTerm = false, transcript = true } = {}) {
  const calls = { run: [], kill: [] };
  let alive = true;
  let t = 0;
  const screenQ = [...screens];
  return {
    calls,
    deps: {
      runFn: (args) => {
        calls.run.push(args);
        if (args[0] === 'read-screen') return screenQ.length > 1 ? screenQ.shift() : screenQ[0];
        if (args[0] === 'top') return top;
        return '';
      },
      psCommandFn: (pid) => (pid === 64577 ? REAL_PS : pid === 30005 ? parent : 'login'),
      ppidFn: () => 30005,
      cwdFn: () => '/Users/x/Broadwayscore',
      isAliveFn: () => alive,
      killFn: (pid, sig) => { calls.kill.push([pid, sig]); if (!aliveAfterTerm || sig === 'SIGKILL') alive = false; },
      sessionsFn: () => { throw new Error('should not need the hook record'); },
      workspaceIdFn: () => null,
      transcriptExistsFn: () => transcript,
      sleepFn: (ms) => { t += ms; },
      now: () => t,
    },
  };
}

test('healTab: stops the dead claude, types the helper into the tab, confirms the prompt', () => {
  const f = fakeDeps();
  const r = R.healTab('workspace:test-x', { deps: f.deps });
  assert.equal(r.healed, true, r.reason);
  assert.deepEqual(f.calls.kill, [[64577, 'SIGTERM']]);
  const send = f.calls.run.find(a => a[0] === 'send');
  assert.equal(send[send.length - 1], `'${R.RELAUNCH_SCRIPT}' --cwd '/Users/x/Broadwayscore' --resume ${SID} --model claude-opus-5 --dangerously-skip-permissions`);
  assert.ok(f.calls.run.some(a => a[0] === 'send-key' && a.includes('Enter')));
});

test('healTab: no transcript → restarts under the same id instead of a failing --resume', () => {
  const f = fakeDeps({ transcript: false });
  const r = R.healTab('workspace:test-x', { deps: f.deps });
  assert.match(r.command, new RegExp(`--session-id ${SID}`));
});

test('healTab: refuses a busy tab (spinner or Running tag) — nothing killed', () => {
  const f1 = fakeDeps({ screens: ['✻ Waiting for 2 background agents\nNot logged in · Please run /login'] });
  assert.equal(R.healTab('workspace:test-x', { deps: f1.deps }).healed, false);
  assert.equal(f1.calls.kill.length, 0);
  // Running tag on a tab NOT proven logged out (forced relaunch mode) → busy
  const f2 = fakeDeps({ screens: [HEALTHY], top: '0.8\t1\t4\ttag\tworkspace:U:tag:claude_code\tworkspace:27\tRunning\n' + TOP_UNTAGGED });
  assert.match(R.healTab('workspace:test-x', { deps: f2.deps, requireLoggedOut: false }).reason, /busy/);
  assert.equal(f2.calls.kill.length, 0);
});

test('healTab: a stuck Running tag does not block a screen-verified logged-out tab', () => {
  // Live 2026-09-23: the failed-auth prompt never fires Stop, tag stays Running.
  const f = fakeDeps({ top: '0.8\t1\t4\ttag\tworkspace:U:tag:claude_code\tworkspace:27\tRunning\n' + TOP_UNTAGGED });
  assert.equal(R.healTab('workspace:test-x', { deps: f.deps }).healed, true);
});

test('healTab: refuses a healthy tab unless requireLoggedOut=false', () => {
  const f = fakeDeps({ screens: [HEALTHY] });
  assert.match(R.healTab('workspace:test-x', { deps: f.deps }).reason, /not showing a lost-login/);
  assert.equal(f.calls.kill.length, 0);
  const f2 = fakeDeps({ screens: [HEALTHY] });
  assert.equal(R.healTab('workspace:test-x', { deps: f2.deps, requireLoggedOut: false }).healed, true);
});

test('healTab: refuses when claude is not under an interactive shell (tab could close)', () => {
  const f = fakeDeps({ parent: '/bin/zsh -c claude --resume x' });
  assert.match(R.healTab('workspace:test-x', { deps: f.deps }).reason, /interactive shell/);
  assert.equal(f.calls.kill.length, 0);
});

test('healTab: dry-run returns the command without killing or typing', () => {
  const f = fakeDeps();
  const r = R.healTab('workspace:test-x', { deps: f.deps, dryRun: true });
  assert.equal(r.reason, 'dry-run');
  assert.match(r.command, /--resume/);
  assert.equal(f.calls.kill.length, 0);
  assert.ok(!f.calls.run.some(a => a[0] === 'send'));
});

test('healTab: escalates to SIGKILL when SIGTERM is ignored', () => {
  const f = fakeDeps({ aliveAfterTerm: true });
  const r = R.healTab('workspace:test-x', { deps: f.deps });
  assert.deepEqual(f.calls.kill.map(k => k[1]), ['SIGTERM', 'SIGKILL']);
  assert.equal(r.healed, true);
});

test('healTab: reports failure when the prompt never comes back', () => {
  const f = fakeDeps({ screens: [LOGGED_OUT, LOGGED_OUT] });
  const r = R.healTab('workspace:test-x', { deps: f.deps, confirmTimeoutMs: 10000 });
  assert.equal(r.healed, false);
  assert.match(r.reason, /login error/);
});

test('healTab: no claude process in the tab → not healed, nothing typed', () => {
  const f = fakeDeps({ top: '0.0\t0\t1\tprocess\t29965\tsurface:5\tlogin' });
  const r = R.healTab('workspace:test-x', { deps: f.deps });
  assert.match(r.reason, /no claude process/);
  assert.ok(!f.calls.run.some(a => a[0] === 'send'));
});

// ---- the shell helper itself ----
test('relaunch-claude-tab.sh: re-exports the token from .env and execs claude in --cwd', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaunch-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'OTHER=1\nCLAUDE_CODE_OAUTH_TOKEN="tok-abc"\n');
  const fake = path.join(dir, 'fake-claude');
  fs.writeFileSync(fake, '#!/bin/bash\necho "token=${CLAUDE_CODE_OAUTH_TOKEN} cwd=$(pwd -P) args=$*"\n', { mode: 0o755 });
  const env = { ...process.env, BSC_ENV_FILE: envFile, CLAUDE_BIN: fake, HOME: dir };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const out = execFileSync('bash', [R.RELAUNCH_SCRIPT, '--cwd', dir, '--resume', SID], { env, encoding: 'utf8' });
  assert.equal(out.trim(), `token=tok-abc cwd=${fs.realpathSync(dir)} args=--resume ${SID}`);
  // an already-exported token wins over .env
  const out2 = execFileSync('bash', [R.RELAUNCH_SCRIPT, 'x'], { env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: 'from-env' }, encoding: 'utf8' });
  assert.match(out2, /^token=from-env /);
  assert.equal(execFileSync('bash', [R.RELAUNCH_SCRIPT, '--check'], { env, encoding: 'utf8' }).trim(), 'SET');
  fs.rmSync(dir, { recursive: true, force: true });
});
