// BRO-6276: .claude/hooks/land-cancel-guard.sh refuses cancelling another
// session's Land run. Drives the real hook with the run injected through
// LAND_CANCEL_GUARD_RUN_JSON (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'land-cancel-guard.sh');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-6276-guard-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const ME = '01MineMineMineMineMine';
const run = (session, wf = '.github/workflows/land.yml') => JSON.stringify({
  path: wf, head_branch: 'land/x',
  head_commit: { message: `fix: thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_${session}` },
});
function hook(toolInput, runJson, extraEnv = {}, toolName = 'Bash') {
  const r = spawnSyncStdinFile('bash', [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    env: { PATH: process.env.PATH, HOME: home, CLAUDE_CODE_REMOTE_SESSION_ID: `cse_${ME}`, LAND_CANCEL_GUARD_RUN_JSON: runJson, ...extraEnv },
    encoding: 'utf8',
  });
  return { code: r.status, err: r.stderr };
}
const bash = (command) => ({ command });

test('refuses gh run cancel of another session\'s Land run', () => {
  const r = hook(bash('gh run cancel 40274353165'), run('01SomeoneElse'));
  assert.equal(r.code, 2);
  assert.match(r.err, /another session/);
});
test('allows cancelling this session\'s own Land run', () => {
  assert.equal(hook(bash('gh run cancel 40274353165'), run(ME)).code, 0);
});
test('allows cancelling a run of another workflow', () => {
  assert.equal(hook(bash('gh run cancel 40274353165'), run('01SomeoneElse', '.github/workflows/test.yml')).code, 0);
});
test('refuses the REST cancel and force-cancel forms', () => {
  for (const c of ['gh api -X POST repos/thomaspryor/Broadwayscore/actions/runs/40274353165/cancel',
    'gh api -X POST repos/{owner}/{repo}/actions/runs/40274353165/force-cancel']) {
    assert.equal(hook(bash(c), run('01SomeoneElse')).code, 2, c);
  }
});
test('refuses the MCP cancel_workflow_run call', () => {
  const r = hook({ method: 'cancel_workflow_run', owner: 'ThomasPryor', repo: 'Broadwayscore', run_id: 40274353165 },
    run('01SomeoneElse'), {}, 'mcp__github__actions_run_trigger');
  assert.equal(r.code, 2);
});
test('leaves other MCP methods and other repos alone', () => {
  assert.equal(hook({ method: 'rerun_workflow_run', owner: 'thomaspryor', repo: 'broadwayscore', run_id: 1234567 },
    run('01SomeoneElse'), {}, 'mcp__github__actions_run_trigger').code, 0);
  assert.equal(hook(bash('gh run cancel 40274353165 -R someone/else'), run('01SomeoneElse')).code, 0);
});
test('ignores commands that only mention cancel', () => {
  assert.equal(hook(bash('grep -n cancel scripts/land-retry-cancelled.js'), run('01SomeoneElse')).code, 0);
});
test('kill switch and unknown session fail open', () => {
  assert.equal(hook(bash('gh run cancel 40274353165'), run('01SomeoneElse'), { LAND_CANCEL_GUARD_OFF: '1' }).code, 0);
  assert.equal(hook(bash('gh run cancel 40274353165'), run('01SomeoneElse'), { CLAUDE_CODE_REMOTE_SESSION_ID: '' }).code, 0);
});
test('unreadable run fails open', () => {
  assert.equal(hook(bash('gh run cancel 40274353165'), 'not json').code, 0);
});
test('a -R on another command in the chain does not bypass the guard', () => {
  assert.equal(hook(bash('ls -R /tmp && gh run cancel 40274353165'), run('01SomeoneElse')).code, 2);
  assert.equal(hook(bash('gh run cancel 40274353165 --repo thomaspryor/Broadwayscore'), run('01SomeoneElse')).code, 2);
});
test('takes the run id after cancel, not another number in the command', () => {
  const r = hook(bash('sleep 1234567 ; gh run cancel "40274353165" 2>&1 | tail -n 1000000'), run('01SomeoneElse'));
  assert.equal(r.code, 2);
  assert.match(r.err, /40274353165/);
});
test('refuses the :owner/:repo REST form and a run URL', () => {
  for (const c of ['gh api -X POST repos/:owner/:repo/actions/runs/40274353165/cancel',
    'gh run cancel https://github.com/thomaspryor/Broadwayscore/actions/runs/40274353165']) {
    assert.equal(hook(bash(c), run('01SomeoneElse')).code, 2, c);
  }
});
test('block message names the kill switch', () => {
  assert.match(hook(bash('gh run cancel 40274353165'), run('01SomeoneElse')).err, /LAND_CANCEL_GUARD_OFF/);
});
