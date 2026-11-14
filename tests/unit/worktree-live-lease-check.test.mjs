/**
 * BRO-2319 adversarial review finding: the first cut of hasLiveLease() read
 * an unreadable/corrupt lease the SAME way as no-lease-at-all — "not live",
 * i.e. safe to remove — the opposite fail direction from every other
 * liveness guard in this codebase (gc-worktree-liveness.js's lsof check
 * returns "live" on ANY error). A torn read of an in-flight non-atomic
 * lease write (bsc-runner.js's acquireLease/updateLease are plain
 * writeFileSync, not atomic) is exactly the moment a lease IS live.
 *
 * Uses real temp directories/files (not mocked fs) so the actual read paths
 * — readdirSync, readFileSync, JSON.parse — are exercised, per CLAUDE.md
 * rule 15's require()-the-real-thing intent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hasLiveLease, readLeases } from '../../scripts/lib/worktree-live-lease-check.js';

function mkTmpLeaseRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lease-root-'));
}

test('readLeases: a missing lease-root directory is NOT unreadable (no jobs have ever run)', () => {
  const { leases, unreadable } = readLeases(path.join(os.tmpdir(), 'definitely-does-not-exist-' + Date.now()));
  assert.deepEqual(leases, []);
  assert.equal(unreadable, false);
});

test('readLeases: a well-formed lease is read correctly', () => {
  const root = mkTmpLeaseRoot();
  fs.mkdirSync(path.join(root, 'task-a'));
  fs.writeFileSync(path.join(root, 'task-a', 'lease.json'), JSON.stringify({ cwd: '/wt/a', pid: 123 }));
  const { leases, unreadable } = readLeases(root);
  assert.equal(unreadable, false);
  assert.deepEqual(leases, [{ cwd: '/wt/a', pid: 123 }]);
});

test('readLeases: a lease directory that raced away (ENOENT on lease.json) is skipped, not unreadable', () => {
  // Simulates releaseLease()'s recursive rmSync running between the
  // directory listing and the file read — a benign, expected race.
  const root = mkTmpLeaseRoot();
  fs.mkdirSync(path.join(root, 'task-gone'));
  // lease.json deliberately never written.
  const { leases, unreadable } = readLeases(root);
  assert.deepEqual(leases, []);
  assert.equal(unreadable, false);
});

test('readLeases: a corrupt lease.json (torn read of an in-flight write) is unreadable — fail safe', () => {
  const root = mkTmpLeaseRoot();
  fs.mkdirSync(path.join(root, 'task-torn'));
  fs.writeFileSync(path.join(root, 'task-torn', 'lease.json'), '{"cwd": "/wt/torn", "pi'); // truncated JSON
  const { unreadable } = readLeases(root);
  assert.equal(unreadable, true);
});

test('hasLiveLease: an unreadable lease store fails SAFE (treated as live) for any worktree path queried', () => {
  const root = mkTmpLeaseRoot();
  fs.mkdirSync(path.join(root, 'task-torn'));
  fs.writeFileSync(path.join(root, 'task-torn', 'lease.json'), 'not json at all');
  const live = hasLiveLease('/some/unrelated/worktree/path', { leaseRoot: root, isAliveFn: () => true });
  assert.equal(live, true);
});

test('hasLiveLease: a clean, readable, empty lease store is NOT live', () => {
  const root = mkTmpLeaseRoot();
  const live = hasLiveLease('/some/worktree/path', { leaseRoot: root, isAliveFn: () => true });
  assert.equal(live, false);
});

test('hasLiveLease: matches a live lease by resolved cwd', () => {
  const root = mkTmpLeaseRoot();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  fs.mkdirSync(path.join(root, 'task-live'));
  fs.writeFileSync(path.join(root, 'task-live', 'lease.json'), JSON.stringify({ cwd: wt, pid: 999 }));
  assert.equal(hasLiveLease(wt, { leaseRoot: root, isAliveFn: (pid) => pid === 999 }), true);
  assert.equal(hasLiveLease(wt, { leaseRoot: root, isAliveFn: () => false }), false);
});
