// BRO-7194: stall Stop gates for cloud sessions that are not in Broadwayscore (app / data repos).
// Covers .claude/hooks/lib/stall-stop-bootstrap.sh (fetch + stop), the VE_ONLY_CODES stall-only
// mode of verify-edits.sh, and the WAKEPROMISE / OPENCLAIM auto-arm date. The BRO-6854 stop is the
// real case: a child that said "KEEP OPEN" with nothing running.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const BOOT = path.join(REPO, '.claude', 'hooks', 'lib', 'stall-stop-bootstrap.sh');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const run = (mode, env, input = '{}') => spawnSyncStdinFile('bash', [BOOT, mode], { input, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000 });

// A tiny stand-in for Broadwayscore: a runner that echoes what it was given.
function fakeRepo() {
  const d = tmp('bsc-fake-');
  fs.mkdirSync(path.join(d, '.claude/hooks/lib'), { recursive: true });
  fs.mkdirSync(path.join(d, 'scripts'));
  fs.writeFileSync(path.join(d, '.claude/hooks/lib/home-hook-runner.sh'), '#!/usr/bin/env bash\necho "RUNNER hook=$1 only=$VE_ONLY_CODES stdin=$(cat)"\n');
  fs.writeFileSync(path.join(d, '.claude/hooks/verify-edits.sh'), '#!/usr/bin/env bash\n');
  fs.writeFileSync(path.join(d, 'package.json'), '{}');
  fs.writeFileSync(path.join(d, 'scripts/x.js'), '');
  const g = (...a) => spawnSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-q', '-m', 'x');
  return d;
}

test('stop with no runner anywhere fails open and says the gate is missing', () => {
  const r = run('stop', { BSC_HOOKS_HOME: tmp('bsc-empty-'), BSC_HOOKS_REPO_URL: 'file:///nonexistent-bsc-repo' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /stall Stop gate not installed/);
});

test('fetch makes a sparse checkout in .bsc-hooks, then stop execs the runner stall-only with stdin', () => {
  const src = fakeRepo(); const home = tmp('bsc-home-');
  const env = { BSC_HOOKS_HOME: home, BSC_HOOKS_REPO_URL: 'file://' + src };
  const f = run('fetch', env);
  assert.equal(f.status, 0, f.stderr);
  assert.ok(fs.existsSync(path.join(home, '.bsc-hooks/.claude/hooks/lib/home-hook-runner.sh')), f.stdout);
  const s = run('stop', env, '{"x":1}');
  assert.equal(s.status, 0);
  assert.match(s.stdout, /RUNNER hook=verify-edits\.sh only=CHILDSTALL\|CHILDWAIT\|CHILDJOBS\|CHILDWATCH\|OPENCLAIM\|WAKELESS\|WAKEPROMISE stdin=\{"x":1\}/);
  // a second fetch refreshes in place (no re-clone, still works)
  assert.equal(run('fetch', env).status, 0);
  assert.equal(run('stop', env, '{}').status, 0);
});

test('fetch from an unreachable URL fails open with a loud message and leaves no half clone', () => {
  const home = tmp('bsc-home-');
  const r = run('fetch', { BSC_HOOKS_HOME: home, BSC_HOOKS_REPO_URL: 'file:///nonexistent/repo' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /NO stall gate/);
  assert.ok(!fs.existsSync(path.join(home, '.bsc-hooks')));
});

test('fetch is a no-op when a full Broadwayscore checkout with the runner exists', () => {
  const home = tmp('bsc-home-'); const full = path.join(home, 'Broadwayscore');
  fs.cpSync(fakeRepo(), full, { recursive: true });
  const r = run('fetch', { BSC_HOOKS_HOME: home, BSC_HOOKS_REPO_URL: 'file:///nonexistent' });
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
  assert.ok(!fs.existsSync(path.join(home, '.bsc-hooks')));
});

// --- end to end through the real runner + verify-edits.sh -----------------------------------
const MIN = 60000; const NOW = Date.parse('2026-11-03T03:50:58Z');
const ts = (m) => new Date(NOW - m * MIN).toISOString();
const CHILD_PROMPT = 'BRO-6854: launch San Diego and Boston\nBUDGET: 6h\nREPORT-BACK: as your very last action, call mcp__claude-code-remote__send_message with session_id "@parent" and a message starting "REPORT-BACK BRO-6854:".';
const CLOSING = "I'm continuing with the rest of the Boston pipeline.\n\nStill running: the Boston scoring run on GitHub.\nYou need to: Nothing needed from you.\n\nKEEP OPEN — Boston is mid-build.";
const lines = [
  { type: 'user', timestamp: ts(200), message: { role: 'user', content: CHILD_PROMPT } },
  { type: 'assistant', timestamp: ts(2), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'gh workflow run llm-ensemble-score.yml -f show_id=boston' } }] } },
  { type: 'user', timestamp: ts(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'Created workflow_dispatch event', is_error: false }] } },
];
function stopThroughApp(lastMsg, env = {}, extraLines = []) {
  const home = tmp('bsc-e2e-'); fs.symlinkSync(REPO, path.join(home, 'Broadwayscore'));
  const app = tmp('bsc-app-'); spawnSync('git', ['init', '-q', app]);
  const tp = path.join(home, 't.jsonl');
  fs.writeFileSync(tp, [...lines, ...extraLines].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const r = spawnSyncStdinFile('bash', [BOOT, 'stop'], {
    input: JSON.stringify({ hook_event_name: 'Stop', cwd: app, transcript_path: tp, session_id: 'bro7194', stop_hook_active: false, last_assistant_message: lastMsg }),
    encoding: 'utf8', timeout: 90000, killSignal: 'SIGKILL',
    cwd: app,
    env: { ...process.env, BSC_HOOKS_HOME: home, HOME: home, CLAUDE_CODE_REMOTE: 'true', CLAUDE_PROJECT_DIR: app, BOARD_GATE_DISABLED: '1', ...env },
  });
  return { status: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
}

test('e2e from an app-repo cwd: the BRO-6854 stop (child, KEEP OPEN, nothing running) is blocked', () => {
  const r = stopThroughApp(CLOSING);
  assert.equal(r.status, 2, r.stderr + r.stdout);
  assert.match(r.stderr, /child session with no human/);
});

test('e2e from an app-repo cwd: a closing that trips only non-stall gates passes (stall-only mode)', () => {
  // The same child, but reporting back: stall gates pass; Broadwayscore-only gates must not run.
  const report = [
    { type: 'assistant', timestamp: ts(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'mcp__claude-code-remote__send_message', input: { session_id: '@parent', message: 'REPORT-BACK BRO-6854: landed abc' } }] } },
    { type: 'user', timestamp: ts(1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: 'ok', is_error: false }] } },
  ];
  const offer = 'Landed. Say the word and I will run Boston.\n\nSAFE TO ARCHIVE — done';
  const r = stopThroughApp(offer, {}, report);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  // control: the full chain (no VE_ONLY_CODES) does block this closing, so the pass above is the mode's doing
  const d = tmp('bsc-ctl-'); const tp = path.join(d, 't.jsonl');
  fs.writeFileSync(tp, [...lines, ...report].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const c = spawnSyncStdinFile('bash', [path.join(REPO, '.claude/hooks/verify-edits.sh')], {
    input: JSON.stringify({ transcript_path: tp, session_id: 'ctl', stop_hook_active: false, last_assistant_message: offer }),
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL',
    env: { ...process.env, HOME: d, CLAUDE_CODE_REMOTE: 'true', BOARD_GATE_DISABLED: '1' },
  });
  assert.equal(c.status, 2, 'control must block: ' + c.stderr);
});

