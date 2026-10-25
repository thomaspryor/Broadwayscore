/**
 * Task #1581: test.yml runs on main were routinely cancelled before
 * validating because the concurrency group collapsed every main commit into
 * one bucket with cancel-in-progress: true (memory/feedback_test_yml_cancel_
 * in_progress.md). The fix (per-sha concurrency group + conditional cancel)
 * already landed in .github/workflows/test.yml; this test pins the decision
 * logic that guards against it regressing (scripts/lib/ci-cancellation-
 * guard.js, used by scripts/audit-workflow-concurrency.js in CI).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { triggersOnMainPush, readConcurrency, findConcurrencyViolation, PER_RUN_TOKENS, ANNOTATION } = require(
  '../../scripts/lib/ci-cancellation-guard.js'
);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function workflow({ trigger = "push:\n    branches: [main]", concurrency = '' } = {}) {
  return `name: Example\non:\n  ${trigger}\n${concurrency ? concurrency + '\n' : ''}jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`;
}

test('triggersOnMainPush: true for push branches: [main]', () => {
  assert.equal(triggersOnMainPush(workflow()), true);
});

test('triggersOnMainPush: true for push branches list form including main', () => {
  const raw = workflow({ trigger: "push:\n    branches:\n      - main\n      - release" });
  assert.equal(triggersOnMainPush(raw), true);
});

test('triggersOnMainPush: false when main is not in the branches list', () => {
  const raw = workflow({ trigger: "push:\n    branches: [develop]" });
  assert.equal(triggersOnMainPush(raw), false);
});

test('triggersOnMainPush: false when there is no push trigger at all', () => {
  const raw = workflow({ trigger: 'workflow_dispatch: {}' });
  assert.equal(triggersOnMainPush(raw), false);
});

test('readConcurrency: extracts group and cancel-in-progress', () => {
  const raw = workflow({
    concurrency: "concurrency:\n  group: my-workflow-${{ github.ref }}\n  cancel-in-progress: true",
  });
  const c = readConcurrency(raw);
  assert.equal(c.group, 'my-workflow-${{ github.ref }}');
  assert.equal(c.cancelRaw, 'true');
});

test('readConcurrency: returns null when there is no concurrency block', () => {
  assert.equal(readConcurrency(workflow()), null);
});

test('findConcurrencyViolation: flags shared main group + cancel-in-progress: true (the historical test.yml bug)', () => {
  const raw = workflow({
    concurrency: "concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true",
  });
  const violation = findConcurrencyViolation(raw);
  assert.ok(violation, 'expected a violation for a shared main group with cancel-in-progress: true');
  assert.equal(violation.group, '${{ github.workflow }}-${{ github.ref }}');
});

test('findConcurrencyViolation: cancel-in-progress: false is safe even with a shared group', () => {
  const raw = workflow({
    concurrency: "concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: false",
  });
  assert.equal(findConcurrencyViolation(raw), null);
});

test('findConcurrencyViolation: a conditional cancel-in-progress expression is safe (the shipped fix)', () => {
  const raw = workflow({
    concurrency:
      "concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}",
  });
  assert.equal(findConcurrencyViolation(raw), null);
});

test('findConcurrencyViolation: a per-run group (github.sha) is exempt even with cancel-in-progress: true', () => {
  for (const token of PER_RUN_TOKENS) {
    const raw = workflow({
      concurrency: `concurrency:\n  group: my-workflow-\${{ ${token} }}\n  cancel-in-progress: true`,
    });
    assert.equal(findConcurrencyViolation(raw), null, `expected ${token} group to be exempt`);
  }
});

test('findConcurrencyViolation: an explicit annotation opts out', () => {
  const raw = workflow({
    concurrency: `concurrency:\n  group: \${{ github.workflow }}-\${{ github.ref }}\n  cancel-in-progress: true  # ${ANNOTATION}: idempotent ping, latest-wins is correct`,
  });
  assert.equal(findConcurrencyViolation(raw), null);
});

test('findConcurrencyViolation: no violation when the workflow does not trigger on push to main', () => {
  const raw = workflow({
    trigger: 'workflow_dispatch: {}',
    concurrency: "concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true",
  });
  assert.equal(findConcurrencyViolation(raw), null);
});

test('findConcurrencyViolation: no violation when there is no concurrency block at all', () => {
  assert.equal(findConcurrencyViolation(workflow()), null);
});

// Regression pin (task #1581 acceptance criterion): the real test.yml on disk
// must never regress into the collapsing-group + cancel-in-progress: true
// shape that made ~75% of main runs cancel before validating.
test('regression: .github/workflows/test.yml itself has no concurrency violation', () => {
  const raw = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
  assert.equal(triggersOnMainPush(raw), true, 'test.yml should still trigger on push to main');
  assert.equal(findConcurrencyViolation(raw), null);
});

// Stronger pin: main's group must include a per-commit token (github.sha),
// not just a non-true cancel-in-progress — cancel-in-progress: false alone
// does not stop GitHub from cancelling a PENDING run when a newer push queues
// behind it (the 2026-07-12 pending-supersession follow-up in
// memory/feedback_test_yml_cancel_in_progress.md).
test('regression: test.yml concurrency group is keyed per-commit on main', () => {
  const raw = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
  const c = readConcurrency(raw);
  assert.ok(c, 'test.yml should have a concurrency block');
  assert.ok(
    c.group.includes('github.sha'),
    `expected test.yml's concurrency group to include github.sha for a per-commit main group, got: ${c.group}`
  );
});

// Every audited-repo workflow that pushes to main should also be clean —
// catches new workflows introduced with the same bug shape.
test('regression: no workflow in .github/workflows/ has a concurrency violation', () => {
  const dir = path.join(REPO_ROOT, '.github', 'workflows');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const violations = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    const v = findConcurrencyViolation(raw);
    if (v) violations.push(`${file} (group: ${v.group || '<none>'})`);
  }
  assert.deepEqual(violations, []);
});
