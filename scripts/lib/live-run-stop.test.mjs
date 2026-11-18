// BRO-7738: pins live-run-stop.mjs. The incident shape (edit the Sentry triage script, land, close on unit tests)
// must block; a dispatch of its workflow plus a read of the run, or a direct run of the script, must allow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowScriptIndex, stopHookDecision, blockBudget, loadWorkflows, defersProof } from './live-run-stop.mjs';

const ENV = { CLAUDE_CODE_REMOTE: 'true' };
const SAFE = 'Done.\n\nSAFE TO ARCHIVE — all landed';
const W = '/home/user/Broadwayscore/.claude/worktrees/x/';
let n = 0;
const use = (name, input, result = 'ok', isError = false) => { const id = `t${++n}`; return [{ kind: 'assistant_tool_use', name, input, id }, { kind: 'tool_result', tool_use_id: id, content: result, isError }]; };
const edit = (f) => use('Edit', { file_path: W + f, old_string: 'a', new_string: 'b' });
const bash = (command, out = 'ok', err = false) => use('Bash', { command }, out, err);
const land = () => bash('git push origin HEAD:refs/heads/land/x');
const landed = () => [...land(), ...bash('node scripts/lib/wait-for-land.js land/x')];
const unitTests = () => bash('node --test scripts/fixture-job.test.mjs');
const index = workflowScriptIndex({
  'sentry-triage.yml': 'jobs:\n  t:\n    steps:\n      - run: node scripts/fixture-job.js\n',
  'test.yml': '      - run: node scripts/only-in-tests.js\n',
  'other.yml': '      # node scripts/commented-out.js\n      - run: echo hi # scripts/trailing-comment.js\n',
});
const decide = (events, lastMessage = SAFE) => stopHookDecision({ lastMessage, events, env: ENV, index });

test('workflowScriptIndex: direct refs only; test.yml, land.yml and comments do not count', () => {
  assert.deepEqual(index.get('scripts/fixture-job.js'), ['sentry-triage.yml']);
  assert.equal(index.has('scripts/only-in-tests.js'), false);
  assert.equal(index.has('scripts/commented-out.js'), false);
  assert.equal(index.has('scripts/trailing-comment.js'), false);
});

test('the incident: edit triage script, unit tests, land, SAFE TO ARCHIVE -> block naming the file and workflow', () => {
  const d = decide([...edit('scripts/fixture-job.js'), ...unitTests(), ...land()]);
  assert.equal(d.decision, 'block');
  assert.match(d.message, /scripts\/fixture-job\.js \(run by sentry-triage\.yml\)/);
});

test('dispatching the matching workflow after landing and reading the run -> allow', () => {
  const trig = use('mcp__github__actions_run_trigger', { method: 'run_workflow', workflow_id: 'sentry-triage.yml', ref: 'main' });
  const read = use('mcp__github__actions_get', { method: 'get_workflow_run', resource_id: '1' });
  assert.equal(decide([...edit('scripts/fixture-job.js'), ...landed(), ...trig, ...read]).decision, 'allow');
  assert.equal(decide([...edit('scripts/fixture-job.js'), ...landed(), ...bash('node scripts/cloud-dispatch.js sentry-triage.yml && node scripts/lib/wait-for-run.sh 1')]).decision, 'allow', 'chained dispatch + wait');
  assert.equal(decide([...edit('scripts/fixture-job.js'), ...landed(), ...bash('node scripts/cloud-dispatch.js sentry-triage.yml --wait')]).decision, 'allow', 'the remedy the block message names');
});

test('a dispatch alone, a dispatch of the wrong workflow, or a dispatch before landing does not count', () => {
  const trig = (wf) => use('mcp__github__actions_run_trigger', { workflow_id: wf });
  const read = () => use('mcp__github__actions_get', { resource_id: '1' });
  assert.equal(decide([...edit('scripts/fixture-job.js'), ...land(), ...trig('sentry-triage.yml')]).decision, 'block', 'never read the result');
  assert.equal(decide([...edit('scripts/fixture-job.js'), ...land(), ...trig('vercel-deploy.yml'), ...read()]).decision, 'block', 'wrong workflow');
  assert.equal(decide([...edit('scripts/fixture-job.js'), ...trig('sentry-triage.yml'), ...read(), ...land()]).decision, 'block', 'ran the old code');
  assert.equal(decide([...edit('scripts/fixture-job.js'), ...landed(), ...use('mcp__github__actions_run_trigger', { workflow_id: 'sentry-triage.yml' }, 'error', true), ...read()]).decision, 'block', 'failed dispatch');
  assert.equal(decide([...edit('scripts/fixture-job.js'), ...land(), ...trig('sentry-triage.yml'), ...read()]).decision, 'block', 'dispatched before the land merged: old code');
  assert.equal(decide([...edit('scripts/fixture-job.js'), ...landed(), ...trig('sentry-triage.yml'), ...use('mcp__github__actions_list', { method: 'list_workflows' })]).decision, 'block', 'listing workflows is not reading the run');
  assert.equal(decide([...edit('scripts/fixture-job.js'), ...landed(), ...bash('grep -n cloud-dispatch.js .github/workflows/sentry-triage.yml'), ...read()]).decision, 'block', 'a grep is not a dispatch');
});

