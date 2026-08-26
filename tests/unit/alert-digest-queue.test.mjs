/**
 * BRO-257 — data/audit/alert-digest-queue.json now has 12+ committer
 * workflows; scripts/lib/push-with-retry.sh's generic
 * `data/collection-state/*|data/audit/*` conflict-resolution arm resolves a
 * conflict by keeping ONE side's file WHOLESALE ("keep-local"). That is safe
 * for per-run-independent audit logs, but this file accumulates queued
 * digest lines across runs (scripts/lib/owner-alert-router.js's
 * queueDigestLine()) — a whole-file keep-local silently dropped whichever
 * workflow lost the rebase/push race's newly-queued line.
 *
 * Part 1 unit-tests the pure merge function (scripts/lib/merge-alert-digest-
 * queue.js). Part 2 is a real end-to-end reproduction: two clones each queue
 * a different conditionKey, one pushes first, the other runs the REAL
 * push-with-retry.sh — asserting BOTH conditionKeys survive on origin proves
 * the fix, not just the helper.
 *
 * Two concurrent appends to the SAME array position (the common case —
 * queueDigestLine() always appends at the end) is an add/add hunk that
 * `git rebase -X theirs` silently auto-resolves in favour of the replayed
 * commit WITHOUT ever reporting a conflict, so resolve_conflicts()'s case
 * arm never runs for this shape (confirmed live — the case arm alone was
 * NOT enough to pass this test). The actual fix is push-with-retry.sh's
 * reconcile_merged_json() making an unconditional, single-file-scoped call
 * to scripts/lib/reconcile-merged-json.js for this file regardless of the
 * PUSH_RECONCILE_MERGED_JSON opt-in flag (most of this file's 12+ writer
 * workflows never set it) — the case arm remains as defense-in-depth for
 * conflicts git DOES report (e.g. a modify/delete shape).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { mergeAlertDigestQueue, keyOf } = require('../../scripts/lib/merge-alert-digest-queue.js');
const { explicitMergerFor, mergerFor } = require('../../scripts/lib/reconcile-merged-json.js');

const SCRIPT = path.resolve(fileURLToPath(new URL('../../scripts/lib/push-with-retry.sh', import.meta.url)));

const line = (conditionKey, extra = {}) => ({
  conditionKey,
  title: conditionKey,
  description: 'desc',
  severity: 'warning',
  url: null,
  decision: false,
  decisionPrompt: null,
  model: null,
  fields: [],
  queuedAt: '2026-08-24T00:00:00.000Z',
  ...extra,
});

// ── Part 1: pure merge function ──────────────────────────────────────────

test('keyOf: conditionKey is the natural key', () => {
  assert.equal(keyOf(line('a')), 'a');
  assert.equal(keyOf({}), null);
  assert.equal(keyOf(null), null);
});

test('union: two racing writers each queue a different line — both survive (the drop this fixes)', () => {
  const ours = [line('data-health-check:cookie-expiry')];
  const remote = [line('scrape-new-aggregators:go-live')];
  const { merged, stats } = mergeAlertDigestQueue(ours, remote);
  assert.deepEqual(merged.map((e) => e.conditionKey).sort(), ['data-health-check:cookie-expiry', 'scrape-new-aggregators:go-live']);
  assert.equal(stats.added, 1);
});

test('collision, remote line is newer: remote wins (mirrors queueDigestLine\'s own replace-stale-line behavior)', () => {
  const ours = [line('x', { queuedAt: '2026-08-24T00:00:00.000Z', description: 'stale' })];
  const remote = [line('x', { queuedAt: '2026-08-24T01:00:00.000Z', description: 'fresh' })];
  const { merged, stats } = mergeAlertDigestQueue(ours, remote);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].description, 'fresh');
  assert.equal(stats.resolvedToRemoteNewer, 1);
});

test('collision, ours is newer: ours wins', () => {
  const ours = [line('x', { queuedAt: '2026-08-24T02:00:00.000Z', description: 'fresh' })];
  const remote = [line('x', { queuedAt: '2026-08-24T00:00:00.000Z', description: 'stale' })];
  const { merged } = mergeAlertDigestQueue(ours, remote);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].description, 'fresh');
});

test('collision, unparsable/missing queuedAt on either side: falls back to keeping ours', () => {
  const ours = [line('x', { queuedAt: 'not-a-date', description: 'ours' })];
  const remote = [line('x', { queuedAt: '2026-08-24T00:00:00.000Z', description: 'remote' })];
  assert.equal(mergeAlertDigestQueue(ours, remote).merged[0].description, 'ours');

  const ours2 = [line('x', { queuedAt: undefined, description: 'ours' })];
  const remote2 = [line('x', { queuedAt: '2026-08-24T00:00:00.000Z', description: 'remote' })];
  assert.equal(mergeAlertDigestQueue(ours2, remote2).merged[0].description, 'ours');
});

test('order: ours first (preserved), remote-only appended in remote order', () => {
  const ours = [line('a'), line('b')];
  const remote = [line('c'), line('b'), line('d')];
  const { merged } = mergeAlertDigestQueue(ours, remote);
  assert.deepEqual(merged.map((e) => e.conditionKey), ['a', 'b', 'c', 'd']);
});

test('tolerates missing/malformed input on either side', () => {
  assert.deepEqual(mergeAlertDigestQueue(null, null).merged, []);
  assert.deepEqual(mergeAlertDigestQueue(undefined, [line('a')]).merged.map((e) => e.conditionKey), ['a']);
  assert.deepEqual(mergeAlertDigestQueue([line('a')], 'nope').merged.map((e) => e.conditionKey), ['a']);
  // keyless entries on the remote side can't be deduped — dropped rather than risking a bad merge
  assert.deepEqual(mergeAlertDigestQueue([], [{ title: 'no key' }, line('real')]).merged.map((e) => e.conditionKey), ['real']);
});

test('explicitMergerFor resolves alert-digest-queue.json even though it is optInReconcile:false (excluded from the whole-sweep MANAGED list)', () => {
  assert.equal(mergerFor('data/audit/alert-digest-queue.json'), null, 'sanity: NOT part of the opt-in whole-sweep MANAGED list');
  const entry = explicitMergerFor('data/audit/alert-digest-queue.json');
  assert.ok(entry, 'explicitMergerFor should find it via the registry directly, unfiltered by optInReconcile');
  assert.equal(entry.file, 'data/audit/alert-digest-queue.json');
  assert.equal(typeof entry.merge, 'function');
});

test('explicitMergerFor returns null for a path with no registry entry', () => {
  assert.equal(explicitMergerFor('data/audit/totally-unregistered-file.json'), null);
});

// ── Part 2: real end-to-end reproduction via the actual push-with-retry.sh ──

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t',
  GITHUB_ACTIONS: '',
};

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } }).toString();
}

function writeQueue(dir, entries) {
  fs.mkdirSync(path.join(dir, 'data', 'audit'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'audit', 'alert-digest-queue.json'), JSON.stringify(entries, null, 2) + '\n');
}

function readQueue(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'data', 'audit', 'alert-digest-queue.json'), 'utf8'));
}

test('BRO-257 reproduction: two workflows queue different digest lines concurrently — both survive the real push-with-retry.sh conflict path', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-digest-queue-'));
  const originDir = path.join(tmp, 'origin.git');
  const seedDir = path.join(tmp, 'seed');
  const healthCheckDir = path.join(tmp, 'data-health-check');
  const scrapeDir = path.join(tmp, 'scrape-new-aggregators');

  try {
    sh(`git init -q --bare "${originDir}"`, tmp);
    sh(`git init -q "${seedDir}"`, tmp);
    sh('git config user.email t@t.t', seedDir);
    sh('git config user.name t', seedDir);
    writeQueue(seedDir, [line('base:existing-condition')]);
    sh('git add -A', seedDir);
    sh('git commit -q -m base', seedDir);
    sh('git branch -M main', seedDir);
    sh(`git push -q "${originDir}" main`, seedDir);

    // Two independent workflow checkouts, both starting from the same base.
    for (const dir of [healthCheckDir, scrapeDir]) {
      fs.mkdirSync(dir);
      sh('git init -q', dir);
      sh('git config user.email t@t.t', dir);
      sh('git config user.name t', dir);
      sh(`git remote add origin "${originDir}"`, dir);
      sh('git fetch -q origin main', dir);
      sh('git checkout -q -B main origin/main', dir);
    }

    // data-health-check.yml queues its own condition and pushes first (wins the race).
    writeQueue(healthCheckDir, [line('base:existing-condition'), line('data-health-check:cookie-expiry')]);
    sh('git add -A', healthCheckDir);
    sh('git commit -q -m "data-health-check: queue cookie-expiry"', healthCheckDir);
    sh(`git push -q "${originDir}" main`, healthCheckDir);

    // scrape-new-aggregators.yml, unaware of the above, queues a DIFFERENT
    // condition against the same stale base — its plain push is rejected,
    // forcing push-with-retry.sh into an actual rebase conflict on this file.
    writeQueue(scrapeDir, [line('base:existing-condition'), line('scrape-new-aggregators:go-live')]);
    sh('git add -A', scrapeDir);
    sh('git commit -q -m "scrape-new-aggregators: queue go-live"', scrapeDir);

    let stdout = '';
    let code = 0;
    try {
      stdout = execSync(`bash "${SCRIPT}" 3 main`, {
        cwd: scrapeDir,
        stdio: 'pipe',
        env: { ...process.env, ...GIT_ENV, PUSH_FAILURE_LOG: path.join(tmp, 'failures.jsonl') },
      }).toString();
    } catch (err) {
      code = err.status ?? 1;
      stdout = `${err.stdout || ''}${err.stderr || ''}`;
    }

    assert.equal(code, 0, `push-with-retry.sh failed. Output:\n${stdout}`);
    // Two independent concurrent-writer additions at the SAME array position
    // (both appending) is an add/add hunk that `git rebase -X theirs` auto-
    // resolves in favour of the replayed commit WITHOUT ever reporting a
    // conflict — so this is expected to take the unconditional reconcile
    // pass (reconcile_merged_json()'s always-on single-file call), not the
    // resolve_conflicts() case arm, which only fires on an actual reported
    // conflict. Accept either log line; what actually matters is the final
    // survival assertion below.
    assert.match(stdout, /alert-digest-queue merge|Reconciled \d+ union-merged JSON file/,
      `expected either the merge case arm or the unconditional reconcile pass to fire. Output:\n${stdout}`);

    // Read the final state straight from the bare origin (no working tree
    // needed) — avoids requiring a third clone just to inspect the result.
    const finalQueueText = execSync(`git --git-dir="${originDir}" show main:data/audit/alert-digest-queue.json`, { stdio: 'pipe' }).toString();
    const finalQueue = JSON.parse(finalQueueText);
    const keys = finalQueue.map((e) => e.conditionKey).sort();

    // The bug: whole-file keep-local would have kept ONLY scrapeDir's local
    // version, silently dropping data-health-check.yml's already-pushed line.
    assert.deepEqual(keys, ['base:existing-condition', 'data-health-check:cookie-expiry', 'scrape-new-aggregators:go-live'].sort(),
      `expected both concurrent writers' lines to survive; got ${JSON.stringify(keys)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
