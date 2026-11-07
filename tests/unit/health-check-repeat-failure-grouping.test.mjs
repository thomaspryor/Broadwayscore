import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  enrichRepeatFailureSteps, failedSteps, summarizeRepeatFailures, repeatFailureLabel,
  MAX_JOB_REQUESTS, JOB_CACHE_TTL_MS,
} = require('../../scripts/lib/workflow-repeat-failures.js');

function run(id, name = 'Deploy to Vercel', extras = {}) {
  return { id, name, status: 'completed', conclusion: 'failure',
    created_at: new Date(Date.UTC(2026, 9, 29, 0, id)).toISOString(),
    html_url: `https://github.com/example/repo/actions/runs/${id}`, ...extras };
}
function job(name, step) {
  return { name, conclusion: 'failure', steps: step ? [{ name: step, conclusion: 'failure' }] : [] };
}
function options(fetchJSON, extras = {}) {
  return { fetchJSON, cache: async (_key, fn) => fn(), lowHeadroom: () => false, ...extras };
}
function response(...jobs) { return { total_count: jobs.length, jobs }; }

test('BRO-3178: unrelated failed steps never manufacture a repeat alert', async () => {
  const runs = [run(1), run(2)];
  const detailed = await enrichRepeatFailureSteps(runs, options(async url =>
    response(job('deploy', url.includes('/runs/1/') ? 'Setup Playwright' : 'Deploy to Production'))));
  assert.deepEqual(summarizeRepeatFailures(detailed), []);
  assert.equal(runs[0].failureSteps, undefined, 'do not mutate cached workflow runs');
});

test('same workflow/job/step repeats, with distinct job names and workflow names kept separate', () => {
  const runs = [
    run(1, 'Deploy', { failureSteps: [{ job: 'deploy', step: 'Install' }] }),
    run(2, 'Deploy', { failureSteps: [{ job: 'deploy', step: 'Install' }] }),
    run(3, 'Deploy', { failureSteps: [{ job: 'smoke', step: 'Install' }] }),
    run(4, 'Other', { failureSteps: [{ job: 'deploy', step: 'Install' }] }),
  ];
  const groups = summarizeRepeatFailures(runs);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].latestUrl, runs[1].html_url);
  assert.equal(repeatFailureLabel(groups[0]), 'Deploy / deploy / Install');
});

test('all failing steps count once per run; successful jobs and steps are ignored', () => {
  const jobs = [job('deploy', 'Upload'), job('smoke', 'Browser'), job('deploy', 'Upload'),
    { name: 'advisory', conclusion: 'success', steps: [{ name: 'Optional', conclusion: 'failure' }] }];
  jobs[0].steps.push({ name: 'Setup', conclusion: 'success' });
  const groups = summarizeRepeatFailures([run(1), run(2)].map(r => ({ ...r, failureSteps: failedSteps(jobs) })));
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(r => r.count), [2, 2]);
});

test('only repeat candidates need jobs; gate refusals and single failures spend no quota', async () => {
  let calls = 0;
  const runs = [run(1, 'Land'), run(2, 'Land'), run(3, 'Land', { conclusion: 'success' }), run(4, 'Single')];
  assert.deepEqual(await enrichRepeatFailureSteps(runs, options(async () => { calls++; })), runs);
  assert.equal(calls, 0);
});

test('request cap bounds extra cost; exhaustion remains explicit and separate from known steps', async () => {
  let calls = 0;
  const runs = Array.from({ length: MAX_JOB_REQUESTS + 3 }, (_, i) => run(i + 1));
  const detailed = await enrichRepeatFailureSteps(runs, options(async () => {
    calls++;
    return response(job('deploy', 'Upload'));
  }));
  assert.equal(calls, MAX_JOB_REQUESTS);
  const groups = summarizeRepeatFailures(detailed);
  assert.deepEqual(groups.map(r => r.count), [MAX_JOB_REQUESTS, 3]);
  assert.equal(groups[1].detailsUnavailable, true);
  assert.equal(groups[0].latestUrl, runs.at(-1).html_url);
});

test('low headroom spends no quota; unknown failures still surface', async () => {
  let calls = 0;
  const detailed = await enrichRepeatFailureSteps([run(1), run(2)], options(async () => { calls++; }, {
    lowHeadroom: threshold => { assert.equal(threshold, 200 + MAX_JOB_REQUESTS); return true; },
  }));
  assert.equal(calls, 0);
  assert.equal(summarizeRepeatFailures(detailed)[0].detailsUnavailable, true);
});

