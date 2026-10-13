// BRO-5221: cloud sessions that start in /home/user (multi-repo, or a create_session
// with a misspelled source_url) loaded none of this repo's hooks, and the misspelled
// kind none of its commands. scripts/install-home-claude-config.js wires them into
// <target>/.claude; this drives the real installer, the real generated commands, the
// real runner and real hooks (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLER = path.join(REPO_ROOT, 'scripts', 'install-home-claude-config.js');
const { buildSettings, MARK_KEY } = require(INSTALLER);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-5221-home-'));
const fakeHome = path.join(scratch, 'root');   // $HOME: no ~/.claude/hooks, so repo hooks never self-skip
fs.mkdirSync(fakeHome);
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

// A /home/user stand-in: this checkout under a lowercase name (the misspelled-URL
// shape) plus another git repo, like the app checkout.
function makeTarget(name) {
  const target = path.join(scratch, name);
  fs.mkdirSync(target);
  fs.symlinkSync(REPO_ROOT, path.join(target, 'broadwayscore'));
  const other = path.join(target, 'OtherApp');
  fs.mkdirSync(path.join(other, 'scripts'), { recursive: true });
  spawnSync('git', ['init', '-q', other]);
  return { target, other };
}

const run = (args, env = {}) => spawnSync('node', [INSTALLER, ...args], {
  encoding: 'utf8', env: { ...process.env, HOME: fakeHome, ...env },
});

// Run one generated hook command the way Claude Code does: bash -c, cwd = session cwd.
function runGenerated(settings, event, hookName, payload, cwd) {
  const h = settings.hooks[event].flatMap((g) => g.hooks).find((x) => x.command.includes(` ${hookName};`));
  assert.ok(h, `${event}:${hookName} is wired`);
  return spawnSync('bash', ['-c', h.command], {
    cwd, input: JSON.stringify({ hook_event_name: event, cwd, ...payload }), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HOME: fakeHome, CLAUDE_PROJECT_DIR: '' },
  });
}

test('every hook in .claude/settings.json is wired, with its event, matcher and timeout', () => {
  const repo = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));
  const expected = [];
  for (const [ev, groups] of Object.entries(repo.hooks)) {
    for (const g of groups) for (const h of g.hooks) {
      const m = /\.claude\/hooks\/([\w.-]+\.sh)/.exec(h.command);
      if (m) expected.push(`${ev}|${g.matcher ?? ''}|${m[1]}|${h.timeout ?? ''}`);
    }
  }
  const { settings, wired } = buildSettings(repo, '/home/user');
  const got = [];
  for (const [ev, groups] of Object.entries(settings.hooks)) {
    for (const g of groups) for (const h of g.hooks) got.push(`${ev}|${g.matcher ?? ''}|${/ ([\w.-]+\.sh);/.exec(h.command)[1]}|${h.timeout ?? ''}`);
  }
  assert.deepEqual(got.sort(), expected.sort());
  assert.ok(wired.includes('Stop:verify-edits.sh'), 'the finish-chain Stop gate is wired');
  assert.ok(wired.some((w) => w.endsWith(':block-prompting-remote-tools.sh')), 'the create_session URL guard is wired');
});

test('install writes settings + command/skill links; --check passes; re-install is a no-op', () => {
  const { target } = makeTarget('t-install');
  const r = run(['--target', target]);
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8'));
  assert.ok(s[MARK_KEY]);
  for (const name of ['commands', 'skills']) {
    assert.equal(fs.readlinkSync(path.join(target, '.claude', name)), path.join(REPO_ROOT, '.claude', name));
  }
  assert.ok(fs.existsSync(path.join(target, '.claude', 'commands', 'what-else.md')), '/what-else reachable');
  assert.ok(fs.existsSync(path.join(target, '.claude', 'commands', 'wrap-up.md')), '/wrap-up reachable');
  const mtime = fs.statSync(path.join(target, '.claude', 'settings.json')).mtimeMs;
  assert.equal(run(['--target', target]).status, 0);
  assert.equal(fs.statSync(path.join(target, '.claude', 'settings.json')).mtimeMs, mtime, 'unchanged output is not rewritten');
  assert.equal(run(['--target', target, '--check']).status, 0);
});

