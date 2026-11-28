import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { gatherRunShowIds, gatherCoversShow, showsNeedingGather } = require('./gather-idempotency.js');

const SEP = '— ';
const title = (list) => `Gather Review Data ${SEP}${list}`;

test('gatherRunShowIds parses the comma list after the separator', () => {
  assert.deepEqual(gatherRunShowIds(title('a-2026,b-2026, c-2026')), ['a-2026', 'b-2026', 'c-2026']);
});

test('gatherRunShowIds returns [] for titles without the separator (legacy runs)', () => {
  assert.deepEqual(gatherRunShowIds('Gather Review Data'), []);
  assert.deepEqual(gatherRunShowIds(undefined), []);
  assert.deepEqual(gatherRunShowIds(null), []);
});

test('gatherCoversShow is an exact list-member match, not a prefix match', () => {
  assert.equal(gatherCoversShow(title('the-bear-2025,sinatra-2026'), 'sinatra-2026'), true);
  // prefix collision must NOT match
  assert.equal(gatherCoversShow(title('the-bear-bites-back-2025'), 'the-bear-2025'), false);
  assert.equal(gatherCoversShow(title('a-2026'), ''), false);
});

test('showsNeedingGather filters out shows covered by an ACTIVE run', () => {
  const runs = [
    { status: 'in_progress', displayTitle: title('sinatra-2026,cyrano-2026') },
    { status: 'queued', displayTitle: title('much-ado-2026') },
    { status: 'completed', displayTitle: title('the-truth-2026') }, // not active → does NOT cover
  ];
  const want = ['sinatra-2026', 'cyrano-2026', 'much-ado-2026', 'the-truth-2026', 'misanthrope-2026'];
  // sinatra+cyrano (in_progress) and much-ado (queued) are covered; the-truth's run is completed so it still needs gather
  assert.deepEqual(showsNeedingGather(runs, want), ['the-truth-2026', 'misanthrope-2026']);
});

test('showsNeedingGather treats queued/waiting/pending/requested as active', () => {
  for (const status of ['queued', 'waiting', 'pending', 'requested', 'in_progress']) {
    const runs = [{ status, displayTitle: title('x-2026') }];
    assert.deepEqual(showsNeedingGather(runs, ['x-2026']), [], `status ${status} should cover`);
  }
});

test('showsNeedingGather dedups and preserves order; empty/garbage inputs are safe', () => {
  assert.deepEqual(showsNeedingGather([], ['b-2026', 'a-2026', 'b-2026']), ['b-2026', 'a-2026']);
  assert.deepEqual(showsNeedingGather(null, ['a-2026']), ['a-2026']);
  assert.deepEqual(showsNeedingGather([{ status: 'in_progress' }], ['a-2026']), ['a-2026']); // no displayTitle → covers nothing
});