test('missing jobs, missing failed steps, and fetch errors never merge with a known failure', async () => {
  const scenarios = [async () => { throw new Error('HTTP 403'); }, async () => ({}), async () => response()];
  for (const fetchJSON of scenarios) {
    const detailed = await enrichRepeatFailureSteps([run(1), run(2)], options(fetchJSON));
    assert.equal(summarizeRepeatFailures(detailed)[0].detailsUnavailable, true);
    assert.deepEqual(summarizeRepeatFailures([detailed[0], {
      ...run(3), failureSteps: [{ job: 'deploy', step: 'Upload' }],
    }]), []);
  }
  const detailed = await enrichRepeatFailureSteps([run(1), run(2)], options(async () => response(job('deploy'))));
  const group = summarizeRepeatFailures(detailed)[0];
  assert.equal(group.detailsUnavailable, true);
  assert.equal(repeatFailureLabel(group), 'Deploy to Vercel / deploy / failed step unavailable');
});

test('jobs are paginated so failures past the first 100 jobs are included', async () => {
  const urls = [];
  const detailed = await enrichRepeatFailureSteps([run(1), run(2)], options(async url => {
    urls.push(url);
    return { total_count: 101, jobs: url.endsWith('page=1')
      ? Array.from({ length: 100 }, () => ({ name: 'green', conclusion: 'success' }))
      : [job('last job', 'Real failure')] };
  }));
  assert.equal(urls.length, 4);
  assert.equal(summarizeRepeatFailures(detailed)[0].step, 'Real failure');
});

test('an incomplete paginated response does not pretend that partial details are complete', async () => {
  const detailed = await enrichRepeatFailureSteps([run(1), run(2)], options(async url => {
    if (url.endsWith('page=2')) throw new Error('HTTP 500');
    return { total_count: 101, jobs: [job('deploy', 'Upload')] };
  }));
  assert.equal(summarizeRepeatFailures(detailed)[0].detailsUnavailable, true);
});

test('pagination also obeys the global jobs request cap', async () => {
  let calls = 0;
  const detailed = await enrichRepeatFailureSteps([run(1), run(2)], options(async () => {
    calls++;
    return { total_count: 10000, jobs: [job('deploy', 'Upload')] };
  }));
  assert.equal(calls, MAX_JOB_REQUESTS);
  assert.equal(summarizeRepeatFailures(detailed)[0].detailsUnavailable, true);
});

test('immutable attempt cache is reused; reruns use their own attempt endpoint and key', async () => {
  const stored = new Map();
  const urls = [];
  const opts = options(async url => { urls.push(url); return response(job('deploy', 'Upload')); }, {
    cache: async (key, fn, { ttlMs }) => {
      assert.equal(ttlMs, JOB_CACHE_TTL_MS);
      if (!stored.has(key)) stored.set(key, await fn());
      return stored.get(key);
    },
  });
  await enrichRepeatFailureSteps([run(1), run(2)], opts);
  opts.lowHeadroom = () => true;
  const cached = await enrichRepeatFailureSteps([run(1), run(2)], opts);
  assert.equal(urls.length, 2);
  assert.equal(summarizeRepeatFailures(cached)[0].step, 'Upload');
  opts.lowHeadroom = () => false;
  await enrichRepeatFailureSteps([run(1, undefined, { run_attempt: 2 }), run(2)], opts);
  assert.equal(urls.length, 3);
  assert.match(urls[2], /\/1\/attempts\/2\/jobs\?/);
});

test('step groups preserve conservative self-heal and gate-workflow handling', () => {
  const failures = [run(1), run(2)].map(r => ({ ...r, failureSteps: [{ job: 'deploy', step: 'Upload' }] }));
  const greens = [run(3, undefined, { conclusion: 'success' }), run(4, undefined, { conclusion: 'success' })];
  assert.equal(summarizeRepeatFailures([...failures, ...greens])[0].selfHealed, true);
  assert.equal(summarizeRepeatFailures([...failures, greens[0]])[0].selfHealed, false);
  assert.deepEqual(summarizeRepeatFailures([...failures, ...greens].map(r => ({ ...r, name: 'Land' }))), []);
});
