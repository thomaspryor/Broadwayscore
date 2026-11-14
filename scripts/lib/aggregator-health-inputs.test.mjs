import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { loadRuns } = require('./aggregator-health-inputs.js');

const sources = [
  { id: 'a', workflows: { 'shared.yml': 7, 'a.yml': 1 } },
  { id: 'b', workflows: { 'shared.yml': 7 } },
  { id: 'retired', retired: { reason: 'closed' }, workflows: { 'retired.yml': 7 } },
];

test('loadRuns requests cron history so frequent dispatches cannot hide a stopped cron', () => {
  const calls = [];
  const scheduled = { created_at: '2026-06-22T08:13:00Z', conclusion: 'success', event: 'schedule' };
  const failed = [];
  const runs = loadRuns(sources, failed, { repo: 'owner/repo', api: endpoint => {
    calls.push(endpoint);
    const url = new URL(endpoint, 'https://api.github.com/');
    assert.equal(url.searchParams.get('event'), 'schedule');
    assert.equal(url.searchParams.get('per_page'), '30');
    return { workflow_runs: [scheduled] };
  } });
  assert.equal(calls.length, 2, 'shared workflow fetched once; retired source skipped');
  assert.deepEqual(runs, { 'shared.yml': [scheduled], 'a.yml': [scheduled] });
  assert.deepEqual(failed, []);
});

test('missing or malformed API history stays unknown, distinct from a readable empty list', () => {
  for (const body of [{}, { workflow_runs: null }, { workflow_runs: 'invalid' }]) {
    const failed = [];
    const runs = loadRuns(sources, failed, { repo: 'owner/repo', api: endpoint => {
      if (endpoint.includes('/shared.yml/')) return { workflow_runs: [] };
      return body;
    } });
    assert.deepEqual(runs, { 'shared.yml': [] });
    assert.deepEqual(failed, ['a.yml']);
  }
  const failed = [];
  assert.equal(loadRuns(sources, failed, { repo: 'owner/repo', api: () => { throw new Error('unavailable'); } }), null);
  assert.deepEqual(failed, ['shared.yml', 'a.yml']);
});
