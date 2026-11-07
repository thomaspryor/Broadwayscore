// Runs the real .claude/hooks/block-prompting-remote-tools.sh (BRO-4236) against
// each tool call it must deny and each it must leave alone, and checks the real
// .claude/settings.json matcher routes exactly the intended tools to it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnSyncStdinFile } from '../helpers/spawn-stdin-file.mjs';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'block-prompting-remote-tools.sh');
const SETTINGS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));

const tmpDirs = [];
after(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));

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
const BSC_SSH = repoWithOrigin('git@github.com:thomaspryor/Broadwayscore.git');
const LOOKALIKE_SSH = repoWithOrigin('git@github.com:thomaspryor/Broadwayscore-fork.git');

function run(payload, { cwd = BSC, projectDir = cwd, env = {} } = {}) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const res = spawnSyncStdinFile('bash', [HOOK], {
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

test('re-arming a watch the owner set up earlier is denied (prompts while they sleep)', () => {
  for (const tool of ['send_later', 'create_trigger']) {
    assert.equal(run(remote(tool, { initiation: 'human_schedule' })), 'deny', tool);
  }
});

test('send_later and create_trigger the owner is asking for now pass through', () => {
  for (const tool of ['send_later', 'create_trigger']) {
    assert.equal(run(remote(tool, { initiation: 'human_request' })), 'pass', tool);
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

test('add_repo matching tolerates .git suffixes, stray spaces and SSH origins', () => {
  assert.equal(run(addRepo('thomaspryor', 'Broadwayscore.git')), 'deny');
  assert.equal(run(addRepo(' thomaspryor ', ' Broadwayscore ')), 'deny');
  assert.equal(run(addRepo('thomaspryor', 'Broadwayscore'), { cwd: BSC_SSH }), 'deny');
  assert.equal(run(addRepo('thomaspryor', 'Broadwayscore'), { cwd: LOOKALIKE_SSH }), 'pass');
  assert.equal(run(addRepo('thomaspryor', 'Broadwayscore-fork.git')), 'pass');
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

test('list_sessions is denied for both server spellings (BRO-4635)', () => {
  assert.equal(run(remote('list_sessions', { limit: 15, mine: true })), 'deny');
  assert.equal(run(remote('list_sessions', {})), 'deny');
  assert.equal(run({ tool_name: 'mcp__claude-code-remote__list_sessions', tool_input: {} }), 'deny');
  assert.equal(run(remote('list_sessions', {}), { env: { REMOTE_TOOL_BLOCKER_DISABLE: '1' } }), 'pass');
});

const SONNET = 'claude-sonnet-5-5';

test('create_session passes for both server spellings: the owner wants sessions started (BRO-5040, supersedes BRO-4664)', () => {
  assert.equal(run(remote('create_session', { prompt: 'x\nBUDGET: 6h\nREPORT-BACK: tell @parent', model: SONNET, source_url: 'https://github.com/thomaspryor/Broadwayscore' })), 'pass');
  assert.equal(run({ tool_name: 'mcp__claude-code-remote__create_session', tool_input: { model: SONNET } }), 'pass');
  assert.equal(run(remote('create_session', { prompt: 'x', model: SONNET, source_url: 'https://github.com/thomaspryor/BroadwayScorecard-app' })), 'pass');
  assert.equal(run(remote('create_session', { prompt: 'x', model: SONNET, source_url: 'https://github.com/thomaspryor/broadway-scorecard-data' })), 'pass');
  assert.equal(run(remote('create_session', { prompt: 'x', model: SONNET, source_url: 'https://github.com/someone-else/broadwayscore' })), 'pass');
});

test('create_session without an explicit model is denied: it would inherit the parent\'s Opus (BRO-5228)', () => {
  const url = 'https://github.com/thomaspryor/Broadwayscore';
  for (const model of [undefined, '', '  ', null]) {
    assert.equal(run(remote('create_session', { prompt: 'x', model, source_url: url })), 'deny', String(model));
    assert.equal(run({ tool_name: 'mcp__claude-code-remote__create_session', tool_input: { model } }), 'deny', String(model));
  }
  assert.equal(run(remote('create_session', { prompt: 'x', source_url: url }), { env: { REMOTE_TOOL_BLOCKER_DISABLE: '1' } }), 'pass');
});

test('create_session model: Sonnet/Haiku pass in any spelling; Fable and short aliases are denied (BRO-5228)', () => {
  for (const model of ['claude-sonnet-5-5', 'Claude-Sonnet-5-5', ' claude-sonnet-5-5 ', 'claude-sonnet-5-5[1m]', 'claude-haiku-5-5', 'claude-sonnet-4-6']) {
    assert.equal(run(remote('create_session', { prompt: 'x', model })), 'pass', model);
  }
  for (const model of ['claude-fable-5-1', 'Claude-Fable-5-1[1m]', 'mythos', 'sonnet', 'opus', 'gpt-5', 'claude-sonnet', 5, { id: 'claude-sonnet-5-5' }, ['claude-sonnet-5-5']]) {
    assert.equal(run(remote('create_session', { prompt: 'MODEL-REASON: P0', model })), 'deny', JSON.stringify(model));
  }
});

test('create_session on Opus needs a non-empty MODEL-REASON: line in the prompt (BRO-5228)', () => {
  for (const model of ['claude-opus-5-5', 'CLAUDE-OPUS-5-5', 'claude-opus-5-5[1m]']) {
    assert.equal(run(remote('create_session', { prompt: 'Fix BRO-1.', model })), 'deny', model);
    assert.equal(run(remote('create_session', { model })), 'deny', model);
    assert.equal(run(remote('create_session', { prompt: 'Fix BRO-1.\nMODEL-REASON:   \n', model })), 'deny', model);
    assert.equal(run(remote('create_session', { prompt: 'Fix BRO-1. MODEL-REASON: inline is not a line', model })), 'deny', model);
    // The MODEL-REASON layer alone (BRO-6684's card re-check switched off):
    const old = { env: { OPUS_BUDGET_DISABLED: '1' } };
    assert.equal(run(remote('create_session', { prompt: 'Fix BRO-1.\nMODEL-REASON: P0\nThen land it.', model }), old), 'pass', model);
    assert.equal(run(remote('create_session', { prompt: 'MODEL-REASON: owner asked for Opus', model }), old), 'pass', model);
  }
});

test('create_session on Opus also needs the card policy or an OWNER-ASKED-OPUS: line (BRO-6684)', () => {
  const model = 'claude-opus-5-5';
  const source_url = 'https://github.com/thomaspryor/Broadwayscore';
  const tail = '\nREPORT-BACK: send_message @parent';
  // No card in title or tags and no owner line: a free-text reason is no longer enough.
  assert.equal(run(remote('create_session', { prompt: `MODEL-REASON: big data job\nBUDGET: 3h${tail}`, model, source_url })), 'deny');
  assert.equal(run(remote('create_session', { prompt: `MODEL-REASON: owner asked\nOWNER-ASKED-OPUS: "run this on opus"\nBUDGET: 3h${tail}`, model, source_url })), 'pass');
  assert.equal(run(remote('create_session', { prompt: `MODEL-REASON: owner asked\nOWNER-ASKED-OPUS: "run this on opus"\nBUDGET: 6h${tail}`, model, source_url })), 'deny');
  // Other repos (the iOS app) are not Broadwayscore card work: only the BRO-5228 line applies.
  assert.equal(run(remote('create_session', { prompt: 'MODEL-REASON: owner asked', model, source_url: 'https://github.com/thomaspryor/BroadwayScorecard-app' })), 'pass');
});

test('create_session with a misspelled Broadwayscore source_url is denied (BRO-5068: lowercase starts in /home/user, no commands or hooks)', () => {
  for (const url of ['https://github.com/thomaspryor/broadwayscore', 'https://github.com/thomaspryor/BROADWAYSCORE',
    'https://github.com/thomaspryor/Broadwayscore.git', 'https://github.com/thomaspryor/Broadwayscore/',
    ' https://github.com/thomaspryor/broadwayscore', 'http://github.com/thomaspryor/Broadwayscore', 'https://www.github.com/thomaspryor/Broadwayscore',
    'git@github.com:thomaspryor/Broadwayscore.git', 'https://github.com/thomaspryor/Broadwayscore.git/', 'https://github.com/thomaspryor/broadwayscore/tree/main',
    'github.com/thomaspryor/broadwayscore', 'https://github.com/ThomasPryor/Broadwayscore']) {
    assert.equal(run(remote('create_session', { prompt: 'x', model: SONNET, source_url: url })), 'deny', url);
    assert.equal(run({ tool_name: 'mcp__claude-code-remote__create_session', tool_input: { model: SONNET, source_url: url } }), 'deny', url);
  }
});

test('a Broadwayscore worker session needs a BUDGET: <1-12>h line (BRO-5673: sessions ran 8 to 28 h uncapped)', () => {
  const url = 'https://github.com/thomaspryor/Broadwayscore';
  for (const prompt of ['Fix BRO-1.', 'Fix BRO-1. BUDGET: 6h inline is not a line', 'BUDGET: 0h', 'BUDGET: 13h', 'BUDGET: 6', 'BUDGET: six hours', 'BUDGET:\n6h']) {
    assert.equal(run(remote('create_session', { prompt, model: SONNET, source_url: url })), 'deny', prompt);
  }
  assert.equal(run(remote('create_session', { model: SONNET, source_url: url })), 'deny');
  for (const prompt of ['Fix BRO-1.\nBUDGET: 6h\nThen land it.', 'BUDGET: 1h', '  BUDGET:12h', 'BUDGET: 4h (wall clock)']) {
    assert.equal(run(remote('create_session', { prompt: `${prompt}\nREPORT-BACK: tell @parent`, model: SONNET, source_url: url })), 'pass', prompt);
  }
  // Other repos and sessions with no source_url are not worker sessions of this project.
  assert.equal(run(remote('create_session', { prompt: 'x', model: SONNET, source_url: 'https://github.com/thomaspryor/BroadwayScorecard-app' })), 'pass');
  assert.equal(run(remote('create_session', { prompt: 'x', model: SONNET })), 'pass');
  assert.equal(run(remote('create_session', { prompt: 'x', model: SONNET, source_url: url }), { env: { REMOTE_TOOL_BLOCKER_DISABLE: '1' } }), 'pass');
});

test('a Broadwayscore worker session needs a REPORT-BACK: line so the parent is woken when it ends (BRO-5781)', () => {
  const url = 'https://github.com/thomaspryor/Broadwayscore';
  const reason = (payload) => {
    const res = spawnSyncStdinFile('bash', [HOOK], {
      cwd: BSC, input: JSON.stringify(payload), encoding: 'utf8',
      env: { ...process.env, HOME: os.tmpdir(), CLAUDE_PROJECT_DIR: BSC, REMOTE_TOOL_BLOCKER_DISABLE: '' },
    });
    const out = res.stdout.trim();
    return out ? JSON.parse(out).hookSpecificOutput.permissionDecisionReason : '';
  };
  for (const prompt of ['BUDGET: 6h', 'BUDGET: 6h\nREPORT-BACK:', 'BUDGET: 6h\nreport back to your parent', 'BUDGET: 6h REPORT-BACK: inline is not a line']) {
    assert.equal(run(remote('create_session', { prompt, model: SONNET, source_url: url })), 'deny', prompt);
  }
  assert.match(reason(remote('create_session', { prompt: 'BUDGET: 6h', model: SONNET, source_url: url })), /REPORT-BACK/);
  // One deny names both missing lines.
  const both = reason(remote('create_session', { prompt: 'Fix BRO-1.', model: SONNET, source_url: url }));
  assert.match(both, /BUDGET/);
  assert.match(both, /REPORT-BACK/);
  assert.equal(run(remote('create_session', { prompt: 'BUDGET: 6h\n  REPORT-BACK: send_message @parent when done', model: SONNET, source_url: url })), 'pass');
});

test('unrelated tools, malformed input and the kill switch all pass', () => {
  assert.equal(run(remote('update_trigger', {})), 'pass');
  assert.equal(run(remote('subscribe_pr_activity', {})), 'pass');
  for (const tool of ['get_session', 'list_events']) assert.equal(run(remote(tool, {})), 'pass', tool);
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'ls' } }), 'pass');
  assert.equal(run('not json'), 'pass');
  assert.equal(run(remote('send_later', {}), { env: { REMOTE_TOOL_BLOCKER_DISABLE: '1' } }), 'pass');
});

test('settings.json routes exactly the five tools to this hook', () => {
  const entries = SETTINGS.hooks.PreToolUse.filter((e) =>
    e.hooks.some((h) => h.command.includes('block-prompting-remote-tools.sh')));
  assert.equal(entries.length, 1);
  const re = new RegExp(`^(?:${entries[0].matcher})$`);
  for (const server of ['Claude_Code_Remote', 'claude-code-remote']) {
    for (const tool of ['send_later', 'create_trigger', 'add_repo', 'list_sessions', 'create_session']) {
      assert.ok(re.test(`mcp__${server}__${tool}`), `${server}__${tool} should match`);
    }
    for (const tool of ['update_trigger', 'delete_trigger', 'fire_trigger', 'subscribe_pr_activity', 'get_session', 'list_events']) {
      assert.ok(!re.test(`mcp__${server}__${tool}`), `${server}__${tool} should not match`);
    }
  }
  for (const tool of ['Bash', 'Edit', 'ScheduleWakeup', 'Monitor', 'mcp__github__create_branch']) {
    assert.ok(!re.test(tool), `${tool} should not match`);
  }
});
