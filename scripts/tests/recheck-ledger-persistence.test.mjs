/**
 * recheck-ledger-persistence.test.mjs — BRO-386 acceptance.
 *
 * Run 31871526977 (2026-08-15T07:19Z) evaluated 10+ RECHECK-AFTER cards
 * correctly, including the owner's 24h-green headline bar, then the "Commit
 * health check + triage data" step's push lost a rebase-conflict race — the
 * whole 16-file bulk commit failed to land, and every recheck verdict from
 * that run (data/audit/autonomous-recheck-ledger.jsonl) was silently
 * discarded with it, because the GitHub Actions runner filesystem is
 * ephemeral. The fix: commit+push the ledger in its OWN step, separate from
 * the bulk commit, plus an artifact-upload backstop.
 *
 * This reads the REAL .github/workflows/data-health-check.yml text (no
 * fixture, no restated logic — CLAUDE.md rule 15's spirit applied to a
 * workflow file instead of a scripts/lib/ function): a future edit that
 * re-merges the ledger back into the bulk commit, or reorders the steps,
 * fails this test.
 *
 * No YAML library (js-yaml is NOT installed in test.yml's lint-workflows
 * job — see scripts/audit-workflow-concurrency.js's header for the same
 * constraint). Parsing here is a small line-based step walker, written for
 * this file rather than importing audit-workflow-concurrency.js's helpers
 * (that script has no module.exports — it's a bare CLI that calls main() on
 * load).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_PATH = path.join(REPO, '.github', 'workflows', 'data-health-check.yml');
const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const lines = raw.split('\n');

const indentOf = (line) => line.length - line.replace(/^ +/, '').length;

// `steps:` entries in this file are `      - name: ...` (6-space indent).
// Returns [{ name, startLine, bodyText }], in file order.
function parseSteps(allLines) {
  const stepStarts = [];
  for (let i = 0; i < allLines.length; i++) {
    const m = allLines[i].match(/^ {6}- name:\s*(.+?)\s*$/);
    if (m) stepStarts.push({ name: m[1].replace(/^['"]|['"]$/g, ''), startLine: i });
  }
  return stepStarts.map((s, idx) => {
    const endLine = idx + 1 < stepStarts.length ? stepStarts[idx + 1].startLine : allLines.length;
    return { ...s, bodyText: allLines.slice(s.startLine, endLine).join('\n') };
  });
}

const steps = parseSteps(lines);

test('BRO-386: data-health-check.yml has a dedicated ledger-commit step', () => {
  const step = steps.find((s) => s.name === 'Commit acceptance recheck ledger');
  assert.ok(step, 'expected a step named "Commit acceptance recheck ledger"');
});

test('BRO-386: the ledger-commit step stages the ledger and pushes via push-with-retry.sh', () => {
  const step = steps.find((s) => s.name === 'Commit acceptance recheck ledger');
  assert.ok(step);
  assert.match(step.bodyText, /git add data\/audit\/autonomous-recheck-ledger\.jsonl/);
  assert.match(step.bodyText, /push-with-retry\.sh/);
});

test('BRO-386: the ledger-commit step stages ONLY the ledger file (no bulk audit files)', () => {
  const step = steps.find((s) => s.name === 'Commit acceptance recheck ledger');
  assert.ok(step);
  const gitAddLines = step.bodyText.split('\n').filter((l) => /git add data\//.test(l));
  assert.equal(gitAddLines.length, 1, `expected exactly 1 "git add data/..." line, got:\n${gitAddLines.join('\n')}`);
  assert.match(gitAddLines[0], /autonomous-recheck-ledger\.jsonl/);
});

test('BRO-386: the bulk "Commit health check + triage data" step no longer references the ledger', () => {
  const step = steps.find((s) => s.name === 'Commit health check + triage data');
  assert.ok(step, 'expected the pre-existing bulk commit step to still exist');
  assert.doesNotMatch(step.bodyText, /git add data\/audit\/autonomous-recheck-ledger\.jsonl/,
    'the ledger must be committed by its own dedicated step, not double-staged in the bulk commit');
});

test('BRO-386: the ledger-commit step runs BEFORE the bulk commit step', () => {
  const ledgerStep = steps.find((s) => s.name === 'Commit acceptance recheck ledger');
  const bulkStep = steps.find((s) => s.name === 'Commit health check + triage data');
  assert.ok(ledgerStep && bulkStep);
  assert.ok(ledgerStep.startLine < bulkStep.startLine,
    'the isolated ledger commit must land before the bulk commit — a bulk-commit push failure must not gate whether the ledger already landed');
});

test('BRO-386: the ledger-commit step runs AFTER the "Acceptance recheck" script step', () => {
  const scriptStep = steps.find((s) => s.name === 'Acceptance recheck (shadow mode)');
  const ledgerStep = steps.find((s) => s.name === 'Commit acceptance recheck ledger');
  assert.ok(scriptStep && ledgerStep);
  assert.ok(scriptStep.startLine < ledgerStep.startLine,
    'the ledger must be written by the recheck script before this step tries to commit it');
});

test('BRO-386: a workflow artifact upload backs up the ledger, independent of the commit outcome', () => {
  const step = steps.find((s) => /upload-artifact/.test(s.bodyText) && /autonomous-recheck-ledger\.jsonl/.test(s.bodyText));
  assert.ok(step, 'expected an actions/upload-artifact step whose path references the recheck ledger');
  assert.match(step.bodyText, /if-no-files-found:\s*ignore/,
    'a run where the ledger did not change should not fail the upload step');
});

test('BRO-386: the ledger-commit step degrades silently (continue-on-error), matching its shadow-mode siblings', () => {
  const step = steps.find((s) => s.name === 'Commit acceptance recheck ledger');
  assert.ok(step);
  assert.match(step.bodyText, /continue-on-error:\s*true/);
  assert.match(step.bodyText, /timeout-minutes:\s*\d+/);
});
