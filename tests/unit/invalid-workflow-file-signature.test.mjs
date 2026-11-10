import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isInvalidWorkflowFileRun, findInvalidWorkflowFiles } = require('../../scripts/lib/invalid-workflow-file-signature.js');

const P = '.github/workflows/opening-night-orchestrator.yml';
// Real BRO-7306 shape: runs 1800-1998, 2026-11-10.
const invalid = (id, at = '2026-11-10T09:41:12Z') => ({
  id, name: P, path: P, event: 'push', status: 'completed', conclusion: 'failure',
  created_at: at, updated_at: at, html_url: `https://github.com/x/actions/runs/${id}`,
});
const normalFailed = {
  id: 5, name: 'Opening Night Orchestrator', path: P, event: 'schedule', conclusion: 'failure',
  created_at: '2026-11-10T08:00:00Z', updated_at: '2026-11-10T08:07:30Z',
};
const normalPush = {
  id: 6, name: 'Test', path: '.github/workflows/test.yml', event: 'push', conclusion: 'success',
  created_at: '2026-11-10T10:00:00Z', updated_at: '2026-11-10T10:12:00Z',
};

test('flags the BRO-7306 run shape', () => {
  assert.equal(isInvalidWorkflowFileRun(invalid(1800)), true);
});
test('does not flag a normal failed run or a normal push run', () => {
  assert.equal(isInvalidWorkflowFileRun(normalFailed), false);
  assert.equal(isInvalidWorkflowFileRun(normalPush), false);
});
test('does not flag a no-name workflow whose real push run failed after running', () => {
  assert.equal(isInvalidWorkflowFileRun({ ...invalid(7), updated_at: '2026-11-10T09:45:00Z' }), false);
});
test('does not flag cancelled/successful instant runs or garbage', () => {
  assert.equal(isInvalidWorkflowFileRun({ ...invalid(8), conclusion: 'cancelled' }), false);
  assert.equal(isInvalidWorkflowFileRun({ ...invalid(9), event: 'schedule' }), false);
  assert.equal(isInvalidWorkflowFileRun(null), false);
  assert.equal(isInvalidWorkflowFileRun({ ...invalid(10), created_at: 'nope' }), false);
});
test('groups per workflow, counts, newest first, ignores normal runs', () => {
  const runs = [invalid(1800, '2026-11-10T09:41:00Z'), invalid(1998, '2026-11-10T17:59:00Z'), normalFailed, normalPush];
  const out = findInvalidWorkflowFiles(runs);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, 'opening-night-orchestrator.yml');
  assert.equal(out[0].count, 2);
  assert.equal(out[0].newestAt, '2026-11-10T17:59:00.000Z');
});
test('a later normal run of the same file means it parses again', () => {
  const fixed = { ...normalFailed, created_at: '2026-11-10T18:30:00Z', updated_at: '2026-11-10T18:40:00Z' };
  assert.deepEqual(findInvalidWorkflowFiles([invalid(1998, '2026-11-10T17:59:00Z'), fixed]), []);
});

test('paging key is page-worthy, the ordinary key is not (router would downgrade it)', () => {
  const { isPageWorthy } = require('../../scripts/lib/page-worthy-alerts.js');
  assert.equal(isPageWorthy('workflow-invalid-file:page:opening-night-orchestrator.yml'), true);
  assert.equal(isPageWorthy('workflow-invalid-file:test.yml'), false);
});
test('health-check turns findings into one error row per workflow, pass row when none', () => {
  const { invalidWorkflowFileResults } = require('../../scripts/health-check.js');
  const rows = invalidWorkflowFileResults({ skipped: false, invalidWorkflowFiles: findInvalidWorkflowFiles([invalid(1), invalid(2)]) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'error');
  assert.equal(invalidWorkflowFileResults({ skipped: false, invalidWorkflowFiles: [] })[0].status, 'pass');
  assert.deepEqual(invalidWorkflowFileResults({ skipped: true }), []);
});
