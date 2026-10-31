// TESTS-VS-DERIVED-DATA-EXEMPT: real Actions history fixture plus synthetic run outcomes; no core data.
// Execute the shipped github-script body, including its real helper, without sending alerts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../package.json', import.meta.url));
const action = fs.readFileSync(new URL('../../.github/actions/notify-failure/action.yml', import.meta.url), 'utf8');
const section = action.split('    - name: Check cooldown\n')[1]?.split('\n    # BRO-5477')[0];
assert.ok(section, 'the real cooldown/streak step must exist');
const script = section.split('        script: |\n')[1].replace(/^          /gm, '');
const execute = new (Object.getPrototypeOf(async function () {}).constructor)('github', 'context', 'core', 'require', 'process', 'console', script);
const fixture = require('./scripts/lib/fixtures/auto-fix-first/poller-runs-2026-10-17T0756Z.json');
const { NOTIFY_STEP_NAME } = require('./scripts/lib/auto-fix-first.js');

const run = (id, conclusion, updated = id) => ({
  id, status: 'completed', conclusion,
  created_at: new Date(updated * 1000).toISOString(),
  updated_at: new Date(updated * 1000).toISOString(),
});
const jobs = (conclusion) => [{ steps: [{ name: NOTIFY_STEP_NAME, conclusion }] }];

async function check(runs, { jobsById = {}, threshold = '2', apiError, jobsError, loader = require } = {}) {
  const outputs = {};
  const requests = [];
  const jobRequests = [];
  const logs = [];
  const listJobsForWorkflowRun = () => { throw new Error('jobs must be paginated'); };
  const github = {
    rest: { actions: {
      listWorkflowRuns: async (params) => {
        requests.push(params);
        if (apiError) throw new Error(apiError);
        return { data: { workflow_runs: runs } };
      },
      listJobsForWorkflowRun,
    } },
    paginate: async (method, params) => {
      assert.equal(method, listJobsForWorkflowRun);
      jobRequests.push(params);
      if (jobsError) throw new Error(jobsError);
      return jobsById[params.run_id] || [];
    },
  };
  await execute(github, { workflow: 'Opening Night Poller', runId: 999, repo: { owner: 'test-owner', repo: 'test-repo' } },
    { setOutput: (name, value) => { outputs[name] = value; } }, loader,
    { env: { INPUT_MIN_CONSECUTIVE_FAILURES: threshold, GITHUB_WORKFLOW_REF: 'test-owner/test-repo/.github/workflows/opening-night-poller.yml@refs/heads/main' } },
    { log: (message) => logs.push(message) });
  return { outputs, requests, jobRequests, logs };
}

test('a genuine cancelled run advances the next failure to the paging threshold', async () => {
  const result = await check([run(1, 'cancelled')], { jobsById: { 1: jobs('success') } });
  assert.equal(result.outputs.suppressed, 'false');
  assert.match(result.logs[0], /2 consecutive failure/);
  assert.deepEqual(result.jobRequests, [{ owner: 'test-owner', repo: 'test-repo', run_id: 1, per_page: 100 }]);
  assert.equal(result.requests[0].workflow_id, 'opening-night-poller.yml');
  assert.equal(result.requests[0].status, 'completed');
});

test('a Notify step cut off by cancellation also advances the streak', async () => {
  assert.equal((await check([run(1, 'cancelled')], { jobsById: { 1: jobs('cancelled') } })).outputs.suppressed, 'false');
});

test('Express takeovers and queued cancellations neither advance nor reset a streak', async () => {
  for (const history of [[], jobs('skipped')]) {
    assert.equal((await check([run(2, 'cancelled')], { jobsById: { 2: history } })).outputs.suppressed, 'true');
    assert.equal((await check([run(2, 'cancelled'), run(1, 'failure')], { jobsById: { 2: history } })).outputs.suppressed, 'false');
  }
});

test('real 2026-10-17 Express takeovers remain suppressed', async () => {
  const cancelled = fixture.runs.filter((r) => r.conclusion === 'cancelled');
  assert.equal(cancelled.length, 5, 'exercise all five real cancellations');
  const result = await check(cancelled, { jobsById: fixture.jobs });
  assert.equal(result.outputs.suppressed, 'true');
  assert.equal(result.jobRequests.length, 5);
});

test('real cancelled poller run 37048302061, whose Notify ran, extends the streak', async () => {
  // Projection of GET /actions/runs/37048302061 and /jobs on 2026-10-18.
  const cancelled = {
    id: 37048302061, status: 'completed', conclusion: 'cancelled',
    created_at: '2026-10-02T18:34:00Z', updated_at: '2026-10-02T21:52:03Z',
  };
  const jobsById = { 37048302061: [{
    id: 111010594302, conclusion: 'cancelled',
    steps: [{ name: 'Notify on failure', conclusion: 'success' }],
  }] };
  const result = await check([cancelled], { jobsById });
  assert.equal(result.outputs.suppressed, 'false');
  assert.match(result.logs[0], /2 consecutive failure/);
});

test('completion order, current-run exclusion, skipped runs and success resets are preserved', async () => {
  const result = await check([run(1, 'failure', 4), run(2, 'success', 3), run(999, 'failure', 6), run(3, 'skipped', 5)]);
  assert.equal(result.outputs.suppressed, 'false');
  assert.match(result.logs[0], /2 consecutive failure/);
  assert.equal(result.jobRequests.length, 0);
  const reset = await check([run(2, 'success', 5), run(1, 'failure', 4), run(3, 'cancelled', 3)]);
  assert.equal(reset.outputs.suppressed, 'true');
  assert.equal(reset.jobRequests.length, 0, 'do not fetch jobs beyond a success');
});

test('threshold grace and reminders every fourth failure apply to mixed failure/cancelled streaks', async () => {
  for (const threshold of [2, 3]) {
    for (let streak = 1; streak <= 10; streak++) {
      const history = Array.from({ length: streak - 1 }, (_, i) => run(i + 1, i % 2 ? 'failure' : 'cancelled'));
      const jobsById = Object.fromEntries(history.map((r) => [r.id, jobs('success')]));
      const result = await check(history, { threshold: String(threshold), jobsById });
      assert.equal(result.outputs.suppressed, [threshold, threshold + 4, threshold + 8].includes(streak) ? 'false' : 'true', `threshold ${threshold}, streak ${streak}`);
    }
  }
});

test('run-history, jobs and helper-load errors fail open', async () => {
  const cases = [
    { apiError: 'HTTP 503' },
    { jobsError: 'HTTP 403' },
    { loader: () => { throw new Error('missing helper'); } },
  ];
  for (const options of cases) {
    const result = await check([run(1, 'cancelled')], options);
    assert.equal(result.outputs.suppressed, 'false');
    assert.match(result.logs.at(-1), /sending alert anyway/);
  }
});

test('default cooldown mode never fetches cancellation jobs', async () => {
  const result = await check([], { threshold: '1' });
  assert.equal(result.outputs.suppressed, 'false');
  assert.equal(result.requests[0].status, 'failure');
  assert.equal(result.jobRequests.length, 0);
  const recent = await check([{ id: 1, updated_at: new Date().toISOString() }], { threshold: '1' });
  assert.equal(recent.outputs.suppressed, 'true', 'a recent failure still suppresses a duplicate');
  assert.equal(recent.jobRequests.length, 0);
});
