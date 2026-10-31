// BRO-2463/BRO-5310: audit/feedback-request-ledger.json and the JSONL audit logs
// are optInReconcile:false, so (like alert-digest-queue.json, BRO-257) a clean
// `git rebase -X theirs` append/append hunk drops the remote writer's entry
// without ever reaching push-with-retry.sh's conflict case arm. push-with-retry
// must therefore call reconcile-merged-json.js for them unconditionally.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CORE_DATA_MERGE_REGISTRY } = require('../../scripts/lib/core-data-merge-registry.js');
const { additionsOnly } = require('../../scripts/lib/reconcile-merged-json.js');

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const RECONCILE = path.join(REPO, 'scripts/lib/reconcile-merged-json.js');
const PUSH = fs.readFileSync(path.join(REPO, 'scripts/lib/push-with-retry.sh'), 'utf8');

const CASES = [
  { file: 'data/audit/express-retry-queue.json', mk: (id) => ({ showId: id, market: 'broadway', queuedAt: `2026-10-13T00:00:0${id.length}Z`, dueAt: '2026-10-13T01:00:00Z', attempted: false }) },
  { file: 'data/audit/feedback-request-ledger.json', mk: (id) => ({ key: `req-${id}`, status: 'open' }) },
  { file: 'data/audit/alert-router-attempts.jsonl', jsonl: true, prunes: true, mk: (id) => ({ ts: '2026-10-13T00:00:00Z', conditionKey: id, title: id, ok: true, error: null }) },
  { file: 'data/audit/breaker-transitions.jsonl', jsonl: true, mk: (id) => ({ ts: '2026-10-13T00:00:00Z', conditionKey: id, from: 'ok', to: 'tripped', prevTs: null }) },
];

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

for (const c of CASES) {
  test(`push-with-retry.sh reconciles ${c.file} unconditionally`, () => {
    const line = PUSH.split('\n').find((l) => l.includes('reconcile-merged-json.js') && l.includes('"origin/$PULL_BRANCH"') && l.includes('data/audit/alert-digest-queue.json'));
    assert.ok(line, 'targeted reconcile call not found');
    assert.ok(line.includes(c.file), `${c.file} missing from the targeted reconcile call`);
  });

  for (const prune of c.prunes ? [false, true] : [false]) {
    test(`merger restores the remote append a clean -X theirs rebase drops (${c.file}${prune ? ', with retention prune' : ''})`, () => {
      const entry = CORE_DATA_MERGE_REGISTRY.find((e) => c.file.endsWith(e.file));
      assert.ok(entry && entry.merge, 'registered merger');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2463-'));
      try {
        git(dir, 'init', '-q', '-b', 'main');
        git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
        const f = path.join(dir, c.file);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const write = (arr) => fs.writeFileSync(f, c.jsonl
          ? arr.map((e) => JSON.stringify(e)).join('\n') + (arr.length ? '\n' : '')
          : JSON.stringify({ entries: arr }, null, 2) + '\n');
        const read = () => c.jsonl
          ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
          : JSON.parse(fs.readFileSync(f, 'utf8')).entries;
        // Router attempts prune after 30 days. A stale remote keeps the old
        // row, so reconciliation must distinguish our delete from its append.
        const baseEntries = prune ? [{ ...c.mk('pruned'), ts: '2026-09-01T00:00:00Z' }] : [];
        write(baseEntries); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
        const base = git(dir, 'rev-parse', 'HEAD').trim();
        git(dir, 'checkout', '-qb', 'local');
        write([c.mk('bb')]); git(dir, 'commit', '-qam', 'local append');
        git(dir, 'checkout', '-q', 'main');
        write([...baseEntries, c.mk('a')]); git(dir, 'commit', '-qam', 'remote append');
        git(dir, 'checkout', '-q', 'local');
        git(dir, 'rebase', '-X', 'theirs', 'main');
        assert.deepEqual(read(), [c.mk('bb')], 'precondition: -X theirs silently dropped the remote entry');
        execFileSync('node', [RECONCILE, 'main', c.file], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PUSH_RECONCILE_BASE: base } });
        assert.deepEqual(read(), [c.mk('bb'), c.mk('a')], 'both writers survive and pruned rows stay deleted');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    });
  }
}

// BRO-5955: The Pianist's Express push (81788096e4) erased the Imaginary
// Invalid retry queued 3 min earlier (fa0b74587d) from both hand-off files.
const { mergeExpressRetryQueue } = require('../../scripts/lib/merge-express-retry-queue.js');
const q = (showId, extra = {}) => ({ showId, market: 'broadway', queuedAt: `2026-10-22T14:0${showId.length % 10}:00Z`, dueAt: '2026-10-23T03:15:00Z', attempted: false, ...extra });
const ids = (d) => d.entries.map((e) => e.showId);

test('mergeExpressRetryQueue: a remote attempted:true wins over our stale un-attempted copy (BRO-5955)', () => {
  const base = { entries: [q('x')] };
  const { merged } = mergeExpressRetryQueue({ entries: [q('x')] }, { entries: [q('x', { attempted: true, attemptedAt: '2026-10-23T03:50:00Z' })] }, base);
  assert.equal(merged.entries.length, 1);
  assert.equal(merged.entries[0].attempted, true);
});