test('WAKEPROMISE / OPENCLAIM auto-arm: advisory before 2026-11-16, blocking from it, env overrides win', () => {
  const promise = "Kicked off the scoring run. I'll check back once it finishes and post the results.";
  const one = (env) => {
    const d = tmp('bsc-arm-'); const tp = path.join(d, 't.jsonl');
    fs.writeFileSync(tp, JSON.stringify({ type: 'user', timestamp: ts(60), message: { role: 'user', content: 'run the thing' } }) + '\n');
    return spawnSyncStdinFile('bash', [path.join(REPO, '.claude/hooks/verify-edits.sh')], {
      input: JSON.stringify({ transcript_path: tp, session_id: 'arm', stop_hook_active: false, last_assistant_message: promise }),
      encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL',
      env: { ...process.env, HOME: d, CLAUDE_CODE_REMOTE: '', BOARD_GATE_DISABLED: '1', SHIP_CHECK_COVERAGE_DISABLE: '1', PROMISE_GATE_MODE: '', ...env },
    }).status;
  };
  assert.equal(one({ STALL_GATE_NOW: '2026-11-15T23:59:00Z' }), 0);
  assert.equal(one({ STALL_GATE_NOW: '2026-11-16T00:00:00Z' }), 2);
  assert.equal(one({ STALL_GATE_NOW: '2026-12-01T00:00:00Z', PROMISE_GATE_MODE: 'off' }), 0);
  assert.equal(one({ STALL_GATE_NOW: '2026-12-01T00:00:00Z', PROMISE_GATE_MODE: 'advisory' }), 0);
  assert.equal(one({ STALL_GATE_NOW: '2026-11-10T00:00:00Z', PROMISE_GATE_MODE: 'block' }), 2);
});

test('stall-only: a human-time-estimate phrase in the closing does not switch the stall gates off', () => {
  const r = stopThroughApp(CLOSING + '\n\nThe remaining run should take a few hours.');
  assert.equal(r.status, 2, 'must still block: ' + r.stderr + r.stdout);
});

test('stall-only: an unknown PROMISE_GATE_MODE value stays advisory even after the arm date', () => {
  const promise = "Kicked off the scoring run. I'll check back once it finishes and post the results.";
  const d = tmp('bsc-unk-'); const tp = path.join(d, 't.jsonl');
  fs.writeFileSync(tp, JSON.stringify({ type: 'user', timestamp: ts(60), message: { role: 'user', content: 'run' } }) + '\n');
  const r = spawnSyncStdinFile('bash', [path.join(REPO, '.claude/hooks/verify-edits.sh')], {
    input: JSON.stringify({ transcript_path: tp, session_id: 'unk', stop_hook_active: false, last_assistant_message: promise }),
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL',
    env: { ...process.env, HOME: d, CLAUDE_CODE_REMOTE: '', BOARD_GATE_DISABLED: '1', SHIP_CHECK_COVERAGE_DISABLE: '1', PROMISE_GATE_MODE: 'log', STALL_GATE_NOW: '2026-12-01T00:00:00Z' },
  });
  assert.equal(r.status, 0, r.stderr);
});

test('stop before any fetch (first turn beat SessionStart, BRO-7194 probe) fetches inline and still runs the gate', () => {
  const src = fakeRepo(); const home = tmp('bsc-inline-');
  const s = run('stop', { BSC_HOOKS_HOME: home, BSC_HOOKS_REPO_URL: 'file://' + src }, '{"y":2}');
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /RUNNER hook=verify-edits\.sh only=.*stdin=\{"y":2\}/);
});
