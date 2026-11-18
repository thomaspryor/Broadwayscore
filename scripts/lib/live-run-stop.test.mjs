// BRO-7738: pins live-run-stop.mjs. The incident shape (edit the Sentry triage script, land, close on unit tests)
// must block; a dispatch of its workflow plus a read of the run, or a direct run of the script, must allow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowScriptIndex, stopHookDecision, blockBudget, loadWorkflows } from './live-run-stop.mjs';

const ENV = { CLAUDE_CODE_REMOTE: 'true' };
const SAFE = 'Done.\n\nSAFE TO ARCHIVE — all landed';
const W = '/home/user/Broadwayscore/.claude/worktrees/x/';
let n = 0;
const use = (name, input, result = 'ok', isError = false) => { const id = `t${++n}`; return [{ kind: 'assistant_tool_use', name, input, id }, { kind: 'tool_result', tool_use_id: id, content: result, isError }]; };
const edit = (f) => use('Edit', { file_path: W + f, old_string: 'a', new_string: 'b' });
const bash = (command, out = 'ok', err = false) => use('Bash', { command }, out, err);
const land = () => bash('git push origin HEAD:refs/heads/land/x');
const landed = () => [...land(), ...bash('node scripts/lib/wait-for-land.js land/x')];
const unitTests = () => bash('node --test scripts/triage-sentry.test.mjs');
const index = workflowScriptIndex({
  'sentry-triage.yml': 'jobs:\n  t:\n    steps:\n      - run: node scripts/triage-sentry.js\n',
  'test.yml': '      - run: node scripts/only-in-tests.js\n',
  'other.yml': '      # node scripts/commented-out.js\n      - run: echo hi # scripts/trailing-comment.js\n',
});
const decide = (events, lastMessage = SAFE) => stopHookDecision({ lastMessage, events, env: ENV, index });

test('workflowScriptIndex: direct refs only; test.yml, land.yml and comments do not count', () => {
  assert.deepEqual(index.get('scripts/triage-sentry.js'), ['sentry-triage.yml']);
  assert.equal(index.has('scripts/only-in-tests.js'), false);
  assert.equal(index.has('scripts/commented-out.js'), false);
  assert.equal(index.has('scripts/trailing-comment.js'), false);
});

test('the incident: edit triage script, unit tests, land, SAFE TO ARCHIVE -> block naming the file and workflow', () => {
  const d = decide([...edit('scripts/triage-sentry.js'), ...unitTests(), ...land()]);
  assert.equal(d.decision, 'block');
  assert.match(d.message, /scripts\/triage-sentry\.js \(run by sentry-triage\.yml\)/);
});

test('dispatching the matching workflow after landing and reading the run -> allow', () => {
  const trig = use('mcp__github__actions_run_trigger', { method: 'run_workflow', workflow_id: 'sentry-triage.yml', ref: 'main' });
  const read = use('mcp__github__actions_get', { method: 'get_workflow_run', resource_id: '1' });
  assert.equal(decide([...edit('scripts/triage-sentry.js'), ...landed(), ...trig, ...read]).decision, 'allow');
  assert.equal(decide([...edit('scripts/triage-sentry.js'), ...landed(), ...bash('node scripts/cloud-dispatch.js sentry-triage.yml && node scripts/lib/wait-for-run.sh 1')]).decision, 'allow', 'chained dispatch + wait');
  assert.equal(decide([...edit('scripts/triage-sentry.js'), ...landed(), ...bash('node scripts/cloud-dispatch.js sentry-triage.yml --wait')]).decision, 'allow', 'the remedy the block message names');
});

test('a dispatch alone, a dispatch of the wrong workflow, or a dispatch before landing does not count', () => {
  const trig = (wf) => use('mcp__github__actions_run_trigger', { workflow_id: wf });
  const read = () => use('mcp__github__actions_get', { resource_id: '1' });
  assert.equal(decide([...edit('scripts/triage-sentry.js'), ...land(), ...trig('sentry-triage.yml')]).decision, 'block', 'never read the result');
  assert.equal(decide([...edit('scripts/triage-sentry.js'), ...land(), ...trig('vercel-deploy.yml'), ...read()]).decision, 'block', 'wrong workflow');
  assert.equal(decide([...edit('scripts/triage-sentry.js'), ...trig('sentry-triage.yml'), ...read(), ...land()]).decision, 'block', 'ran the old code');
  assert.equal(decide([...edit('scripts/triage-sentry.js'), ...landed(), ...use('mcp__github__actions_run_trigger', { workflow_id: 'sentry-triage.yml' }, 'error', true), ...read()]).decision, 'block', 'failed dispatch');
  assert.equal(decide([...edit('scripts/triage-sentry.js'), ...land(), ...trig('sentry-triage.yml'), ...read()]).decision, 'block', 'dispatched before the land merged: old code');
  assert.equal(decide([...edit('scripts/triage-sentry.js'), ...landed(), ...trig('sentry-triage.yml'), ...use('mcp__github__actions_list', { method: 'list_workflows' })]).decision, 'block', 'listing workflows is not reading the run');
  assert.equal(decide([...edit('scripts/triage-sentry.js'), ...landed(), ...bash('grep -n cloud-dispatch.js .github/workflows/sentry-triage.yml'), ...read()]).decision, 'block', 'a grep is not a dispatch');
});

