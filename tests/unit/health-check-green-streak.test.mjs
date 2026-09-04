/**
 * BRO-2767 regression tests.
 *
 * `gh run list --limit=N` returns arbitrary, sometimes months-stale result SETS
 * on this repo (6,600+ test.yml runs on main) — three identical invocations a
 * minute apart on 2026-09-04 returned Sep 3-4 runs, then Aug 26-29 runs, then
 * Aug 5 runs, with core rate limit at 5000/5000 and the full workflow path in
 * use. health-check.js's consumers all treat row 0 as "the newest run", so a
 * stale page silently yields a wrong verdict: a main-red streak that is not
 * happening (naming the wrong firstRedSha), or a false "Last run N hours ago"
 * on every CRITICAL_CRONS entry.
 *
 * These require() the real exported functions rather than copying the logic,
 * so a future edit that reintroduces the transport or drops the sort fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ghRunsQuery, sortRunsNewestFirst, firstRunCreatedAt } = require('../../scripts/health-check.js');

test('ghRunsQuery targets the REST endpoint, never `gh run list`', () => {
  const q = ghRunsQuery('test.yml', { limit: 30, branch: 'main' });
  assert.ok(!q.includes('gh run list'), `must not use gh run list, got: ${q}`);
  assert.ok(q.startsWith('gh api '), `must go through gh api, got: ${q}`);
  assert.ok(q.includes('/actions/workflows/test.yml/runs'), 'must hit the workflow runs endpoint');
  assert.ok(q.includes('per_page=30'), 'limit must map to per_page');
  assert.ok(q.includes('branch=main'), 'branch must be passed through');
});

test('ghRunsQuery passes a status filter and omits absent params', () => {
  const q = ghRunsQuery('opening-night-checklist.yml', { limit: 1, status: 'success' });
  assert.ok(q.includes('status=success'), 'status must be passed through');
  assert.ok(!q.includes('branch='), 'branch must be omitted when not given');
});

test('ghRunsQuery normalises REST field names to the shape callers read', () => {
  const q = ghRunsQuery('test.yml', { limit: 5 });
  for (const field of ['databaseId: .id', 'headSha: .head_sha', 'createdAt: .created_at', 'conclusion: .conclusion']) {
    assert.ok(q.includes(field), `jq must map ${field}`);
  }
});

test('sortRunsNewestFirst reorders a mis-ordered page', () => {
  // Shaped exactly like the live incident: an August page arriving ahead of
  // the September rows it should sit behind.
  const scrambled = [
    { databaseId: 31037393070, createdAt: '2026-08-05T19:00:19Z', conclusion: 'failure' },
    { databaseId: 33865061211, createdAt: '2026-09-04T10:49:43Z', conclusion: 'cancelled' },
    { databaseId: 33796786927, createdAt: '2026-09-03T19:30:07Z', conclusion: 'success' },
  ];
  const sorted = sortRunsNewestFirst(scrambled);
  assert.deepEqual(sorted.map((r) => r.databaseId), [33865061211, 33796786927, 31037393070]);
});

test('sortRunsNewestFirst does not mutate its input', () => {
  const input = [
    { createdAt: '2026-08-05T19:00:19Z' },
    { createdAt: '2026-09-04T10:49:43Z' },
  ];
  const before = input.map((r) => r.createdAt);
  sortRunsNewestFirst(input);
  assert.deepEqual(input.map((r) => r.createdAt), before, 'caller array must be untouched');
});

test('sortRunsNewestFirst tolerates junk instead of throwing', () => {
  assert.deepEqual(sortRunsNewestFirst(null), []);
  assert.deepEqual(sortRunsNewestFirst(undefined), []);
  assert.deepEqual(sortRunsNewestFirst('not an array'), []);
  // Unparseable timestamps sort last so a real run is still preferred as head.
  const mixed = sortRunsNewestFirst([
    { id: 'bad', createdAt: 'not-a-date' },
    { id: 'good', createdAt: '2026-09-04T10:49:43Z' },
  ]);
  assert.equal(mixed[0].id, 'good');
});

test('firstRunCreatedAt sorts before taking the head', () => {
  const raw = JSON.stringify([
    { createdAt: '2026-08-05T19:00:19Z' },
    { createdAt: '2026-09-04T10:49:43Z' },
  ]);
  assert.equal(firstRunCreatedAt(raw), '2026-09-04T10:49:43Z');
});

test('firstRunCreatedAt returns empty string for no runs or bad payloads', () => {
  assert.equal(firstRunCreatedAt(''), '');
  assert.equal(firstRunCreatedAt('[]'), '');
  assert.equal(firstRunCreatedAt('{not json'), '');
});
