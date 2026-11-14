// BRO-7194: stall Stop gates for cloud sessions that are not in Broadwayscore (app / data repos).
// Covers .claude/hooks/lib/stall-stop-bootstrap.sh (fetch + stop), the VE_ONLY_CODES stall-only
// mode of verify-edits.sh, and the WAKEPROMISE / OPENCLAIM auto-arm date. The BRO-6854 stop is the
// real case: a child that said "KEEP OPEN" with nothing running.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const BOOT = path.join(REPO, '.claude', 'hooks', 'lib', 'stall-stop-bootstrap.sh');
const scratchDirs = [];
const tmp = (p) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), p)); scratchDirs.push(dir); return dir; };
after(() => { for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
const suiteTmp = tmp('bsc-bootstrap-suite-');
const run = (mode, env, input = '{}') => spawnSyncStdinFile('bash', [BOOT, mode], { input, encoding: 'utf8', env: { ...process.env, TMPDIR: suiteTmp, ...env }, timeout: 60000 });

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
function stopThroughApp(lastMsg, env = {}, extraLines = [], repeats = 1, appBootstrap) {
  const home = tmp('bsc-e2e-'); fs.symlinkSync(REPO, path.join(home, 'Broadwayscore'));
  const app = tmp('bsc-app-'); spawnSync('git', ['init', '-q', app]);
  if (appBootstrap !== undefined) {
    fs.mkdirSync(path.join(app, '.claude/hooks'), { recursive: true });
    fs.writeFileSync(path.join(app, '.claude/hooks/stall-stop-bootstrap.sh'), appBootstrap);
  }
  const tp = path.join(home, 't.jsonl');
  fs.writeFileSync(tp, [...lines, ...extraLines].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const attempts = [];
  for (let i = 0; i < repeats; i++) {
    const r = spawnSyncStdinFile('bash', [BOOT, 'stop'], {
      input: JSON.stringify({ hook_event_name: 'Stop', cwd: app, transcript_path: tp, session_id: 'bro7194', stop_hook_active: false, last_assistant_message: lastMsg }),
      encoding: 'utf8', timeout: 90000, killSignal: 'SIGKILL',
      cwd: app,
      env: { ...process.env, BSC_HOOKS_HOME: home, HOME: home, TMPDIR: home, CLAUDE_CODE_REMOTE: 'true', CLAUDE_PROJECT_DIR: app, BOARD_GATE_DISABLED: '1', ...env },
    });
    attempts.push({ status: r.status, stderr: r.stderr || '', stdout: r.stdout || '' });
  }
  return repeats === 1 ? attempts[0] : attempts;
}

test('app and user Stop entries evaluate the same child turn only once', () => {
  const attempts = stopThroughApp(CLOSING, {}, [], 2);
  assert.deepEqual(attempts.map(r => r.status), [2, 0]);
  assert.match(attempts[0].stderr, /child session with no human/);
  assert.equal(attempts[1].stderr + attempts[1].stdout, '');
});

test('the shared runner detects app bootstrap drift once and still enforces the gate', () => {
  const canonical = fs.readFileSync(BOOT, 'utf8');
  const matching = stopThroughApp(CLOSING, {}, [], 1, canonical);
  assert.equal(matching.status, 2);
  assert.doesNotMatch(matching.stdout, /DRIFT/);
  const drifted = stopThroughApp(CLOSING, {}, [], 2, canonical + '\n# stale app copy\n');
  assert.deepEqual(drifted.map(r => r.status), [2, 0]);
  assert.match(drifted[0].stdout, /bootstrap DRIFT/);
  assert.match(drifted[0].stderr, /child session with no human/);
  assert.equal(drifted[1].stdout + drifted[1].stderr, '');
});

test('missing jq warns, blocks a promise closing, and permits a retry', () => {
  const bin = tmp('bsc-no-jq-');
  for (const command of ['dirname', 'cat', 'grep']) {
    fs.symlinkSync(spawnSync('which', [command], { encoding: 'utf8' }).stdout.trim(), path.join(bin, command));
  }
  const runner = path.join(REPO, '.claude/hooks/lib/home-hook-runner.sh');
  for (const [message, retry, status] of [['All done.', false, 0], ["KEEP OPEN, I will check back.", false, 2], ['KEEP OPEN', true, 0]]) {
    const r = spawnSyncStdinFile('/bin/bash', [runner, 'verify-edits.sh'], {
      input: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: message, stop_hook_active: retry }),
      encoding: 'utf8', env: { ...process.env, PATH: bin }, timeout: 10000,
    });
    assert.equal(r.status, status, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /jq.*missing/i);
  }
});

test('turn identity preserves changed closings, retries, transcript growth, sessions and full checks', () => {
  const dir = tmp('bsc-turn-');
  const transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, JSON.stringify(lines[0]) + '\n');
  const payload = { hook_event_name: 'Stop', session_id: 'child', transcript_path: transcript, last_assistant_message: CLOSING, stop_hook_active: false };
  const helper = path.join(REPO, 'scripts/lib/stall-stop-runner.sh');
  const call = (changes = {}, codes = 'CHILDSTALL') => {
    const r = spawnSyncStdinFile('bash', ['-c', 'hook=verify-edits.sh; input=$(cat); source "$1"; echo CHECK', 'probe', helper], {
      input: JSON.stringify({ ...payload, ...changes }), encoding: 'utf8',
      env: { ...process.env, TMPDIR: dir, VE_ONLY_CODES: codes }, timeout: 10000,
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  assert.equal(call(), 'CHECK');
  assert.equal(call(), '');
  assert.equal(call({ last_assistant_message: CLOSING + ' More work pending.' }), 'CHECK');
  assert.equal(call({ stop_hook_active: true }), 'CHECK');
  fs.appendFileSync(transcript, JSON.stringify(lines[1]) + '\n');
  assert.equal(call(), 'CHECK');
  assert.equal(call({ session_id: 'other-child' }), 'CHECK');
  assert.equal(call({}, ''), 'CHECK');
  assert.equal(call({}, ''), 'CHECK');
  assert.equal(call({ transcript_path: '' }), 'CHECK');
  assert.equal(call({ session_id: '' }), 'CHECK');
});

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

// BRO-7194 probe 2: the inline fetch left no runner and the Stop passed a "KEEP OPEN, I will check back" turn.
test('no runner after the fetch: a promise-like closing fails CLOSED (exit 2) and the notice carries the fetch reason', () => {
  const env = { BSC_HOOKS_HOME: tmp('bsc-empty-'), BSC_HOOKS_REPO_URL: 'file:///nonexistent-bsc-repo' };
  const r = run('stop', env, JSON.stringify({ last_assistant_message: 'Waiting on a background job. KEEP OPEN, I will check back later.' }));
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /BLOCKED/);
  assert.match(r.stderr, /rc=128/); // the real git error, not a bare "not installed"
  assert.ok(fs.existsSync(path.join(env.BSC_HOOKS_HOME, '.bsc-hooks-fetch.log')));
});

test('no runner: the blocked retry (stop_hook_active) and non-promise closings pass with the reason in the notice', () => {
  const env = { BSC_HOOKS_HOME: tmp('bsc-empty-'), BSC_HOOKS_REPO_URL: 'file:///nonexistent-bsc-repo' };
  const retry = run('stop', env, JSON.stringify({ stop_hook_active: true, last_assistant_message: 'KEEP OPEN, I will check back.' }));
  assert.equal(retry.status, 0);
  assert.match(retry.stdout, /rc=128/);
  const plain = run('stop', env, JSON.stringify({ last_assistant_message: 'All done, tests pass.' }));
  assert.equal(plain.status, 0);
  assert.match(plain.stdout, /not installed/);
});

test('a full checkout that is still cloning (no runner yet) does not block the sparse fetch into .bsc-hooks', () => {
  const src = fakeRepo(); const home = tmp('bsc-home-');
  fs.mkdirSync(path.join(home, 'Broadwayscore/.git'), { recursive: true }); // half-cloned
  const env = { BSC_HOOKS_HOME: home, BSC_HOOKS_REPO_URL: 'file://' + src };
  assert.equal(run('fetch', env).status, 0);
  assert.ok(fs.existsSync(path.join(home, '.bsc-hooks/.claude/hooks/lib/home-hook-runner.sh')));
  assert.match(run('stop', env, '{}').stdout, /RUNNER hook=verify-edits\.sh/);
});
