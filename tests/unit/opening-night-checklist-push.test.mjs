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

// BRO-3071 (2026-09-14): audit/remediation-log.jsonl moved from
// MULTI_WRITER_OR_UNAUDITED_FILES into SINGLE_WRITER_FILES. BRO-2670's own
// comment on the "Commit shared audit telemetry" step said it was left there
// only because it was "not yet registered" — re-verified via
// findWritingWorkflows()-class check (manual grep for the loop-staged idiom
// too): opening-night-checklist.yml is the sole committer (same script,
// same concurrency group as the other two files here), so it moved to the
// "Commit opening night state (apiFallbackSafe)" step alongside them.
const SINGLE_WRITER_FILES = [
  'data/audit/opening-night-history.json',
  'data/audit/opening-night-sla-state.json',
  'data/audit/remediation-log.jsonl',
];
// alert-ledger.json/alert-digest-queue.json/alert-router-attempts.jsonl are
// deliberately NOT in this list as of BRO-2413: they're still genuinely
// multi-writer (MANAGED), but now also apiFallbackMerge-registered — a real
// merge fn makes them fast-path-safe without being apiFallbackSafe (see
// core-data-merge-registry.js's apiFallbackMergeEntriesFor() header). This
// test's OWN point (this workflow's step must not bundle a still-
// disqualifying file with the single-writer state above) still holds for
// the dated telemetry file kept below.
const MULTI_WRITER_OR_UNAUDITED_FILES = [
  'data/audit/opening-night-latency-2026-08-31.json',
];

test('registry: the 3 single-writer opening-night state files are registered apiFallbackSafe', () => {
  const entries = apiFallbackSafeEntriesFor('public-repo');
  for (const file of SINGLE_WRITER_FILES) {
    const registryFile = file.replace(/^data\//, '');
    const entry = entries.find((e) => e.file === registryFile);
    assert.ok(entry, `${registryFile} must be registered apiFallbackSafe`);
    assert.equal(typeof entry.concurrencyGroup, 'string', `${entry.file}: missing concurrencyGroup`);
    assert.ok(entry.concurrencyGroup.length > 0, `${entry.file}: empty concurrencyGroup`);
    assert.equal(typeof entry.verifiedBy, 'string', `${entry.file}: missing verifiedBy`);
  }
});

test('registry: the multi-writer/dated telemetry files are NOT claimed apiFallbackSafe', () => {
  const entries = apiFallbackSafeEntriesFor('public-repo');
  for (const file of ['audit/alert-ledger.json', 'audit/alert-digest-queue.json']) {
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

test('workflow: the apiFallbackSafe step stages ONLY the 3 single-writer files — no multi-writer file bundled back in', () => {
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
    'the apiFallbackSafe step must stage exactly opening-night-history.json + opening-night-sla-state.json + remediation-log.jsonl, nothing else'
  );

  for (const bad of ['alert-ledger.json', 'alert-digest-queue.json', 'stage-latency.jsonl', 'opening-night-latency']) {
    assert.ok(!stepBody.includes(bad), `apiFallbackSafe step must not reference multi-writer/dated file: ${bad}`);
  }
});

test('workflow: the sibling "Commit shared audit telemetry" step no longer stages remediation-log.jsonl (moved to the apiFallbackSafe step)', () => {
  const stepMatch = workflowText.match(/name:\s*Commit shared audit telemetry[\s\S]*?(?=\n {6}- name:|\n {4}- name:|$)/);
  assert.ok(stepMatch, 'could not locate the "Commit shared audit telemetry" step body');
  const gitAddLines = stepMatch[0].split('\n').filter((l) => /git add/.test(l));
  assert.ok(
    !gitAddLines.some((l) => l.includes('remediation-log.jsonl')),
    'remediation-log.jsonl must be git-added only in the apiFallbackSafe step, not duplicated here (comment mentions of the filename are fine)'
  );
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
  for (const file of SINGLE_WRITER_FILES) {
    const entry = entries.find((e) => e.file === file.replace(/^data\//, ''));
    assert.equal(group, entry?.concurrencyGroup, `the workflow's actual concurrency group must match what the ${file} registry entry claims — a drifted group here would silently invalidate the apiFallbackSafe registration`);
  }
});