test('mergeExpressRetryQueue: an entry the remote pruned stays pruned (BRO-5955)', () => {
  const { merged, stats } = mergeExpressRetryQueue({ entries: [q('old'), q('mine')] }, { entries: [] }, { entries: [q('old')] });
  assert.deepEqual(ids(merged), ['mine']);
  assert.equal(stats.remotePruned, 1);
});

test('mergeExpressRetryQueue: an entry we pruned is not resurrected from the remote (BRO-5955)', () => {
  const { merged, stats } = mergeExpressRetryQueue({ entries: [] }, { entries: [q('old'), q('theirs')] }, { entries: [q('old')] });
  assert.deepEqual(ids(merged), ['theirs']);
  assert.equal(stats.deletesHonored, 1);
});

test('mergeExpressRetryQueue: without a base it is the old two-way union (BRO-5955)', () => {
  const { merged, stats } = mergeExpressRetryQueue({ entries: [q('mine')] }, { entries: [q('old'), q('theirs')] });
  assert.deepEqual(ids(merged), ['mine', 'old', 'theirs']);
  assert.equal(stats.baseAvailable, false);
  assert.equal(mergeExpressRetryQueue.requiresTrueBase, true);
});

test('push-with-retry.sh reconciles both Express hand-off files after the rebase (BRO-5955)', () => {
  const line = PUSH.split('\n').find((l) => l.includes('reconcile-merged-json.js') && l.includes('"origin/$PULL_BRANCH"') && l.includes('data/audit/alert-digest-queue.json'));
  assert.ok(line, 'targeted reconcile call not found');
  for (const f of ['data/audit/express-retry-queue.json', 'data/audit/opening-night-express-completed.json']) assert.ok(line.includes(f), `${f} missing`);
});

