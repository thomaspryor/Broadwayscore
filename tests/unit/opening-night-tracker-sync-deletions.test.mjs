import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import childProcess from 'node:child_process';

const require = createRequire(import.meta.url);
const modulePath = require.resolve('../../scripts/lib/opening-night-tracker-sync.js');
const { mergeTrackerEntries, clearTrackerEntries } = require(modulePath);

const draft = { draftId: 'old', draftStatus: 'draft', draftCreatedAt: '2026-04-11T12:00:00Z' };
const tracker = () => ({ version: 1, shows: {
  'broadway:a+b': { ...draft }, a: { ...draft }, b: { ...draft },
  unrelated: { draftId: 'other', draftStatus: 'sent', sentAt: '2026-04-11T13:00:00Z' },
} });

test('explicit deletions clear the broadcast and mirrors, preserving unrelated remote records', () => {
  const remote = tracker();
  const deletedEntries = Object.fromEntries(['broadway:a+b', 'a', 'b'].map(k => [k, remote.shows[k]]));
  const result = mergeTrackerEntries(remote, { shows: {} }, { deletedEntries });
  assert.deepEqual(result, { version: 1, shows: { unrelated: remote.shows.unrelated } });
  assert.equal(Object.keys(remote.shows).length, 4, 'merge does not mutate its inputs');
});

test('omission alone never deletes remote records', () => {
  const remote = tracker();
  assert.deepEqual(mergeTrackerEntries(remote, { shows: {} }), remote);
});

test('deletions preserve a concurrently sent, replaced, or otherwise changed remote record', () => {
  for (const update of [
    { draftStatus: 'sent', sentAt: '2026-04-11T12:00:00Z' },
    { draftId: 'replacement' },
    { lastReconciledAt: '2026-04-11T13:00:00Z' },
  ]) {
    const rec = { ...draft, ...update };
    const result = mergeTrackerEntries({ shows: { a: rec } }, { shows: {} }, { deletedEntries: { a: draft } });
    assert.deepEqual(result.shows.a, rec);
  }
});

test('a replacement in local data survives a deletion request and the remote newer-state guard still applies', () => {
  const replacement = { ...draft, draftId: 'new', draftCreatedAt: '2026-04-11T14:00:00Z' };
  const local = { shows: { a: replacement } };
  const opts = { deletedEntries: { a: draft } };
  assert.deepEqual(mergeTrackerEntries({ shows: { a: draft } }, local, opts).shows.a, replacement);
  const sent = { ...replacement, draftStatus: 'sent', sentAt: '2026-04-11T15:00:00Z' };
  assert.deepEqual(mergeTrackerEntries({ shows: { a: sent } }, local, opts).shows.a, sent);
});

test('deleting an already absent remote key is idempotent', () => {
  assert.deepEqual(mergeTrackerEntries(null, { shows: {} }, { deletedEntries: { a: draft } }), { shows: {} });
});

test('the recreate writer persists and syncs every cleared record before replacement creation', () => {
  const local = tracker();
  const remote = structuredClone(local);
  const events = [];
  clearTrackerEntries(local, ['broadway:a+b', 'a', 'b'], {
    save(data) {
      events.push('save');
      assert.deepEqual(Object.keys(data.shows), ['unrelated']);
    },
    sync(data, opts) {
      events.push('sync');
      assert.deepEqual(Object.keys(opts.deletedEntries), ['broadway:a+b', 'a', 'b']);
      assert.deepEqual(mergeTrackerEntries(remote, data, opts), local);
    },
  });
  assert.deepEqual(events, ['save', 'sync']);
});

test('partial failure cleanup clears only records of drafts actually deleted', () => {
  const local = tracker();
  local.shows.b = { ...draft, draftId: 'failed-delete' };
  const remote = structuredClone(local);
  const keys = Object.keys(local.shows).filter(k => local.shows[k].draftId === 'old');
  clearTrackerEntries(local, keys, {
    save() {},
    sync(data, opts) {
      const merged = mergeTrackerEntries(remote, data, opts);
      assert.deepEqual(merged, local);
      assert.equal(merged.shows.b.draftId, 'failed-delete');
      assert.equal(merged.shows.unrelated.draftStatus, 'sent');
    },
  });
});

test('empty cleanup does not save or sync', () => {
  clearTrackerEntries(tracker(), ['missing'], {
    save() { assert.fail('unexpected save'); },
    sync() { assert.fail('unexpected sync'); },
  });
});

test('origin sync forwards deletions and rechecks them against fresh remote state on a SHA retry', (t) => {
  const remote = tracker();
  const retryRemote = tracker();
  retryRemote.shows.a = { ...draft, draftStatus: 'sent', sentAt: '2026-04-11T13:00:00Z' };
  const puts = [];
  let gets = 0;
  const oldActions = process.env.GITHUB_ACTIONS;
  const cachedModule = require.cache[modulePath];
  process.env.GITHUB_ACTIONS = 'false';
  t.mock.method(childProcess, 'execSync', (cmd) => {
    if (cmd === 'gh auth status') return '';
    if (cmd.startsWith('gh api repos/')) {
      const parsed = gets++ === 0 ? remote : retryRemote;
      return JSON.stringify({ sha: `sha-${gets}`, content: Buffer.from(JSON.stringify(parsed)).toString('base64') });
    }
    if (cmd.startsWith('gh api --method PUT ')) {
      const payload = JSON.parse(fs.readFileSync(JSON.parse(cmd.split(' --input ')[1]), 'utf8'));
      puts.push({ sha: payload.sha, data: JSON.parse(Buffer.from(payload.content, 'base64').toString('utf8')) });
      if (puts.length === 1) throw new Error('409 sha conflict');
      return '';
    }
    assert.fail(`unexpected command: ${cmd}`);
  });
  delete require.cache[modulePath];
  try {
    const { syncTrackerToOrigin } = require(modulePath);
    syncTrackerToOrigin({ shows: {} }, { deletedEntries: { a: draft, b: draft } });
    assert.equal(gets, 2);
    assert.equal(puts.length, 2);
    assert.equal(Object.hasOwn(puts[0].data.shows, 'a'), false);
    assert.deepEqual(puts[1].data.shows.a, retryRemote.shows.a);
    assert.equal(Object.hasOwn(puts[0].data.shows, 'b'), false);
    assert.equal(Object.hasOwn(puts[1].data.shows, 'b'), false, 'unchanged record is deleted again on retry');
    assert.deepEqual(puts[1].data.shows.unrelated, remote.shows.unrelated);
    assert.deepEqual(puts.map(p => p.sha), ['sha-1', 'sha-2']);
  } finally {
    require.cache[modulePath] = cachedModule;
    if (oldActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = oldActions;
  }
});
