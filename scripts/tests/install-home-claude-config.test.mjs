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
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLER = path.join(REPO_ROOT, 'scripts', 'install-home-claude-config.js');
const { buildSettings, MARK_KEY } = require(INSTALLER);

// realpath: macOS tmpdir is a /var symlink; git and the installer report /private/var.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bro-5221-home-')));
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
  encoding: 'utf8', env: { ...process.env, HOME: fakeHome, CLAUDE_CODE_REMOTE: '', ...env },
});

// Run one generated hook command the way Claude Code does: bash -c, cwd = session cwd.
function runGenerated(settings, event, hookName, payload, cwd) {
  const h = settings.hooks[event].flatMap((g) => g.hooks).find((x) => x.command.includes(` ${hookName};`));
  assert.ok(h, `${event}:${hookName} is wired`);
  return spawnSyncStdinFile('bash', ['-c', h.command], {
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
  for (const name of ['commands', 'skills', 'agents']) {
    assert.equal(fs.readlinkSync(path.join(target, '.claude', name)), path.join(REPO_ROOT, '.claude', name));
  }
  assert.ok(fs.existsSync(path.join(target, '.claude', 'commands', 'what-else.md')), '/what-else reachable');
  assert.ok(fs.existsSync(path.join(target, '.claude', 'commands', 'wrap-up.md')), '/wrap-up reachable');
  assert.ok(fs.existsSync(path.join(target, '.claude', 'agents', 'review-panelist.md')), 'review-panelist agent reachable (ship-check reviewers)');
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
    tool_input: { source_url: 'https://github.com/thomaspryor/broadwayscore', prompt: 'x', model: 'claude-sonnet-5-5' },
  }, target);
  assert.equal(deny.status, 0, deny.stderr);
  assert.match(deny.stdout, /"permissionDecision":\s*"deny"/, `got: ${deny.stdout}`);
  const ok = runGenerated(s, 'PreToolUse', 'block-prompting-remote-tools.sh', {
    tool_name: 'mcp__claude-code-remote__create_session',
    tool_input: { source_url: 'https://github.com/thomaspryor/Broadwayscore', prompt: 'x\nBUDGET: 6h\nREPORT-BACK: tell @parent', model: 'claude-sonnet-5-5' },
  }, target);
  assert.doesNotMatch(ok.stdout, /deny/, 'the canonical URL passes');
});

