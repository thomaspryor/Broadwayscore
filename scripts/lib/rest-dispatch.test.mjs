import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickRun, findRun, waitRun, dispatch, listRunIds, MAX_API_ERRORS } = require('./rest-dispatch.js');

// BRO-5892: REST-only dispatch for cloud, where `gh workflow run` needs GraphQL.
const run = (id, title, created, extra = {}) => ({ id, display_title: title, created_at: created, event: 'workflow_dispatch', html_url: `u/${id}`, ...extra });
const since = '2026-10-22T03:00:00Z';

test('pickRun takes the one new run whose title matches', () => {
  const runs = [run(1, 'execute-approved-fix bro-9 [apply]', '2026-10-22T03:00:05Z'), run(2, 'execute-approved-fix bro-9-b [apply]', '2026-10-22T03:00:06Z'), run(3, 'execute-approved-fix bro-9 [apply]', '2026-10-21T00:00:00Z')];
  assert.equal(pickRun(runs, { since, match: 'execute-approved-fix bro-9-b [apply]' }).run.id, 2);
  // An old run with the same title is not ours.
  assert.equal(pickRun([runs[2]], { since, match: 'execute-approved-fix bro-9 [apply]' }).run, undefined);
});

test('pickRun refuses to guess between several new runs', () => {
  const runs = [run(1, 'Run Script', '2026-10-22T03:00:05Z'), run(2, 'Run Script', '2026-10-22T03:00:06Z')];
  assert.equal(pickRun(runs, { since }).ambiguous.length, 2);
  assert.equal(pickRun(runs, { since, match: 'nothing' }).run, undefined);
  assert.equal(pickRun([run(4, 'x', '2026-10-22T03:00:05Z', { event: 'push' })], { since }).run, undefined);
});

test('dispatch POSTs ref and string inputs; findRun and waitRun poll until done', () => {
  const calls = [];
  const api = (args, opts) => {
    calls.push([args, opts]);
    if (args[0] === '-X') return null;
    if (args[0].includes('/runs?')) return { workflow_runs: calls.length < 3 ? [] : [run(7, 'execute-approved-fix bro-1 [apply]', new Date().toISOString())] };
    return calls.filter((c) => c[0][0].endsWith('/runs/7')).length < 2 ? { status: 'in_progress' } : { status: 'completed', conclusion: 'success', html_url: 'u/7' };
  };
  dispatch({ workflow: 'w.yml', inputs: { n: 5 }, api });
  assert.deepEqual(JSON.parse(calls[0][1].input), { ref: 'main', inputs: { n: '5' } });
  assert.ok(calls[0][0].includes('repos/thomaspryor/Broadwayscore/actions/workflows/w.yml/dispatches'));
  const found = findRun({ workflow: 'w.yml', since: new Date(Date.now() - 1000).toISOString(), match: 'bro-1', api, wait: () => {} });
  assert.equal(found.run.id, 7);
  assert.equal(waitRun({ runId: 7, api, wait: () => {} }).conclusion, 'success');
  let t = 0;
  assert.equal(waitRun({ runId: 8, api: () => ({ status: 'queued' }), wait: () => {}, now: () => (t += 1000), timeoutMs: 3000 }), null);
});

test('runs listed before the dispatch are never ours, even inside the clock-skew window', () => {
  const runs = [run(1, 'Run Script', '2026-10-22T03:00:01Z'), run(2, 'Run Script', '2026-10-22T03:00:06Z')];
  const before = listRunIds({ workflow: 'w.yml', api: () => ({ workflow_runs: [runs[0]] }) });
  assert.deepEqual([...before], [1]);
  assert.equal(pickRun(runs, { since, exclude: before }).run.id, 2);
});

test('a transient API error during a wait is ridden out; a run of them throws', () => {
  let n = 0;
  const flaky = () => { n += 1; if (n <= 2) throw new Error('HTTP 502'); return { status: 'completed', conclusion: 'success' }; };
  assert.equal(waitRun({ runId: 1, api: flaky, wait: () => {} }).conclusion, 'success');
  assert.throws(() => waitRun({ runId: 1, api: () => { throw new Error('HTTP 502'); }, wait: () => {} }), /502/);
  let calls = 0;
  assert.throws(() => findRun({ workflow: 'w.yml', api: () => { calls += 1; throw new Error('rate limit'); }, wait: () => {} }));
  assert.equal(calls, MAX_API_ERRORS);
});
