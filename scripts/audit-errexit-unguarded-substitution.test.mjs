import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  splitIntoSteps,
  findUnguardedAssignments,
  findUnguardedAmends,
  checkActionFile,
} = require('./audit-errexit-unguarded-substitution.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Regression fixture reproducing the actual #676 shape: an unguarded
// `DECISION=$(... node -e "...")` inside a `shell: bash` step.
const UNGUARDED_DECISION_STEP = `
    - name: Push with retry
      shell: bash
      run: |
        for i in 1 2 3; do
          DECISION=$(STDERR_FILE="$STDERR_FILE" node -e "
            const r = shouldRetry();
            console.log(r.retry ? 'retry' : 'stop');
          ")
          case "$DECISION" in
            retry) sleep 1 ;;
          esac
        done
`;

const GUARDED_DECISION_STEP = `
    - name: Push with retry
      shell: bash
      run: |
        for i in 1 2 3; do
          DECISION=$(STDERR_FILE="$STDERR_FILE" node -e "
            const r = shouldRetry();
            console.log(r.retry ? 'retry' : 'stop');
          ") || DECISION="stop:decision-error"
        done
`;

test('findUnguardedAssignments: flags an unguarded multi-line node -e DECISION= assignment (#676 shape)', () => {
  const steps = splitIntoSteps(UNGUARDED_DECISION_STEP);
  assert.equal(steps.length, 1);
  const hits = findUnguardedAssignments(steps[0]);
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /^DECISION=\$\(/);
});

test('findUnguardedAssignments: does not flag the same assignment once guarded with || fallback', () => {
  const steps = splitIntoSteps(GUARDED_DECISION_STEP);
  const hits = findUnguardedAssignments(steps[0]);
  assert.equal(hits.length, 0);
});

test('findUnguardedAssignments: does not flag non-node substitutions (mktemp/date/git diff --stat)', () => {
  const step = `
    - name: Housekeeping
      shell: bash
      run: |
        STDERR_FILE=$(mktemp)
        START=$(date +%s)
        ELAPSED=$(($(date +%s) - START))
        CHANGED=$(git diff --staged --stat | tail -1)
`;
  const steps = splitIntoSteps(step);
  const hits = findUnguardedAssignments(steps[0]);
  assert.equal(hits.length, 0);
});

test('findUnguardedAssignments: does not flag a node substitution already guarded internally (|| echo fallback)', () => {
  const step = `
    - name: Read value
      shell: bash
      run: |
        VALUE=$(node -e "console.log(1)" 2>/dev/null || echo "0")
`;
  const steps = splitIntoSteps(step);
  const hits = findUnguardedAssignments(steps[0]);
  assert.equal(hits.length, 0);
});

test('findUnguardedAssignments: flags an unguarded node script piped through tail (pipefail-propagated failure)', () => {
  const step = `
    - name: Restore fields
      shell: bash
      run: |
        RESTORED=$(node ../../scripts/lib/restore-protected-fields.js "origin/main" 2>&1 | tail -1)
`;
  const steps = splitIntoSteps(step);
  const hits = findUnguardedAssignments(steps[0]);
  assert.equal(hits.length, 1);
});

test('findUnguardedAmends: flags a bare git commit --amend --no-edit', () => {
  const step = `
    - name: Amend
      shell: bash
      run: |
        git commit --amend --no-edit
`;
  const steps = splitIntoSteps(step);
  const hits = findUnguardedAmends(steps[0]);
  assert.equal(hits.length, 1);
});

test('findUnguardedAmends: does not flag an amend guarded with || true', () => {
  const step = `
    - name: Amend
      shell: bash
      run: |
        git commit --amend --no-edit 2>/dev/null || true
`;
  const steps = splitIntoSteps(step);
  const hits = findUnguardedAmends(steps[0]);
  assert.equal(hits.length, 0);
});

test('findUnguardedAmends: does not flag an amend using --allow-empty', () => {
  const step = `
    - name: Amend
      shell: bash
      run: |
        git commit --amend --no-edit --allow-empty
`;
  const steps = splitIntoSteps(step);
  const hits = findUnguardedAmends(steps[0]);
  assert.equal(hits.length, 0);
});

test('checkActionFile: skips a step with no explicit shell: bash', () => {
  const raw = `
runs:
  using: composite
  steps:
    - name: Some step
      run: |
        DECISION=$(node -e "throw 1")
`;
  assert.equal(checkActionFile('fixture.yml', raw), null);
});

test('checkActionFile: skips a step with continue-on-error: true', () => {
  const raw = `
runs:
  using: composite
  steps:
    - name: Best-effort
      shell: bash
      continue-on-error: true
      run: |
        DECISION=$(node -e "throw 1")
`;
  assert.equal(checkActionFile('fixture.yml', raw), null);
});

test('checkActionFile: respects the hygiene-errexit-guard-ok exemption marker', () => {
  const raw = `
# hygiene-errexit-guard-ok: reviewed, intentional
runs:
  using: composite
  steps:
    - name: Some step
      shell: bash
      run: |
        DECISION=$(node -e "throw 1")
`;
  assert.equal(checkActionFile('fixture.yml', raw), null);
});

test('checkActionFile: real repo file push-core-data/action.yml is clean (already fixed in #676)', () => {
  const raw = require('fs').readFileSync(
    require('path').join(__dirname, '..', '.github', 'actions', 'push-core-data', 'action.yml'),
    'utf8',
  );
  assert.equal(checkActionFile('.github/actions/push-core-data/action.yml', raw), null);
});

test('checkActionFile: real repo file push-review-texts/action.yml is clean (fixed in #678 + this task)', () => {
  const raw = require('fs').readFileSync(
    require('path').join(__dirname, '..', '.github', 'actions', 'push-review-texts', 'action.yml'),
    'utf8',
  );
  assert.equal(checkActionFile('.github/actions/push-review-texts/action.yml', raw), null);
});