test('tool hooks skip work in another repo (the app keeps its main-only workflow)', () => {
  const { target, other } = makeTarget('t-scope');
  assert.equal(run(['--target', target]).status, 0);
  const s = JSON.parse(fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8'));
  // worktree-enforce blocks a scripts/ edit on a main checkout; the other repo is one.
  const direct = spawnSyncStdinFile('bash', [path.join(REPO_ROOT, '.claude', 'hooks', 'worktree-enforce.sh')], {
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

  const { target: t3 } = makeTarget('t-realagents');
  fs.mkdirSync(path.join(t3, '.claude', 'agents'), { recursive: true });
  const realAgents = run(['--target', t3]);
  assert.equal(realAgents.status, 2);
  assert.match(realAgents.stderr, /agents exists and is not a symlink/);
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
  assert.ok(!fs.existsSync(path.join(target, '.claude', 'agents')), 'agents link removed too');
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

test('--help prints usage and installs nothing', () => {
  const { target } = makeTarget('t-help');
  const r = run(['--help', '--target', target]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage/);
  assert.ok(!fs.existsSync(path.join(target, '.claude')), 'nothing written');
});

// BRO-6126: the owner's pasted setup line runs the installer with NO --target. In
// cloud the checkout is /home/user/Broadwayscore, so the default target is $HOME.
test('cloud one-liner: no --target, HOME = parent of the checkout, installs and --check passes', () => {
  const parent = path.dirname(REPO_ROOT);
  // The installer only writes under <HOME>/.claude; use a scratch copy of the layout
  // so the test never touches the real parent of this checkout.
  const cloudHome = path.join(scratch, 'home-user');
  const clone = path.join(cloudHome, 'Broadwayscore');
  fs.mkdirSync(path.join(clone, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(clone, '.claude'), { recursive: true });
  for (const f of ['install-home-claude-config.js']) fs.copyFileSync(path.join(REPO_ROOT, 'scripts', f), path.join(clone, 'scripts', f));
  fs.cpSync(path.join(REPO_ROOT, 'scripts', 'lib'), path.join(clone, 'scripts', 'lib'), { recursive: true });
  for (const f of ['settings.json', 'commands', 'skills', 'agents']) {
    if (fs.existsSync(path.join(REPO_ROOT, '.claude', f))) fs.symlinkSync(path.join(REPO_ROOT, '.claude', f), path.join(clone, '.claude', f));
  }
  assert.notEqual(parent, cloudHome);
  const cloudRun = (args, env = {}) => spawnSync('node', [path.join(clone, 'scripts', 'install-home-claude-config.js'), ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: cloudHome, ...env },
  });
  // Without the flag (a Mac, even one with no user settings) $HOME stays refused.
  const local = cloudRun([], { CLAUDE_CODE_REMOTE: '' });
  assert.equal(local.status, 2);
  assert.ok(!fs.existsSync(path.join(cloudHome, '.claude', 'settings.json')));
  for (const env of [{ CLAUDE_CODE_REMOTE: 'true' }]) {
    const r = cloudRun([], env);
    assert.equal(r.status, 0, `install with env ${JSON.stringify(env)}: ${r.stderr}`);
    assert.ok(fs.existsSync(path.join(cloudHome, '.claude', 'settings.json')), 'hooks land in $HOME/.claude');
    const c = cloudRun(['--check'], env);
    assert.equal(c.status, 0, c.stdout + c.stderr);
    assert.equal(cloudRun(['--uninstall'], env).status, 0);
  }
});

// BRO-6126: with $HOME as the cloud target the generated hooks also load in a session
// whose cwd is this checkout, which already wires them: the runner must stay out.
test('runner does not re-run a hook for a session whose cwd is this checkout', () => {
  const runner = path.join(REPO_ROOT, '.claude', 'hooks', 'lib', 'home-hook-runner.sh');
  const call = (cwd) => spawnSyncStdinFile('bash', [runner, 'block-prompting-remote-tools.sh'], {
    cwd, encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd, tool_name: 'mcp__claude-code-remote__create_session',
      tool_input: { source_url: 'https://github.com/thomaspryor/broadwayscore', prompt: 'x', model: 'claude-sonnet-5-5' } }),
    env: { ...process.env, HOME: fakeHome, CLAUDE_PROJECT_DIR: '' },
  });
  assert.match(call(scratch).stdout, /"permissionDecision":\s*"deny"/, 'control: from a non-repo cwd the hook denies');
  const inRepo = call(REPO_ROOT);
  assert.equal(inRepo.status, 0);
  assert.equal(inRepo.stdout.trim(), '', 'no hook output: the runner deduped');
});

// The saved cloud setup creates autoMode settings before invoking this installer.
test('explicit adoption preserves hookless owner settings through install, check, reinstall and uninstall', () => {
  const { target } = makeTarget('t-adopt');
  const file = path.join(target, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file));
  const original = { autoMode: { soft_deny: ['$defaults', 'no force push'] }, permissions: { deny: ['Bash(rm:*)'] } };
  fs.writeFileSync(file, JSON.stringify(original));
  assert.equal(run(['--target', target]).status, 2);
  assert.equal(run(['--target', target, '--adopt-hookless-settings']).status, 0);
  const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(installed.autoMode, original.autoMode);
  assert.deepEqual(installed.permissions, original.permissions);
  assert.ok(Object.keys(installed.hooks).length > 0);
  assert.equal(run(['--target', target, '--check']).status, 0);
  assert.equal(run(['--target', target]).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), installed);
  assert.equal(run(['--target', target, '--uninstall']).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
});

test('adoption refuses existing hooks, foreign ownership, malformed JSON and arrays without changing them', () => {
  for (const [i, raw] of ['{"hooks":{}}', '{"_generatedBy":"someone else"}', '{broken', '[]'].entries()) {
    const { target } = makeTarget('t-adopt-refuse-' + i);
    const file = path.join(target, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, raw);
    assert.equal(run(['--target', target, '--adopt-hookless-settings']).status, 2);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
});

test('the context window and effort default reach multi-repo sessions (BRO-6684)', () => {
  const real = JSON.parse(fs.readFileSync(path.join(path.dirname(INSTALLER), '..', '.claude', 'settings.json'), 'utf8'));
  const { settings } = buildSettings(real, '/home/user');
  assert.deepEqual(settings.env, real.env);
  assert.equal(settings.effortLevel, real.effortLevel);
  assert.ok(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, 'the repo sets an autocompact window');
  assert.equal(buildSettings({ hooks: {} }, '/home/user').settings.env, undefined, 'absent keys are not invented');
});

test('an owner env entry and effort level survive re-runs and uninstall (BRO-6684)', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'home-spend-'));
  fs.mkdirSync(path.join(t, '.claude'));
  const file = path.join(t, '.claude', 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ env: { FOO: '1' }, effortLevel: 'high' }));
  const run = (...a) => spawnSync(process.execPath, [INSTALLER, '--target', t, ...a], { encoding: 'utf8' });
  run('--adopt-hookless-settings');
  run();
  run();
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.env.FOO, '1');
  assert.ok(s.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, 'the repo window is added beside the owner entry');
  assert.equal(s.effortLevel, 'high');
  assert.equal(run('--check').status, 0, 'no drift after a re-run');
  run('--uninstall');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { env: { FOO: '1' }, effortLevel: 'high' });
});