test('generated PreToolUse command reaches the real hook from a non-repo cwd: misspelled create_session is denied', () => {
  const { target } = makeTarget('t-guard');
  assert.equal(run(['--target', target]).status, 0);
  const s = JSON.parse(fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8'));
  const deny = runGenerated(s, 'PreToolUse', 'block-prompting-remote-tools.sh', {
    tool_name: 'mcp__claude-code-remote__create_session',
    tool_input: { source_url: 'https://github.com/thomaspryor/broadwayscore', prompt: 'x' },
  }, target);
  assert.equal(deny.status, 0, deny.stderr);
  assert.match(deny.stdout, /"permissionDecision":\s*"deny"/, `got: ${deny.stdout}`);
  const ok = runGenerated(s, 'PreToolUse', 'block-prompting-remote-tools.sh', {
    tool_name: 'mcp__claude-code-remote__create_session',
    tool_input: { source_url: 'https://github.com/thomaspryor/Broadwayscore', prompt: 'x' },
  }, target);
  assert.doesNotMatch(ok.stdout, /deny/, 'the canonical URL passes');
});

test('tool hooks skip work in another repo (the app keeps its main-only workflow)', () => {
  const { target, other } = makeTarget('t-scope');
  assert.equal(run(['--target', target]).status, 0);
  const s = JSON.parse(fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8'));
  // worktree-enforce blocks a scripts/ edit on a main checkout; the other repo is one.
  const direct = spawnSync('bash', [path.join(REPO_ROOT, '.claude', 'hooks', 'worktree-enforce.sh')], {
    cwd: other, encoding: 'utf8',
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(other, 'scripts', 'x.js') } }),
    env: { ...process.env, HOME: fakeHome },
  });
  assert.equal(direct.status, 2, 'control: the hook itself would block this edit');
  const viaRunner = runGenerated(s, 'PreToolUse', 'worktree-enforce.sh',
    { tool_name: 'Write', tool_input: { file_path: path.join(other, 'scripts', 'x.js') } }, target);
  assert.equal(viaRunner.status, 0, `skipped for another repo; stderr: ${viaRunner.stderr}`);
  const bashOther = runGenerated(s, 'PreToolUse', 'worktree-enforce.sh',
    { tool_name: 'Bash', tool_input: { command: `cd ${other} && echo hi > scripts/y.js` } }, target);
  assert.equal(bashOther.status, 0, `a Bash command that cds into another repo is skipped; stderr: ${bashOther.stderr}`);
});

test('refuses $HOME as target, a hand-written settings.json, and a real commands dir', () => {
  const home = run(['--target', fakeHome]);
  assert.equal(home.status, 2);
  assert.match(home.stderr, /is \$HOME/);

  const { target } = makeTarget('t-foreign');
  fs.mkdirSync(path.join(target, '.claude'));
  fs.writeFileSync(path.join(target, '.claude', 'settings.json'), '{"hooks":{}}');
  const foreign = run(['--target', target]);
  assert.equal(foreign.status, 2);
  assert.match(foreign.stderr, /not written by this script/);

  const { target: t2 } = makeTarget('t-realdir');
  fs.mkdirSync(path.join(t2, '.claude', 'commands'), { recursive: true });
  const realdir = run(['--target', t2]);
  assert.equal(realdir.status, 2);
  assert.match(realdir.stderr, /not a symlink/);
});

test('--check reports drift; --uninstall removes only what it installed', () => {
  const { target } = makeTarget('t-drift');
  assert.equal(run(['--target', target, '--check']).status, 1, 'nothing installed yet');
  assert.equal(run(['--target', target]).status, 0);
  const p = path.join(target, '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  delete s.hooks.Stop;
  fs.writeFileSync(p, JSON.stringify(s));
  const d = run(['--target', target, '--check']);
  assert.equal(d.status, 1);
  assert.match(d.stdout, /DRIFT/);
  assert.equal(run(['--target', target, '--uninstall']).status, 0);
  assert.ok(!fs.existsSync(p));
  assert.ok(!fs.existsSync(path.join(target, '.claude', 'commands')));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, '.claude', 'commands', 'wrap-up.md')), 'the repo copy is untouched');
});

test('guards that are not repo-scoped still run when the work is in another repo (ship-check P1)', () => {
  const { target, other } = makeTarget('t-unscoped');
  assert.equal(run(['--target', target]).status, 0);
  const s = JSON.parse(fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8'));
  const resend = runGenerated(s, 'PreToolUse', 'block-resend-broadcasts.sh',
    { tool_name: 'Bash', tool_input: { command: `cd ${other} && curl -X POST https://api.resend.com/broadcasts/abc/send` } }, other);
  assert.ok(resend.status === 2 || /deny|BLOCK/i.test(resend.stdout + resend.stderr), `broadcast guard fired from the other repo; got ${resend.status} ${resend.stdout}${resend.stderr}`);
  const url = runGenerated(s, 'PreToolUse', 'block-prompting-remote-tools.sh', {
    tool_name: 'mcp__claude-code-remote__create_session',
    tool_input: { source_url: 'https://github.com/thomaspryor/broadwayscore', prompt: 'x' },
  }, other);
  assert.match(url.stdout, /"permissionDecision":\s*"deny"/, 'create_session guard fires with the cwd in another repo');
});

test('a relative Bash path from the non-repo home is not judged as a checkout file (ship-check P2)', () => {
  const { target } = makeTarget('t-relative');
  assert.equal(run(['--target', target]).status, 0);
  const s = JSON.parse(fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8'));
  const r = runGenerated(s, 'PreToolUse', 'worktree-enforce.sh',
    { tool_name: 'Bash', tool_input: { command: 'echo x > scripts/notes.js' } }, target);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
});
