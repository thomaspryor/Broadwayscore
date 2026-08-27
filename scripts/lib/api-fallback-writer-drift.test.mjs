import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findWritingWorkflows, extractConcurrencyGroup, checkEntry } from './api-fallback-writer-drift.js';
import { CORE_DATA_MERGE_REGISTRY, apiFallbackSafeEntriesFor } from './core-data-merge-registry.js';

test('findWritingWorkflows matches an inline git add', () => {
  const workflows = {
    'foo.yml': 'run: |\n  git add data/audit/health-digest-snapshot.json 2>/dev/null || true\n',
    'bar.yml': 'run: |\n  git add data/audit/unrelated.json\n',
  };
  assert.deepEqual(findWritingWorkflows('data/audit/health-digest-snapshot.json', workflows), ['foo.yml']);
});

test('findWritingWorkflows matches the git-add-existing.sh helper shape', () => {
  const workflows = {
    'foo.yml': 'run: |\n  bash scripts/lib/git-add-existing.sh data/audit/a.jsonl data/audit/b.json\n',
  };
  assert.deepEqual(findWritingWorkflows('data/audit/b.json', workflows), ['foo.yml']);
});

test('findWritingWorkflows finds every distinct writer, order-independent of glob order', () => {
  const workflows = {
    'a.yml': 'git add data/audit/shared.json',
    'b.yml': 'git add data/audit/shared.json',
    'c.yml': 'git add data/audit/other.json',
  };
  assert.deepEqual(findWritingWorkflows('data/audit/shared.json', workflows), ['a.yml', 'b.yml']);
});

test('extractConcurrencyGroup reads a plain top-level group', () => {
  const yaml = 'name: X\nconcurrency:\n  group: data-health-check\n  cancel-in-progress: false\n';
  assert.equal(extractConcurrencyGroup(yaml), 'data-health-check');
});

test('extractConcurrencyGroup treats a run_id-templated group as no real protection', () => {
  const yaml = 'concurrency:\n  group: ${{ github.workflow }}-${{ github.run_id }}\n';
  assert.equal(extractConcurrencyGroup(yaml), null);
});

test('extractConcurrencyGroup returns null when absent', () => {
  assert.equal(extractConcurrencyGroup('name: X\non: push\n'), null);
});

test('checkEntry: single real writer is ok', () => {
  const entry = { file: 'audit/health-digest-snapshot.json', concurrencyGroup: 'data-health-check' };
  const workflows = { 'data-health-check.yml': 'git add data/audit/health-digest-snapshot.json' };
  const result = checkEntry(entry, workflows);
  assert.equal(result.ok, true);
  assert.deepEqual(result.writers, ['data-health-check.yml']);
});

test('checkEntry: zero writers found is a gap (path moved / dynamic write invisible to this check)', () => {
  const entry = { file: 'audit/nowhere.json', concurrencyGroup: 'x' };
  const result = checkEntry(entry, { 'a.yml': 'git add data/audit/something-else.json' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no writer found/);
});

test('checkEntry: two writers sharing the claimed concurrency group is NOT a gap (the grosses.json shape)', () => {
  // Synthetic fixture reproducing the real grosses.json precedent
  // (core-data-merge-registry.js: "both writers share concurrency group
  // data-grosses-writers — mutually exclusive, no real race") — proves the
  // detector does not repeat the naive "2+ writers = gap" mistake the
  // plan-review design reviewer flagged against exactly this shape.
  const entry = { file: 'audit/grosses-fixture.json', concurrencyGroup: 'data-grosses-writers' };
  const workflows = {
    'weekly-grosses.yml': 'concurrency:\n  group: data-grosses-writers\nrun: |\n  git add data/audit/grosses-fixture.json\n',
    'scrape-alltime-grosses.yml': 'concurrency:\n  group: data-grosses-writers\nrun: |\n  git add data/audit/grosses-fixture.json\n',
  };
  const result = checkEntry(entry, workflows);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.writers.length, 2);
});

test('checkEntry: two writers NOT sharing a concurrency group IS a gap', () => {
  // Reproduces the real alert-digest-queue.json mistake caught during this
  // task's own plan-review: two independent, unserialized writers.
  const entry = { file: 'audit/alert-digest-queue.json', concurrencyGroup: 'data-health-check' };
  const workflows = {
    'data-health-check.yml': 'concurrency:\n  group: data-health-check\nrun: |\n  git add data/audit/alert-digest-queue.json\n',
    'process-feedback.yml': 'concurrency:\n  group: process-feedback\nrun: |\n  git add data/audit/alert-digest-queue.json\n',
  };
  const result = checkEntry(entry, workflows);
  assert.equal(result.ok, false);
  assert.equal(result.writers.length, 2);
});

// ── Live-repo regression: every REAL registered entry still holds ──────────
test('REGRESSION: every real apiFallbackSafe(public-repo) registry entry still passes checkEntry against the actual .github/workflows/*.yml files', () => {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const wfDir = path.join(repoRoot, '.github', 'workflows');
  const workflowTexts = {};
  for (const f of fs.readdirSync(wfDir)) {
    if (!/\.ya?ml$/.test(f)) continue;
    workflowTexts[f] = fs.readFileSync(path.join(wfDir, f), 'utf8');
  }

  const entries = apiFallbackSafeEntriesFor('public-repo');
  assert.ok(entries.length > 0, 'expected at least one apiFallbackSafe(public-repo) entry to regression-test');
  for (const entry of entries) {
    const result = checkEntry(entry, workflowTexts);
    assert.equal(result.ok, true, `${entry.file}: drift detected — ${result.reason} (registered apiFallbackSafe:true but no longer verifiable as single-writer; re-verify by hand before trusting the fallback for this file)`);
  }
});

test('sanity: CORE_DATA_MERGE_REGISTRY has exactly the seeded apiFallbackSafe entries (1 original + 1 imageless-scored-shows.json + 14 bulk-step follow-up + 1 orphan-rescore-requeue-state.json (BRO-2435) — digest-history.json deliberately excluded, zero real writers), not an accidental duplicate or drop', () => {
  const publicSafe = CORE_DATA_MERGE_REGISTRY.filter((e) => e.surface === 'public-repo' && e.apiFallbackSafe === true);
  const files = publicSafe.map((e) => e.file).sort();
  assert.equal(publicSafe.length, 17);
  assert.deepEqual(files, [
    'audit/affiliate-health.json',
    'audit/cross-outlet-attribution-drift.json',
    'audit/cv-wrongproduction-lifetime.json',
    'audit/fulltext-mentions-show-lifetime.json',
    'audit/health-check-history.json',
    'audit/health-digest-snapshot.json',
    'audit/imageless-scored-shows.json',
    'audit/linear-archive-done.jsonl',
    'audit/orphan-rescore-requeue-state.json',
    'audit/provider-spend-daily.jsonl',
    'audit/provider-spend-snapshot.json',
    'audit/revival-unverified-lifetime.json',
    'audit/roundup-url-mismatch-lifetime.json',
    'audit/slug-mismatch-lifetime.json',
    'audit/time-to-publish-sla.json',
    'audit/trunk-status-snapshot.json',
    'audit/workflow-run-coverage.json',
  ]);
});
