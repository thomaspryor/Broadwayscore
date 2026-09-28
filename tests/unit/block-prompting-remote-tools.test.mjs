// Runs the real .claude/hooks/block-prompting-remote-tools.sh (BRO-4236) against
// each tool call it must deny and each it must leave alone, and checks the real
// .claude/settings.json matcher routes exactly the intended tools to it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'block-prompting-remote-tools.sh');
const SETTINGS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));

const tmpDirs = [];
after(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function repoWithOrigin(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocker-'));
  tmpDirs.push(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  if (url) spawnSync('git', ['remote', 'add', 'origin', url], { cwd: dir });
  return dir;
}

const BSC = repoWithOrigin('https://github.com/thomaspryor/Broadwayscore');
const BSC_PROXY = repoWithOrigin('http://127.0.0.1:4242/git/thomaspryor/Broadwayscore.git');
const OTHER = repoWithOrigin('https://github.com/thomaspryor/BroadwayScorecard-app');
const LOOKALIKE = repoWithOrigin('https://github.com/notthomaspryor/Broadwayscore');
const NO_ORIGIN = repoWithOrigin(null);

function run(payload, { cwd = BSC, projectDir = cwd, env = {} } = {}) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const res = spawnSync('bash', [HOOK], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, HOME: os.tmpdir(), CLAUDE_PROJECT_DIR: projectDir, REMOTE_TOOL_BLOCKER_DISABLE: '', ...env },
  });
  assert.equal(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);
  const out = res.stdout.trim();
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'pass';
}

const remote = (tool, input) => ({ tool_name: `mcp__Claude_Code_Remote__${tool}`, tool_input: input });
const addRepo = (owner, repo) => remote('add_repo', { owner, repo, access: 'push' });

test('self-initiated send_later and create_trigger are denied', () => {
  for (const tool of ['send_later', 'create_trigger']) {
    assert.equal(run(remote(tool, { initiation: 'own_followup' })), 'deny', tool);
    assert.equal(run(remote(tool, { initiation: 'own_initiative' })), 'deny', tool);
    assert.equal(run(remote(tool, {})), 'deny', tool);
  }
});

test('send_later and create_trigger the owner asked for pass through', () => {
  for (const tool of ['send_later', 'create_trigger']) {
    assert.equal(run(remote(tool, { initiation: 'human_request' })), 'pass', tool);
    assert.equal(run(remote(tool, { initiation: 'human_schedule' })), 'pass', tool);
  }
});

test('old server spelling is covered', () => {
  assert.equal(run({ tool_name: 'mcp__claude-code-remote__send_later', tool_input: {} }), 'deny');
  assert.equal(run({ tool_name: 'mcp__claude-code-remote__create_trigger', tool_input: {} }), 'deny');
});

test('add_repo for Broadwayscore is denied when it is the project checkout', () => {
  assert.equal(run(addRepo('thomaspryor', 'Broadwayscore')), 'deny');
  assert.equal(run(addRepo('ThomasPryor', 'broadwayscore')), 'deny');
  assert.equal(run(addRepo('thomaspryor', 'Broadwayscore'), { cwd: BSC_PROXY }), 'deny');
});

test('add_repo decision follows the project dir, not the current directory', () => {
  assert.equal(run(addRepo('thomaspryor', 'Broadwayscore'), { cwd: NO_ORIGIN, projectDir: BSC }), 'deny');
  assert.equal(run(addRepo('thomaspryor', 'Broadwayscore'), { cwd: BSC, projectDir: OTHER }), 'pass');
});

test('add_repo for Broadwayscore passes when the project is a different repo', () => {
  assert.equal(run(addRepo('thomaspryor', 'Broadwayscore'), { cwd: OTHER }), 'pass');
  assert.equal(run(addRepo('thomaspryor', 'Broadwayscore'), { cwd: LOOKALIKE }), 'pass');
  assert.equal(run(addRepo('thomaspryor', 'Broadwayscore'), { cwd: NO_ORIGIN }), 'pass');
});

test('add_repo for any other repo passes', () => {
  assert.equal(run(addRepo('thomaspryor', 'BroadwayScorecard-app')), 'pass');
  assert.equal(run(addRepo('thomaspryor', 'broadwayscore-core-data')), 'pass');
  assert.equal(run(addRepo('someoneelse', 'Broadwayscore')), 'pass');
});

test('unrelated tools, malformed input and the kill switch all pass', () => {
  assert.equal(run(remote('update_trigger', {})), 'pass');
  assert.equal(run(remote('subscribe_pr_activity', {})), 'pass');
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'ls' } }), 'pass');
  assert.equal(run('not json'), 'pass');
  assert.equal(run(remote('send_later', {}), { env: { REMOTE_TOOL_BLOCKER_DISABLE: '1' } }), 'pass');
});

test('settings.json routes exactly the three tools to this hook', () => {
  const entries = SETTINGS.hooks.PreToolUse.filter((e) =>
    e.hooks.some((h) => h.command.includes('block-prompting-remote-tools.sh')));
  assert.equal(entries.length, 1);
  const re = new RegExp(`^(?:${entries[0].matcher})$`);
  for (const server of ['Claude_Code_Remote', 'claude-code-remote']) {
    for (const tool of ['send_later', 'create_trigger', 'add_repo']) {
      assert.ok(re.test(`mcp__${server}__${tool}`), `${server}__${tool} should match`);
    }
    for (const tool of ['update_trigger', 'delete_trigger', 'fire_trigger', 'subscribe_pr_activity', 'create_session']) {
      assert.ok(!re.test(`mcp__${server}__${tool}`), `${server}__${tool} should not match`);
    }
  }
  for (const tool of ['Bash', 'Edit', 'ScheduleWakeup', 'Monitor', 'mcp__github__create_branch']) {
    assert.ok(!re.test(tool), `${tool} should not match`);
  }
});
