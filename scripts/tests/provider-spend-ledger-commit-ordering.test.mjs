/**
 * provider-spend-ledger-commit-ordering.test.mjs — BRO-3317 acceptance.
 *
 * data/audit/provider-spend-daily.jsonl (+ provider-spend-snapshot.json +
 * scraper-spend-daily-agg.jsonl) sat frozen at 2026-09-04 for 11 days. Root
 * cause, confirmed via live run 34857395085 (2026-09-14): "Provider spend
 * reconciliation" writes these files uncommitted; "Commit acceptance
 * recheck ledger" (which runs next) calls push-with-retry.sh, and that
 * script's last-resort fallback (rebase AND merge both fail) does
 * `git reset --hard origin/main`, silently discarding the still-uncommitted
 * write before any later step gets a chance to commit it. The fix: a
 * dedicated commit step landing IMMEDIATELY after the write, before any
 * other step in the job can trigger that fallback.
 *
 * Same line-based step walker as scripts/tests/recheck-ledger-persistence.test.mjs
 * (BRO-386, the near-identical prior fix for this same job) — reads the REAL
 * .github/workflows/data-health-check.yml text, no fixture, no restated
 * logic (CLAUDE.md rule 15's spirit applied to a workflow file). A future
 * edit that re-merges these files into a later bulk commit, or reorders the
 * steps so another commit checkpoint sits between the write and this step,
 * fails this test.
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

// `steps:` entries in this file are `      - name: ...` (6-space indent).
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
const STEP_NAME = 'Commit provider spend ledger (apiFallbackSafe)';
const LEDGER_FILES = [
  'data/audit/provider-spend-daily.jsonl',
  'data/audit/provider-spend-snapshot.json',
  'data/audit/scraper-spend-daily-agg.jsonl',
];

test('BRO-3317: data-health-check.yml has a dedicated provider-spend ledger commit step', () => {
  const step = steps.find((s) => s.name === STEP_NAME);
  assert.ok(step, `expected a step named "${STEP_NAME}"`);
});

test('BRO-3317: the ledger-commit step stages all 3 provider-spend files and pushes via push-with-retry.sh', () => {
  const step = steps.find((s) => s.name === STEP_NAME);
  assert.ok(step);
  for (const file of LEDGER_FILES) {
    assert.match(step.bodyText, new RegExp(`git add ${file.replace(/\./g, '\\.')}`),
      `expected the step to stage ${file}`);
  }
  assert.match(step.bodyText, /push-with-retry\.sh/);
});

test('BRO-3317: the ledger-commit step runs directly after "Provider spend reconciliation", before any other step', () => {
  const writeStep = steps.find((s) => s.name === 'Provider spend reconciliation');
  const commitStep = steps.find((s) => s.name === STEP_NAME);
  assert.ok(writeStep && commitStep);
  const writeIdx = steps.indexOf(writeStep);
  const commitIdx = steps.indexOf(commitStep);
  assert.equal(commitIdx, writeIdx + 1,
    'the commit must be the VERY NEXT step after the write — any intervening step ' +
    'that calls push-with-retry.sh (directly or via its own commit) can trigger the ' +
    'hard-reset fallback that caused this bug, so nothing may sit between them');
});

test('BRO-3317: no later commit step in this job still stages the provider-spend files (no double-staging drift)', () => {
  const commitStep = steps.find((s) => s.name === STEP_NAME);
  assert.ok(commitStep);
  const commitIdx = steps.indexOf(commitStep);
  const laterSteps = steps.slice(commitIdx + 1);
  for (const file of LEDGER_FILES) {
    const offenders = laterSteps.filter((s) => new RegExp(`git add ${file.replace(/\./g, '\\.')}`).test(s.bodyText));
    assert.equal(offenders.length, 0,
      `${file} must only be staged by "${STEP_NAME}" — found it also staged in: ${offenders.map((s) => s.name).join(', ')}`);
  }
});

test('BRO-3317: the ledger-commit step runs with if: always() (upstream reconciliation step uses continue-on-error)', () => {
  const step = steps.find((s) => s.name === STEP_NAME);
  assert.ok(step);
  assert.match(step.bodyText, /if:\s*always\(\)/,
    'every sibling apiFallbackSafe/apiFallbackMerge commit step in this job runs unconditionally — a crash in the write step must not skip committing whatever DID get written');
});