test('running the edited script itself after the last edit counts; --help, node --check, a failed run or a run before the edit do not', () => {
  const E = () => edit('scripts/fixture-job.js');
  assert.equal(decide([...E(), ...bash('node scripts/fixture-job.js --dry-run'), ...land()]).decision, 'allow', 'dry run on real data');
  assert.equal(decide([...E(), ...bash(`cd ${W} && node ${W}scripts/fixture-job.js | tail -5`), ...land()]).decision, 'allow', 'absolute path');
  assert.equal(decide([...E(), ...bash('node scripts/fixture-job.js --help'), ...land()]).decision, 'block', '--help');
  assert.equal(decide([...E(), ...bash('node --check scripts/fixture-job.js'), ...land()]).decision, 'block', 'syntax check');
  assert.equal(decide([...E(), ...bash('node scripts/fixture-job.js', 'boom', true), ...land()]).decision, 'block', 'errored');
  assert.equal(decide([...bash('node scripts/fixture-job.js'), ...E(), ...land()]).decision, 'block', 'ran before the edit');
  assert.equal(decide([...E(), ...bash("cat <<'X'\nnode scripts/fixture-job.js\nX"), ...land()]).decision, 'block', 'heredoc text is not a run');
  assert.equal(decide([...E(), ...bash('echo node scripts/fixture-job.js'), ...land()]).decision, 'block', 'echo is not a run');
  assert.equal(decide([...E(), ...bash('node scripts/fixture-job.js | tail -3', 'TypeError: x is not a function'), ...land()]).decision, 'block', 'piped failure');
  assert.equal(decide([...E(), ...bash('node --check a.js && node scripts/fixture-job.js --dry-run'), ...land()]).decision, 'allow', 'a check of another file does not void the run');
});

test('out of scope: no land, a non-live file, test.yml, only KEEP OPEN, bypass, not cloud', () => {
  assert.equal(decide([...edit('scripts/fixture-job.js'), ...unitTests()]).decision, 'allow', 'nothing landed');
  assert.equal(decide([...edit('scripts/lib/some-helper.js'), ...land()]).decision, 'allow', 'not run by a workflow directly');
  assert.equal(decide([...edit('.github/workflows/test.yml'), ...land()]).decision, 'allow', 'test.yml runs on the land itself');
  assert.equal(decide([...edit('scripts/fixture-job.js'), ...land()], 'KEEP OPEN — waiting on the run').decision, 'allow');
  assert.equal(decide([...edit('scripts/fixture-job.js'), ...land()], 'NO-LIVE-RUN: sends real email to readers\nSAFE TO ARCHIVE — x').decision, 'allow');
  assert.equal(decide([...edit('scripts/fixture-job.js'), ...land()], 'NO-LIVE-RUN: short\nSAFE TO ARCHIVE — x').decision, 'block', 'reason too short');
  assert.equal(stopHookDecision({ lastMessage: SAFE, events: [...edit('scripts/fixture-job.js'), ...land()], env: {}, index }).decision, 'allow');
});

test('an edited workflow file needs a dispatch of itself; an edit after the last land is not judged', () => {
  assert.equal(decide([...edit('.github/workflows/sentry-triage.yml'), ...land()]).decision, 'block');
  assert.equal(decide([...edit('.github/workflows/sentry-triage.yml'), ...landed(), ...use('mcp__github__actions_run_trigger', { workflow_id: 'sentry-triage.yml' }), ...use('mcp__github__get_job_logs', { run_id: 1 })]).decision, 'allow');
  assert.equal(decide([...land(), ...edit('scripts/fixture-job.js')]).decision, 'allow');
});

test('the chunk starts after the previous SAFE TO ARCHIVE claim', () => {
  const prev = { kind: 'assistant_text', text: 'SAFE TO ARCHIVE — earlier work' };
  assert.equal(decide([...edit('scripts/fixture-job.js'), ...land(), prev, ...bash('echo later')]).decision, 'allow');
});

test('rollout: one nudge before the blocking date, two after', () => {
  assert.equal(blockBudget(new Date('2026-11-20T00:00:00Z')), 1);
  assert.equal(blockBudget(new Date('2026-11-25T00:00:00Z')), 2);
});

test('the real repo: triage-sentry.js is indexed under sentry-triage.yml', () => {
  const idx = workflowScriptIndex(loadWorkflows(new URL('../..', import.meta.url).pathname));
  const real = ['scripts', 'triage-sentry.js'].join('/'); // built, so the land preflight does not read it as a test of that script
  assert.ok(idx.get(real)?.includes('sentry-triage.yml'));
});