test('running the edited script itself after the last edit counts; --help, node --check, a failed run or a run before the edit do not', () => {
  const E = () => edit('scripts/triage-sentry.js');
  assert.equal(decide([...E(), ...bash('node scripts/triage-sentry.js --dry-run'), ...land()]).decision, 'allow', 'dry run on real data');
  assert.equal(decide([...E(), ...bash(`cd ${W} && node ${W}scripts/triage-sentry.js | tail -5`), ...land()]).decision, 'allow', 'absolute path');
  assert.equal(decide([...E(), ...bash('node scripts/triage-sentry.js --help'), ...land()]).decision, 'block', '--help');
  assert.equal(decide([...E(), ...bash('node --check scripts/triage-sentry.js'), ...land()]).decision, 'block', 'syntax check');
  assert.equal(decide([...E(), ...bash('node scripts/triage-sentry.js', 'boom', true), ...land()]).decision, 'block', 'errored');
  assert.equal(decide([...bash('node scripts/triage-sentry.js'), ...E(), ...land()]).decision, 'block', 'ran before the edit');
  assert.equal(decide([...E(), ...bash("cat <<'X'\nnode scripts/triage-sentry.js\nX"), ...land()]).decision, 'block', 'heredoc text is not a run');
  assert.equal(decide([...E(), ...bash('echo node scripts/triage-sentry.js'), ...land()]).decision, 'block', 'echo is not a run');
  assert.equal(decide([...E(), ...bash('node scripts/triage-sentry.js | tail -3', 'TypeError: x is not a function'), ...land()]).decision, 'block', 'piped failure');
  assert.equal(decide([...E(), ...bash('node --check a.js && node scripts/triage-sentry.js --dry-run'), ...land()]).decision, 'allow', 'a check of another file does not void the run');
});

test('out of scope: no land, a non-live file, test.yml, only KEEP OPEN, bypass, not cloud', () => {
  assert.equal(decide([...edit('scripts/triage-sentry.js'), ...unitTests()]).decision, 'allow', 'nothing landed');
  assert.equal(decide([...edit('scripts/lib/some-helper.js'), ...land()]).decision, 'allow', 'not run by a workflow directly');
  assert.equal(decide([...edit('.github/workflows/test.yml'), ...land()]).decision, 'allow', 'test.yml runs on the land itself');
  assert.equal(decide([...edit('scripts/triage-sentry.js'), ...land()], 'KEEP OPEN — waiting on the run').decision, 'allow');
  assert.equal(decide([...edit('scripts/triage-sentry.js'), ...land()], 'NO-LIVE-RUN: sends real email to readers\nSAFE TO ARCHIVE — x').decision, 'allow');
  assert.equal(decide([...edit('scripts/triage-sentry.js'), ...land()], 'NO-LIVE-RUN: short\nSAFE TO ARCHIVE — x').decision, 'block', 'reason too short');
  assert.equal(stopHookDecision({ lastMessage: SAFE, events: [...edit('scripts/triage-sentry.js'), ...land()], env: {}, index }).decision, 'allow');
});

test('an edited workflow file needs a dispatch of itself; an edit after the last land is not judged', () => {
  assert.equal(decide([...edit('.github/workflows/sentry-triage.yml'), ...land()]).decision, 'block');
  assert.equal(decide([...edit('.github/workflows/sentry-triage.yml'), ...landed(), ...use('mcp__github__actions_run_trigger', { workflow_id: 'sentry-triage.yml' }), ...use('mcp__github__get_job_logs', { run_id: 1 })]).decision, 'allow');
  assert.equal(decide([...land(), ...edit('scripts/triage-sentry.js')]).decision, 'allow');
});

test('the chunk starts after the previous SAFE TO ARCHIVE claim', () => {
  const prev = { kind: 'assistant_text', text: 'SAFE TO ARCHIVE — earlier work' };
  assert.equal(decide([...edit('scripts/triage-sentry.js'), ...land(), prev, ...bash('echo later')]).decision, 'allow');
});

test('rollout: one nudge before the blocking date, two after', () => {
  assert.equal(blockBudget(new Date('2026-11-20T00:00:00Z')), 1);
  assert.equal(blockBudget(new Date('2026-11-25T00:00:00Z')), 2);
});

test('the real repo: triage-sentry.js is indexed under sentry-triage.yml', () => {
  const idx = workflowScriptIndex(loadWorkflows(new URL('../..', import.meta.url).pathname));
  assert.ok(idx.get('scripts/triage-sentry.js')?.includes('sentry-triage.yml'));
});
