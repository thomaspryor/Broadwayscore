// BRO-4654: one 2-call answer to "is a rebuild queued or running?"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { countActiveRuns, fetchActiveRuns, isSaturated, fetchExactCount, PER_PAGE } = require('./rebuild-in-flight.js');

const run = (p) => ({ path: p });
const FILES = ['rebuild-reviews.yml', 'rebuild-fast.yml'];

test('counts only runs of the named workflows, across both status pages', () => {
  const inProgress = { workflow_runs: [run('.github/workflows/rebuild-fast.yml'), run('.github/workflows/test.yml')] };
  const queued = { workflow_runs: [run('.github/workflows/rebuild-reviews.yml'), run('.github/workflows/land.yml')] };
  assert.equal(countActiveRuns([inProgress, queued], FILES), 2);
});

test('zero when nothing matches, and tolerates junk payloads', () => {
  assert.equal(countActiveRuns([{ workflow_runs: [run('.github/workflows/land.yml')] }, {}], FILES), 0);
  assert.equal(countActiveRuns([null, { workflow_runs: 'x' }, { workflow_runs: [null, {}] }], FILES), 0);
});

test('does not match a workflow whose name merely ends the same way', () => {
  assert.equal(countActiveRuns([{ workflow_runs: [run('.github/workflows/pre-rebuild-fast.yml')] }], FILES), 0);
});

test('matches a path carrying an @ref suffix and a bare file argument with a dir', () => {
  assert.equal(countActiveRuns([{ workflow_runs: [run('.github/workflows/rebuild-fast.yml@refs/heads/main')] }], ['.github/workflows/rebuild-fast.yml']), 1);
});

test('a full page reports at least 1 so the caller skips instead of racing an unseen rebuild', () => {
  const full = { workflow_runs: Array.from({ length: PER_PAGE }, () => run('.github/workflows/test.yml')) };
  assert.equal(countActiveRuns([full, { workflow_runs: [] }], FILES), 1);
});

test('fetchActiveRuns makes exactly 2 calls (in_progress, queued) and throws on HTTP errors', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return { ok: true, json: async () => ({ workflow_runs: [] }) }; };
  const payloads = await fetchActiveRuns({ repo: 'o/r', token: 'T', fetchImpl });
  assert.equal(payloads.length, 2);
  assert.deepEqual(urls, [
    'https://api.github.com/repos/o/r/actions/runs?status=in_progress&per_page=100',
    'https://api.github.com/repos/o/r/actions/runs?status=queued&per_page=100',
  ]);
  await assert.rejects(fetchActiveRuns({ repo: 'o/r', token: 'T', fetchImpl: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
});

test('isSaturated flags only a full page', () => {
  const full = { workflow_runs: Array.from({ length: PER_PAGE }, () => run('.github/workflows/test.yml')) };
  assert.equal(isSaturated([full, { workflow_runs: [] }]), true);
  assert.equal(isSaturated([{ workflow_runs: [run('a.yml')] }, null, {}]), false);
});

test('fetchExactCount sums total_count per workflow and status, 1 call each, by file name (no lookup)', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ total_count: url.includes('rebuild-fast.yml') && url.includes('queued') ? 2 : 0 }) };
  };
  assert.equal(await fetchExactCount({ repo: 'o/r', token: 'T', files: ['.github/workflows/rebuild-reviews.yml', 'rebuild-fast.yml'], fetchImpl }), 2);
  assert.deepEqual(urls, [
    'https://api.github.com/repos/o/r/actions/workflows/rebuild-reviews.yml/runs?status=in_progress&per_page=1',
    'https://api.github.com/repos/o/r/actions/workflows/rebuild-reviews.yml/runs?status=queued&per_page=1',
    'https://api.github.com/repos/o/r/actions/workflows/rebuild-fast.yml/runs?status=in_progress&per_page=1',
    'https://api.github.com/repos/o/r/actions/workflows/rebuild-fast.yml/runs?status=queued&per_page=1',
  ]);
  await assert.rejects(fetchExactCount({ repo: 'o/r', token: 'T', files: ['x.yml'], fetchImpl: async () => ({ ok: false, status: 404 }) }), /HTTP 404/);
});
