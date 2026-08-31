import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { apiFallbackSafeEntriesFor } from '../../scripts/lib/core-data-merge-registry.js';
import { classifyPushFallbackSafety } from '../../scripts/lib/audit-push-retry-budgets.js';

// BRO-2670: opening-night-checklist.yml's "Commit audit data" step bundled
// 3 single-writer opening-night state files with 4 genuinely multi-writer /
// MANAGED files into ONE commit. push-with-retry.sh's Git Data API fallback
// disqualifies a WHOLE commit if ANY changed data/audit/ path is neither
// MANAGED nor apiFallbackSafe — so the single-writer state (losing it causes
// the workflow's own documented "resets hourly, re-dispatches forever"
// failure mode) never got a shot at the fallback and was stuck on the slow
// local fetch+rebase+push race, which was failing 6 of 8 runs.
//
// This test asserts the fix from three independent angles: the registry
// claim, the actual disqualifier predicate, and the real workflow YAML —
// so a future edit that re-bundles the split commit fails here even if it
// leaves the registry untouched.

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'opening-night-checklist.yml');
const workflowText = fs.readFileSync(workflowPath, 'utf8');

const SINGLE_WRITER_FILES = ['data/audit/opening-night-history.json', 'data/audit/opening-night-sla-state.json'];
const MULTI_WRITER_OR_UNAUDITED_FILES = [
  'data/audit/alert-ledger.json',
  'data/audit/alert-digest-queue.json',
  'data/audit/remediation-log.jsonl',
  'data/audit/opening-night-latency-2026-08-31.json',
];

test('registry: the 2 single-writer opening-night state files are registered apiFallbackSafe', () => {
  const entries = apiFallbackSafeEntriesFor('public-repo');
  const historyEntry = entries.find((e) => e.file === 'audit/opening-night-history.json');
  const slaEntry = entries.find((e) => e.file === 'audit/opening-night-sla-state.json');

  assert.ok(historyEntry, 'audit/opening-night-history.json must be registered apiFallbackSafe');
  assert.ok(slaEntry, 'audit/opening-night-sla-state.json must be registered apiFallbackSafe');

  for (const entry of [historyEntry, slaEntry]) {
    assert.equal(typeof entry.concurrencyGroup, 'string', `${entry.file}: missing concurrencyGroup`);
    assert.ok(entry.concurrencyGroup.length > 0, `${entry.file}: empty concurrencyGroup`);
    assert.equal(typeof entry.verifiedBy, 'string', `${entry.file}: missing verifiedBy`);
  }
});

test('registry: the multi-writer telemetry files are NOT claimed apiFallbackSafe', () => {
  const entries = apiFallbackSafeEntriesFor('public-repo');
  for (const file of ['audit/alert-ledger.json', 'audit/alert-digest-queue.json', 'audit/remediation-log.jsonl']) {
    assert.ok(!entries.some((e) => e.file === file), `${file} must NOT be registered apiFallbackSafe — it is genuinely multi-writer`);
  }
});

test('classifyPushFallbackSafety: single-writer state files are not disqualified from the Git Data API fallback', () => {
  for (const file of SINGLE_WRITER_FILES) {
    const result = classifyPushFallbackSafety(file);
    assert.equal(result.isApiFallbackSafe, true, `${file}: expected isApiFallbackSafe`);
    assert.equal(result.disqualifiesFallback, false, `${file}: expected NOT disqualified`);
  }
});

test('classifyPushFallbackSafety: multi-writer / MANAGED / dated telemetry files stay disqualified', () => {
  for (const file of MULTI_WRITER_OR_UNAUDITED_FILES) {
    const result = classifyPushFallbackSafety(file);
    assert.equal(result.isApiFallbackSafe, false, `${file}: must never be claimed apiFallbackSafe`);
    assert.equal(result.disqualifiesFallback, true, `${file}: expected disqualified (multi-writer/MANAGED/unaudited)`);
  }
});

test('workflow: a dedicated apiFallbackSafe commit step exists', () => {
  assert.match(
    workflowText,
    /name:\s*Commit opening night state \(apiFallbackSafe\)/,
    'opening-night-checklist.yml must have a step named "Commit opening night state (apiFallbackSafe)" — if this step was removed or renamed, the isolation this fix relies on is gone'
  );
});

test('workflow: the apiFallbackSafe step stages ONLY the 2 single-writer files — no multi-writer file bundled back in', () => {
  const stepMatch = workflowText.match(/name:\s*Commit opening night state \(apiFallbackSafe\)[\s\S]*?(?=\n {6}- name:|\n {4}- name:|$)/);
  assert.ok(stepMatch, 'could not locate the "Commit opening night state (apiFallbackSafe)" step body');
  const stepBody = stepMatch[0];

  const gitAddLines = stepBody.split('\n').filter((l) => /git add/.test(l));
  assert.ok(gitAddLines.length > 0, 'apiFallbackSafe step has no git add lines');

  const stagedPaths = gitAddLines
    .map((l) => l.match(/git add\s+(\S+)/))
    .filter(Boolean)
    .map((m) => m[1]);

  assert.deepEqual(
    stagedPaths.sort(),
    [...SINGLE_WRITER_FILES].sort(),
    'the apiFallbackSafe step must stage exactly opening-night-history.json + opening-night-sla-state.json, nothing else'
  );

  for (const bad of ['alert-ledger.json', 'alert-digest-queue.json', 'remediation-log.jsonl', 'stage-latency.jsonl', 'opening-night-latency']) {
    assert.ok(!stepBody.includes(bad), `apiFallbackSafe step must not reference multi-writer/dated file: ${bad}`);
  }
});

test('workflow: this workflow declares a real (non-per-run), non-cancelling concurrency group', () => {
  const m = /^concurrency:\s*\n(?:[^\n]*\n)*?\s*group:\s*([^\n#]+)/m.exec(workflowText);
  assert.ok(m, 'expected a workflow-level concurrency: block (job-level is invisible to scripts/lib/api-fallback-writer-drift.js\'s extractConcurrencyGroup(), which apiFallbackSafe verification relies on)');
  const group = m[1].trim();
  assert.ok(!/run_id/.test(group), 'concurrency group must not be templated on github.run_id — that never serializes overlapping runs, which apiFallbackSafe requires');

  const concurrencyBlockMatch = /^concurrency:\s*\n((?:[^\n]*\n)*?)(?=\n?\S|\njobs:|$)/m.exec(workflowText);
  assert.ok(concurrencyBlockMatch, 'could not isolate the concurrency: block body');
  assert.match(
    concurrencyBlockMatch[1],
    /cancel-in-progress:\s*false/,
    'concurrency block must set cancel-in-progress: false — with the default (true), a fresher run would cancel an in-flight one mid-push, which is worse than the race this fix closes'
  );

  const entries = apiFallbackSafeEntriesFor('public-repo');
  const historyEntry = entries.find((e) => e.file === 'audit/opening-night-history.json');
  const slaEntry = entries.find((e) => e.file === 'audit/opening-night-sla-state.json');
  assert.equal(group, historyEntry?.concurrencyGroup, 'the workflow\'s actual concurrency group must match what the registry entry claims — a drifted group here would silently invalidate the apiFallbackSafe registration');
  assert.equal(group, slaEntry?.concurrencyGroup, 'the workflow\'s actual concurrency group must match what the registry entry claims — a drifted group here would silently invalidate the apiFallbackSafe registration');
});
