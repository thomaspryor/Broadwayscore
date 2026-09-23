import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { apiFallbackSafeEntriesFor } from '../../scripts/lib/core-data-merge-registry.js';
import { classifyPushFallbackSafety } from '../../scripts/lib/audit-push-retry-budgets.js';
import { checkEntry } from '../../scripts/lib/api-fallback-writer-drift.js';

// BRO-2722: "LLM Ensemble Score Reviews" repeat-failure alert. Root cause
// (run 34818414035, 2026-09-14): the workflow's "Commit and push changes"
// step exhausted all 5 push-with-retry.sh attempts under main-branch push
// contention, WITHOUT the Git Data API fallback (which exists specifically
// to survive that contention) ever engaging. The fallback disqualifies a
// commit if ANY staged data/audit/ path is neither apiFallbackSafe nor
// apiFallbackMerge — and data/audit/progress-watch-state.json (written by
// check-progress-stalls.js's "Snapshot progress-watch state" step on every
// scheduled run) was staged via the broad `data/audit/` directory glob in
// "Check for changes" but never registered, so it silently poisoned the
// fallback on every single scheduled run (the same BRO-2670-class bug
// tests/unit/opening-night-checklist-push.test.mjs documents for a
// different workflow).
//
// This test asserts the fix from three angles — the registry claim, the
// actual disqualifier predicate, and the real workflow YAML — so a future
// edit that re-widens the glob or drops the registration fails here even if
// it leaves the other two untouched.

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'llm-ensemble-score.yml');
const workflowText = fs.readFileSync(workflowPath, 'utf8');

const FILE = 'audit/progress-watch-state.json';

test('registry: progress-watch-state.json is registered apiFallbackSafe with required fields', () => {
  const entries = apiFallbackSafeEntriesFor('public-repo');
  const entry = entries.find((e) => e.file === FILE);
  assert.ok(entry, `${FILE} must be registered apiFallbackSafe`);
  assert.equal(typeof entry.concurrencyGroup, 'string', `${FILE}: missing concurrencyGroup`);
  assert.ok(entry.concurrencyGroup.length > 0, `${FILE}: empty concurrencyGroup`);
  assert.equal(typeof entry.verifiedBy, 'string', `${FILE}: missing verifiedBy`);
});

test('classifyPushFallbackSafety: progress-watch-state.json no longer disqualifies the Git Data API fallback', () => {
  const result = classifyPushFallbackSafety(`data/${FILE}`);
  assert.equal(result.isApiFallbackSafe, true, `data/${FILE}: expected isApiFallbackSafe`);
  assert.equal(result.disqualifiesFallback, false, `data/${FILE}: expected NOT disqualified`);
});

test('checkEntry: llm-ensemble-score.yml is the sole verifiable writer of progress-watch-state.json', () => {
  const wfDir = path.join(repoRoot, '.github', 'workflows');
  const workflowTexts = {};
  for (const f of fs.readdirSync(wfDir)) {
    if (!/\.ya?ml$/.test(f)) continue;
    workflowTexts[f] = fs.readFileSync(path.join(wfDir, f), 'utf8');
  }
  const entries = apiFallbackSafeEntriesFor('public-repo');
  const entry = entries.find((e) => e.file === FILE);
  assert.ok(entry, `${FILE} must be registered apiFallbackSafe`);

  const result = checkEntry(entry, workflowTexts);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.writers, ['llm-ensemble-score.yml']);
});

test('workflow: "Check for changes" explicitly stages progress-watch-state.json (not just the bare data/audit/ glob)', () => {
  const stepMatch = workflowText.match(/name:\s*Check for changes[\s\S]*?(?=\n {6}- name:|\n {4}- name:|$)/);
  assert.ok(stepMatch, 'could not locate the "Check for changes" step body');
  assert.match(
    stepMatch[0],
    /git-add-existing\.sh[^\n]*\bdata\/audit\/progress-watch-state\.json\b/,
    'the step must explicitly list data/audit/progress-watch-state.json on the git-add-existing.sh line — a bare data/audit/ directory glob is invisible to scripts/lib/api-fallback-writer-drift.js\'s static scanner and would silently un-register this file again'
  );
});

test('workflow: the scoring-reviews concurrency group is not run_id-templated (real serialization, not per-run)', () => {
  const m = /^concurrency:\s*\n(?:[^\n]*\n)*?\s*group:\s*([^\n#]+)/m.exec(workflowText);
  assert.ok(m, 'expected a workflow-level concurrency: block');
  const group = m[1].trim();
  assert.ok(!/run_id/.test(group), 'concurrency group must not be templated on github.run_id — scheduled runs (the only writer of progress-watch-state.json) must actually serialize against each other');
  assert.match(group, /^scoring-reviews/, 'expected the scoring-reviews base group (scheduled runs never set rescore_reason, so they always land in the unsuffixed group)');

  const concurrencyBlockMatch = /^concurrency:\s*\n((?:[^\n]*\n)*?)(?=\n?\S|\njobs:|$)/m.exec(workflowText);
  assert.ok(concurrencyBlockMatch, 'could not isolate the concurrency: block body');
  assert.match(
    concurrencyBlockMatch[1],
    /cancel-in-progress:\s*false/,
    'concurrency block must set cancel-in-progress: false — scheduled runs must queue, not cancel each other, for the single-writer claim to hold'
  );
});

test('workflow: the "Snapshot progress-watch state" step is scheduled-run-only (single writer claim depends on this)', () => {
  const stepMatch = workflowText.match(/name:\s*Snapshot progress-watch state[\s\S]*?(?=\n {6}- name:|\n {4}- name:|$)/);
  assert.ok(stepMatch, 'could not locate the "Snapshot progress-watch state" step body');
  assert.match(
    stepMatch[0],
    /if:\s*always\(\)\s*&&\s*github\.event_name\s*==\s*'schedule'/,
    'the step must remain gated on github.event_name == \'schedule\' — if it starts running on workflow_dispatch too, the registry\'s single-writer verifiedBy claim (which relies on scheduled runs always resolving to the bare "scoring-reviews" concurrency group) needs re-verification'
  );
});
