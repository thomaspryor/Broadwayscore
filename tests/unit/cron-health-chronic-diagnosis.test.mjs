import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const diagnosis = require('../../scripts/lib/cron-health-chronic-diagnosis.js');
const { collectDiagnosis, resolveWorkflowFile, formatDiagnosis, chronicDiagnosisSection } = diagnosis;

const timeoutJob = {
  name: 'worker', conclusion: 'cancelled',
  started_at: '2026-10-01T00:00:00Z', completed_at: '2026-10-01T00:30:00Z',
};
const pushJob = { name: 'worker', conclusion: 'failure', steps: [{ name: 'Commit and push', conclusion: 'failure' }] };

function collect(jobs, extra = {}) {
  const calls = [];
  const result = collectDiagnosis({
    workflowFile: 'example.yml', repo: 'owner/repo', readTimeouts: () => ({ worker: 30 }),
    readJson: apiPath => {
      calls.push(apiPath);
      return apiPath.includes('/workflows/')
        ? { workflow_runs: [{ id: 123, conclusion: 'failure', created_at: '2026-10-01T00:00:00Z' }] }
        : { jobs };
    }, ...extra,
  });
  return { result, calls };
}

test('resolves exact monitor aliases, including parentheses and seasonal entries', () => {
  assert.equal(resolveWorkflowFile('Commercial Weekly Orchestrator'), 'commercial-weekly.yml');
  assert.equal(resolveWorkflowFile('Daily Data Health Check (digest snapshot carrier)'), 'data-health-check.yml');
  assert.equal(resolveWorkflowFile('Refresh Show Score (opening-night)'), 'refresh-show-score-opening-night.yml');
  const yaml = 'CRITICAL_CRONS=(\n "season.yml|100|Seasonal Name|4-6"\n)';
  assert.equal(resolveWorkflowFile('Seasonal Name', yaml), 'season.yml');
  assert.equal(resolveWorkflowFile('Unknown Name'), null);
  assert.equal(resolveWorkflowFile('Duplicate', 'CRITICAL_CRONS=(\n "a.yml|1|Duplicate"\n "b.yml|1|Duplicate"\n)'), null);
});

for (const [shape, jobs] of [
  ['timeout-cancelled', [timeoutJob, timeoutJob, pushJob]],
  ['push-contention', [pushJob, pushJob, timeoutJob]],
  ['other', [{ name: 'worker', conclusion: 'failure', steps: [{ name: 'Validate', conclusion: 'failure' }] }]],
]) {
  test(`real classifier produces a bounded ${shape} diagnosis with linked evidence`, () => {
    const { result, calls } = collect(jobs);
    const section = formatDiagnosis(result);
    assert.match(section, new RegExp(`Dominant failure shape: \\*\\*${shape}\\*\\*`));
    assert.match(section, /https:\/\/github.com\/owner\/repo\/actions\/runs\/123/);
    assert.ok(section.length <= 2400);
    assert.equal(calls.length, 2);
  });
}

test('only reads jobs for unsuccessful completed runs, with a hard run limit', () => {
  const calls = [];
  const { result } = collect([pushJob], {
    limit: 3,
    readJson: apiPath => {
      calls.push(apiPath);
      return apiPath.includes('/workflows/') ? { workflow_runs: [
        { id: 1, conclusion: 'success' }, { id: 2, conclusion: null },
        { id: 3, conclusion: 'cancelled' }, { id: 4, conclusion: 'failure' },
      ] } : { jobs: [timeoutJob] };
    },
  });
  assert.equal(result.runs.length, 3);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /\/runs\/3\/jobs\?per_page=100$/);
});

test('empty or healthy history reports other without inventing a failure', () => {
  for (const workflow_runs of [[], [{ id: 1, conclusion: 'success' }]]) {
    const { result } = collect([], { readJson: () => ({ workflow_runs }) });
    assert.match(formatDiagnosis(result), /\*\*other\*\*.*No failing\/cancelled jobs found/);
  }
});

test('aggregates other failures and bounds default API cost to 16 requests', () => {
  const paths = [];
  const { result } = collect([], { readJson: apiPath => {
    paths.push(apiPath);
    return apiPath.includes('/workflows/')
      ? { workflow_runs: Array.from({ length: 15 }, (_, i) => ({ id: i, conclusion: 'failure' })) }
      : { jobs: [timeoutJob] };
  } });
  assert.equal(result.runs.length, 15);
  assert.equal(paths.length, 16);
  assert.match(paths[0], /per_page=15$/);
  const { result: mixed } = collect([
    timeoutJob, timeoutJob,
    { name: 'a', conclusion: 'failure' }, { name: 'b', conclusion: 'failure' },
    { ...timeoutJob, completed_at: '2026-10-01T00:01:00Z' },
  ]);
  assert.match(formatDiagnosis(mixed), /Dominant failure shape: \*\*other\*\* \(3 jobs\)/);
});