// Owner 2026-11-18: sessions say "we'll know tomorrow if it works" instead of forcing a dry run now.
const DEFERS = [
  "We'll know tomorrow if it works.",
  'We will know in 2 days whether the digest fires.',
  "I'll confirm after the next scheduled run.",
  "You'll see it in tomorrow's email.",
  'It should show up once the nightly cron runs.',
  "We'll find out tonight when the job fires.",
  'Once the next run fires, the new card format will appear.',
  "When tomorrow's run happens we'll see the counts.",
  "I'll know in a few hours if the fix held.",
  'RECHECK-AFTER: 2026-11-20',
  "We'll know on Friday whether it fired.",
  "I'll find out in the morning.",
  'Proof comes with tomorrow\'s 6am run.',
  "Once the cron runs tonight we'll know.",
  'This will be verified by tonight\'s scheduled job.',
  'We will be able to tell tomorrow.',
];
const NOT_DEFERS = [
  'It ran just now and printed 12 rows.',
  'We know it works: the dispatched run succeeded.',
  'The cron runs every 30 minutes; I dispatched it and read the log.',
  'Tomorrow is opening night for the show.',
  'KEEP OPEN — waiting on the land run',
  'I will check the docs next week for the API change.',
  "This should tell the poller to skip tomorrow's shows.",
  'The script will confirm the venue and then skip shows opening tomorrow.',
  "I'll see you tomorrow.",
  'A session that says "we\'ll know tomorrow if it works" is now stopped.',
  'When the next cron runs it will pick up the new file (dispatched and verified above).',
  'The card carries a RECHECK-AFTER stamp from an older session.',
  'Example deferral, quoted:\n```\nWe will know tomorrow.\n```',
];
test('WAIT_TO_SEE_RE: catches "we will know later" phrasings and not plain mentions of time', () => {
  for (const t of DEFERS) assert.ok(defersProof(t), `should catch: ${t}`);
  for (const t of NOT_DEFERS) assert.ok(!defersProof(t), `should not catch: ${t}`);
});

test('deferring proof to a later run is judged even without SAFE TO ARCHIVE', () => {
  const ev = [...edit('scripts/fixture-job.js'), ...landed()];
  assert.equal(decide(ev, "Landed. We'll know tomorrow if it works.\n\nKEEP OPEN — waiting on tomorrow's run").decision, 'block');
  assert.match(decide(ev, "We'll know tomorrow.\nKEEP OPEN — x").message, /dry-run now/);
  const ran = [...ev, ...bash('node scripts/fixture-job.js --dry-run')];
  assert.equal(decide([...edit('scripts/fixture-job.js'), ...bash('node scripts/fixture-job.js --dry-run'), ...landed()], "We'll also see it in tomorrow's run.\nKEEP OPEN — x").decision, 'allow', 'ran it now: a later mention is fine');
  assert.ok(ran.length);
  assert.equal(decide([...edit('scripts/lib/some-helper.js'), ...landed()], "We'll know tomorrow.\nKEEP OPEN — x").decision, 'allow', 'nothing a workflow runs was landed');
});

test('a bypass that only says "it runs on a schedule" is refused; a real reason is accepted', () => {
  const ev = [...edit('scripts/fixture-job.js'), ...landed()];
  for (const why of ['cron-only job, runs at 6am', 'scheduled workflow, will run tomorrow', 'only runs nightly on the schedule', 'next run will exercise it']) {
    assert.equal(decide(ev, `NO-LIVE-RUN: ${why}\nSAFE TO ARCHIVE — x`).decision, 'block', why);
  }
  assert.equal(decide(ev, 'NO-LIVE-RUN: sends real email to 4,000 readers, no dry-run mode\nSAFE TO ARCHIVE — x').decision, 'allow');
  for (const why of ['sends the nightly digest email to 4,000 real subscribers', 'spends ~$40 of paid API calls; runs on all 800 reviews', 'scheduled broadcast to the real audience']) {
    assert.equal(decide(ev, `NO-LIVE-RUN: ${why}\nSAFE TO ARCHIVE — x`).decision, 'allow', `money/email reason with a schedule word: ${why}`);
  }
  assert.equal(decide(ev, 'NO-LIVE-RUN: cron-only job, runs at 6am daily\nNO-LIVE-RUN: sends real email to 4,000 readers\nSAFE TO ARCHIVE — x').decision, 'allow', 'a refused bypass does not hide a valid one in the same message');
  const early = { kind: 'assistant_text', text: 'NO-LIVE-RUN: cron-only job, runs at 6am daily' };
  assert.equal(decide([...ev, early], 'NO-LIVE-RUN: sends real email to 4,000 readers\nSAFE TO ARCHIVE — x').decision, 'allow', 'nor one in an earlier message');
});

test('a shell edit of a live script counts as an edit (sed -i, redirect); a read does not', () => {
  assert.equal(decide([...bash("sed -i 's/a/b/' scripts/fixture-job.js"), ...landed()]).decision, 'block', 'sed -i');
  assert.equal(decide([...bash('cat > scripts/fixture-job.js <<EOF\nx\nEOF'), ...landed()]).decision, 'block', 'redirect');
  assert.equal(decide([...bash("sed -n 1,5p scripts/fixture-job.js"), ...landed()]).decision, 'allow', 'sed -n only reads');
  assert.equal(decide([...bash("sed -i 's/a/b/' scripts/fixture-job.js"), ...bash('node scripts/fixture-job.js --dry-run'), ...landed()]).decision, 'allow', 'then ran it');
});
