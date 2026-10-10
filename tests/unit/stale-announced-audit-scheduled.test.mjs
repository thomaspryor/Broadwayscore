import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { apiFallbackSafeEntriesFor } from '../../scripts/lib/core-data-merge-registry.js';
import { classifyPushFallbackSafety } from '../../scripts/lib/audit-push-retry-budgets.js';

// BRO-2620: scripts/audit-stale-announced-shows.js (BRO-93) flags shows stuck
// in status='announced' after their run has demonstrably already started or
// finished — the one signal that catches a show showing the wrong status and
// no score on the live site. Nothing ran it in CI: it appeared in test.yml
// only as a push-path trigger for its own unit test, and that Unit Tests job
// has no data/review-texts checkout, so even that test's review-texts signal
// was vacuous there. Nothing read its output either — 24 true positives went
// unalerted (measured 2026-08-31). This asserts the wiring from four
// independent angles — the registry claim, the disqualifier predicate, the
// actual scheduled step, and the commit step's staged paths — so a future
// edit that drops any one of them fails here even if the others still look
// fine, matching tests/unit/opening-night-checklist-push.test.mjs's shape for
// the same class of fix.

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'data-health-check.yml');
const workflowText = fs.readFileSync(workflowPath, 'utf8');
const healthCheckPath = path.join(repoRoot, 'scripts', 'health-check.js');
const healthCheckText = fs.readFileSync(healthCheckPath, 'utf8');

const SNAPSHOT_FILE = 'data/audit/stale-announced-shows.json';

test('registry: stale-announced-shows.json is registered apiFallbackSafe', () => {
  const entries = apiFallbackSafeEntriesFor('public-repo');
  const entry = entries.find((e) => e.file === 'audit/stale-announced-shows.json');
  assert.ok(entry, 'audit/stale-announced-shows.json must be registered apiFallbackSafe');
  assert.equal(typeof entry.concurrencyGroup, 'string', 'missing concurrencyGroup');
  assert.ok(entry.concurrencyGroup.length > 0, 'empty concurrencyGroup');
  assert.equal(typeof entry.verifiedBy, 'string', 'missing verifiedBy');
});

test('classifyPushFallbackSafety: stale-announced-shows.json is not disqualified from the Git Data API fallback', () => {
  const result = classifyPushFallbackSafety(SNAPSHOT_FILE);
  assert.equal(result.isApiFallbackSafe, true, `${SNAPSHOT_FILE}: expected isApiFallbackSafe`);
  assert.equal(result.disqualifiesFallback, false, `${SNAPSHOT_FILE}: expected NOT disqualified`);
});

test('workflow: a scheduled step runs audit-stale-announced-shows.js', () => {
  assert.match(
    workflowText,
    /name:\s*Stale announced shows audit \(shadow mode\)[\s\S]{0,300}?run:\s*node scripts\/audit-stale-announced-shows\.js/,
    'data-health-check.yml must have a "Stale announced shows audit (shadow mode)" step that actually runs the script — a step whose name matches but whose run: line drifted (or vice versa) must fail here'
  );
});

test('workflow: that step is shadow-mode (never fails the job)', () => {
  const stepMatch = workflowText.match(/- name:\s*Stale announced shows audit \(shadow mode\)[\s\S]*?(?=\n {6}- name:|\n {4}- name:|$)/);
  assert.ok(stepMatch, 'could not locate the "Stale announced shows audit (shadow mode)" step body');
  assert.match(stepMatch[0], /continue-on-error:\s*true/, 'step must be continue-on-error: true — a real true positive must never redden main');
  assert.match(stepMatch[0], /if:\s*always\(\)/, 'step must run even if an earlier step in the job failed');
});

test('workflow: the apiFallbackSafe commit step stages data/audit/stale-announced-shows.json', () => {
  const stepMatch = workflowText.match(/name:\s*Commit health check audit snapshots \(apiFallbackSafe\)[\s\S]*?(?=\n {6}- name:|\n {4}- name:|$)/);
  assert.ok(stepMatch, 'could not locate the "Commit health check audit snapshots (apiFallbackSafe)" step body');
  assert.match(
    stepMatch[0],
    /git add data\/audit\/stale-announced-shows\.json/,
    'the apiFallbackSafe commit step must git-add data/audit/stale-announced-shows.json, or the audit\'s findings never reach the repo other jobs/scripts read'
  );
});

test('workflow: this job\'s concurrency group matches what the registry entry claims', () => {
  const m = /^concurrency:\s*\n(?:[^\n]*\n)*?\s*group:\s*([^\n#]+)/m.exec(workflowText);
  assert.ok(m, 'expected a workflow-level concurrency: block');
  const group = m[1].trim();

  const entries = apiFallbackSafeEntriesFor('public-repo');
  const entry = entries.find((e) => e.file === 'audit/stale-announced-shows.json');
  assert.equal(group, entry?.concurrencyGroup, "the workflow's actual concurrency group must match what the registry entry claims — a drifted group here would silently invalidate the apiFallbackSafe registration");
});

test('consumer: scripts/health-check.js reads the snapshot and surfaces flaggedCount', () => {
  assert.match(healthCheckText, /stale-announced-shows\.json/, 'health-check.js must reference the snapshot file');
  assert.match(healthCheckText, /snap\.flaggedCount/, 'health-check.js must surface flaggedCount from the snapshot, not just check it exists');
  assert.match(healthCheckText, /silencedByContaminationCount/, "health-check.js must also surface silencedByContaminationCount — BRO-2611's contamination discount stays invisible otherwise");
});