test('unavailable mapping, API and timeout errors still produce a safe Diagnosis section', () => {
  assert.equal(chronicDiagnosisSection('cron-health:Example', { collect: () => assert.fail() }), null);
  for (const options of [
    { resolve: () => null },
    { collect: () => { throw new Error('rate limited with private details'); } },
    { collect: () => { throw new Error('Diagnosis time budget exhausted'); } },
  ]) {
    const section = chronicDiagnosisSection('cron-health-chronic:Commercial Weekly Orchestrator', options);
    assert.match(section, /## Diagnosis\nDominant failure shape: \*\*other\*\* \(diagnosis unavailable\)/);
    assert.doesNotMatch(section, /private details/);
  }
});

test('rejects invalid limits and malformed API responses', () => {
  for (const limit of [-1, 0, 101, NaN, 1.5]) assert.throws(() => collect([], { limit }), /limit/);
  assert.throws(() => collect([], { readJson: () => ({}) }), /Invalid workflow run response/);
  assert.throws(() => collect([], { workflowFile: '../x.yml' }), /Invalid workflow filename/);
});

test('caps verbose evidence and keeps dominant evidence first', () => {
  const { result } = collect([pushJob, timeoutJob, timeoutJob, timeoutJob]);
  result.details.forEach(d => { d.name = 'x'.repeat(10000); });
  const section = formatDiagnosis(result);
  assert.ok(section.length <= 2400);
  assert.match(section.split('\n').find(line => line.startsWith('- ')), /timeout-cancelled/);
});

test('existing workflow route files enriched notes, skips diagnostics on cooldown/dedupe and other families', async () => {
  const tmp = fs.mkdtempSync(path.join(process.cwd(), '.bro-3196-test-'));
  const envKeys = ['ALERT_LEDGER_PATH', 'ALERT_DIGEST_QUEUE_PATH', 'ALERT_ATTEMPTS_LOG_PATH'];
  const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  envKeys.forEach((key, i) => { process.env[key] = path.join(tmp, `${i}.json`); });
  const routerPath = require.resolve('../../scripts/lib/owner-alert-router.js');
  const oldRouter = require.cache[routerPath];
  const linear = require('../../scripts/lib/linear-client.js');
  const create = require('../../scripts/lib/linear-issue-create.js');
  const notes = [];
  let diagnosticCalls = 0;
  let duplicate = null;
  mock.method(linear, 'searchIssues', async () => duplicate);
  mock.method(linear, 'getIssue', async () => ({ state: { type: 'started' } }));
  mock.method(create, 'createLinearIssue', async opts => {
    notes.push(opts.description);
    return { issue: { identifier: 'BRO-TEST' } };
  });
  mock.method(diagnosis, 'chronicDiagnosisSection', key => chronicDiagnosisSection(key, {
    collect: options => {
      diagnosticCalls++;
      return collect([timeoutJob], { ...options, readTimeouts: () => ({ worker: 30 }) }).result;
    },
  }));
  delete require.cache[routerPath];
  try {
    const { routeAlert } = require(routerPath);
    const alert = {
      conditionKey: 'cron-health-chronic:Commercial Weekly Orchestrator',
      title: 'Chronic cron', description: 'Stale after self-heal', disposition: 'auto', severity: 'error',
    };
    assert.equal((await routeAlert(alert)).action, 'auto');
    assert.match(notes[0], /## Diagnosis\nWorkflow: commercial-weekly.yml/);
    assert.match(notes[0], /Dominant failure shape: \*\*timeout-cancelled\*\*/);
    assert.equal((await routeAlert(alert)).action, 'silent');
    assert.equal(diagnosticCalls, 1);
    duplicate = { identifier: 'BRO-EXISTING' };
    await routeAlert({ ...alert, conditionKey: 'cron-health-chronic:Commercial Friday Refresh' });
    assert.equal(diagnosticCalls, 1);
    duplicate = null;
    await routeAlert({ ...alert, conditionKey: 'cron-health:Commercial Weekly Orchestrator' });
    assert.equal(diagnosticCalls, 1);
    assert.doesNotMatch(notes[1], /## Diagnosis/);
    // Failed diagnosis still reaches the real filing path.
    mock.method(diagnosis, 'chronicDiagnosisSection', key => chronicDiagnosisSection(key, { collect: () => { throw new Error('API down'); } }));
    await routeAlert({ ...alert, conditionKey: 'cron-health-chronic:Weekly Video Reviews' });
    assert.match(notes[2], /diagnosis unavailable/);
  } finally {
    mock.restoreAll();
    delete require.cache[routerPath];
    if (oldRouter) require.cache[routerPath] = oldRouter;
    for (const key of envKeys) {
      if (oldEnv[key] === undefined) delete process.env[key];
      else process.env[key] = oldEnv[key];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