test('the BRO-5955 incident replay: the real fork point brings back the Imaginary Invalid and Queeney Todd entries', () => {
  const show = (rev, f) => { try { return JSON.parse(execFileSync('git', ['show', `${rev}:${f}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return null; } };
  const Q = 'data/audit/express-retry-queue.json'; const C = 'data/audit/opening-night-express-completed.json';
  // 603c9521b queued Queeney Todd; The Pianist's run forked before it.
  const [ours, remote, base] = ['81788096e4', '81788096e4^', '603c9521b^'].map((r) => show(r, Q));
  const [oursC, remoteC, baseC] = ['81788096e4', '81788096e4^', '603c9521b^'].map((r) => show(r, C));
  if (!ours || !remote || !base || !oursC || !remoteC || !baseC) return; // shallow CI checkout: history not available
  const lost = ['queeney-todd-the-demon-bottom-of-fleet-street-off-broadway-2026', 'the-imaginary-invalid-2026'];
  for (const id of lost) assert.ok(!ids(ours).includes(id), `precondition: ${id} was dropped`);
  const { merged } = mergeExpressRetryQueue(ours, remote, base);
  for (const id of lost.concat('the-pianist-off-west-end-2026')) assert.ok(ids(merged).includes(id), `${id} missing after merge`);
  const { merged: mergedC } = additionsOnly('shows')(oursC, remoteC, baseC);
  for (const id of lost.concat('the-pianist-off-west-end-2026')) assert.ok(id in mergedC.shows, `${id} missing from completed`);
});

// BRO-5204: keyed-object ledgers. land.yml commit de49618478c erased the 8
// time-bomb-tests:* conditions audit-time-bomb-tests.yml had appended to
// alert-ledger.json 5 min earlier: both writers appended a key at the end of
// the object, and the clean -X theirs hunk kept only ours.
const KEYED = [
  { file: 'data/audit/alert-ledger.json', wrap: (o) => ({ conditions: o }), unwrap: (d) => d.conditions, mk: (k) => ({ status: 'open', title: k, firstSeen: '2026-10-12T00:00:00Z', lastSeen: '2026-10-12T00:00:00Z' }) },
  // Production shape (guard-escalation.js nextGuardState): ms-epoch numbers.
  // BRO-5955: Express writes this per show; the registry gives it additions-only.
  { file: 'data/audit/opening-night-express-completed.json', wrap: (o) => ({ shows: o }), unwrap: (d) => d.shows, mk: () => ({ completedAt: '2026-10-22T13:42:00Z', runId: 1, reviewCount: 0, scoredCount: 0, isRetry: false }) },
  { file: 'data/audit/guard-escalation-state.json', wrap: (o) => o, unwrap: (d) => d, mk: () => ({ consecutiveBlocks: 1, firstBlockedAt: 1760227200000, lastBlockedAt: 1760227200000, lastClearedAt: null }) },
];

function keyedRepo(c, { local, remote }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5204-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  const f = path.join(dir, c.file);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const write = (keys) => fs.writeFileSync(f, JSON.stringify(c.wrap(Object.fromEntries(keys.map((k) => [k, c.mk(k)]))), null, 2) + '\n');
  write(['seed', 'old']); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  git(dir, 'checkout', '-qb', 'local');
  write(local); git(dir, 'commit', '-qam', 'local');
  git(dir, 'checkout', '-q', 'main');
  write(remote); git(dir, 'commit', '-qam', 'remote');
  git(dir, 'checkout', '-q', 'local');
  git(dir, 'rebase', '-X', 'theirs', 'main');
  const read = () => Object.keys(c.unwrap(JSON.parse(fs.readFileSync(f, 'utf8')))).sort();
  const reconcile = (envBase) => execFileSync('node', [RECONCILE, 'main', c.file], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PUSH_RECONCILE_BASE: envBase } });
  return { dir, base, read, reconcile, f };
}

for (const c of KEYED) {
  test(`push-with-retry.sh reconciles ${c.file} unconditionally (BRO-5204)`, () => {
    const line = PUSH.split('\n').find((l) => l.includes('reconcile-merged-json.js') && l.includes('"origin/$PULL_BRANCH"') && l.includes('data/audit/alert-digest-queue.json'));
    assert.ok(line && line.includes(c.file), `${c.file} missing from the targeted reconcile call`);
  });

  test(`reconcile restores the remote's appended key a clean -X theirs rebase drops (${c.file})`, () => {
    const r = keyedRepo(c, { local: ['seed', 'old', 'ours'], remote: ['seed', 'old', 'theirs-1', 'theirs-2'] });
    try {
      assert.deepEqual(r.read(), ['old', 'ours', 'seed'], 'precondition: -X theirs dropped the remote keys');
      r.reconcile(r.base);
      assert.deepEqual(r.read(), ['old', 'ours', 'seed', 'theirs-1', 'theirs-2']);
    } finally { fs.rmSync(r.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });

  test(`reconcile honours our own delete instead of resurrecting it (${c.file})`, () => {
    const r = keyedRepo(c, { local: ['seed'], remote: ['seed', 'old', 'theirs'] });
    try {
      r.reconcile(r.base);
      const keys = r.read();
      assert.ok(!keys.includes('old'), 'locally deleted key came back');
      assert.ok(keys.includes('theirs'), 'remote append lost');
    } finally { fs.rmSync(r.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });

  test(`reconcile leaves an untouched file byte-identical (${c.file})`, () => {
    const r = keyedRepo(c, { local: ['seed', 'old', 'ours'], remote: ['seed', 'old', 'theirs'] });
    try {
      r.reconcile(r.base);
      const once = fs.readFileSync(r.f, 'utf8');
      git(r.dir, 'commit', '-qam', 'reconciled');
      const out = r.reconcile(git(r.dir, 'rev-parse', 'main').trim());
      assert.equal(fs.readFileSync(r.f, 'utf8'), once);
      assert.equal(out.trim(), '', 'reported a change on a no-op pass');
    } finally { fs.rmSync(r.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
}

test('additions-only reconcile never overrides a shared key, even when the remote copy is fresher (BRO-5204 ship-check)', () => {
  const merge = additionsOnly('conditions');
  const base = { conditions: { k: { status: 'open', lastSeen: '2026-10-12T00:00:00Z', cardId: null } } };
  const local = { conditions: { k: { status: 'resolved', lastSeen: '2026-10-12T00:00:00Z', cardId: 'c1', linearIdentifier: 'BRO-1' } } };
  const remote = { conditions: { k: { status: 'open', lastSeen: '2026-10-13T00:00:00Z', cardId: null }, added: { status: 'open' } } };
  const { merged, stats } = merge(local, remote, base);
  assert.deepEqual(merged.conditions.k, local.conditions.k, 'our blended record must survive untouched');
  assert.ok(merged.conditions.added, 'remote-only addition restored');
  assert.equal(stats.restored, 1);
});

test('additions-only reconcile adds nothing without a readable base (cannot tell our delete from their add)', () => {
  const merge = additionsOnly(null);
  const local = { a: { lastBlockedAt: 1 } };
  const remote = { a: { lastBlockedAt: 1 }, gone: { lastBlockedAt: 2 } };
  assert.deepEqual(merge(local, remote, undefined).merged, local);
  assert.deepEqual(merge(local, remote, null).merged, local);
});

test('the incident replay: land.yml\'s ledger plus the reconcile keeps all 8 conditions it dropped', () => {
  const show = (rev) => { try { return JSON.parse(execFileSync('git', ['show', `${rev}:data/audit/alert-ledger.json`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return null; } };
  const local = show('de49618478c'); const remote = show('ea3aba1fe5d'); const base = show('ea3aba1fe5d^');
  if (!local || !remote || !base) return; // shallow CI checkout: history not available
  const tb = (d) => Object.keys(d.conditions).filter((k) => k.startsWith('time-bomb-tests:'));
  const { merged } = additionsOnly('conditions')(local, remote, base);
  for (const k of tb(remote)) assert.ok(k in merged.conditions, `${k} dropped`);
});
