import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifyForSignature, findStepRunCommandInWorkflow, jobExistsInWorkflow, JOB_PROXY_COMMANDS } = require('./red-signature-verify-cmd.js');
const { explainUnsafeCheckCommand } = require('./autonomous-triage-core.js');

// Small, self-contained fixture with the same shape as .github/workflows/
// test.yml (job -> name: -> steps: -> - name:/run:) — deliberately NOT the
// real 6000-line file, so these tests don't churn every time an unrelated
// step gets added/reworded there. The real-file smoke test at the bottom
// covers the "does this still parse the actual workflow" question.
const FIXTURE_YML = `
name: Test Suite
on:
  push:
    branches: [main]

jobs:
  lint-workflows:
    name: Lint Workflows
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v5
      - name: Audit — no push-to-main workflow cancels main commits
        run: node scripts/audit-workflow-concurrency.js
      - name: Audit cast-changes.json
        run: node scripts/audit-cast-changes.js --gate
      - name: Audit — quoted run value (double)
        run: "node scripts/audit-workflow-concurrency.js"
      - name: Audit — quoted run value (single)
        run: 'node scripts/audit-workflow-concurrency.js'
      - name: Lint workflow files
        run: |
          echo "::group::actionlint"
          actionlint
          echo "::endgroup::"

  unit-tests:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v5
      - name: Temporal override regression (BRO-2835)
        run: node scripts/test-temporal-override-regression.js
      - name: Run unit tests (no-data-dependency)
        run: |
          mapfile -t node_tests < <(node scripts/lib/unit-test-collection.js)
          run_batch node /tmp/unit-node-batch.log node --test "\${node_tests[@]}"

  data-validation:
    name: Data Validation
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v5
      - name: Run data validation
        run: node scripts/validate-data.js
`;

// ── the three job-level proxy commands must themselves always be safe-form ──
// If SAFE_CHECK_FORMS ever drifts and stops admitting one of these, every
// card in that job silently degrades to owner-judgment instead of a real
// re-verification command — this must fail loudly in CI instead.
test('every JOB_PROXY_COMMANDS entry passes explainUnsafeCheckCommand', () => {
  for (const [job, cmd] of Object.entries(JOB_PROXY_COMMANDS)) {
    assert.equal(explainUnsafeCheckCommand(cmd).ok, true, `${job}'s proxy "${cmd}" must be safe-form`);
  }
});

// ── 3 signatures -> 3 correct VERIFY lines (direct step-command hits) ───────

test('resolves a Lint Workflows signature to its own safe-form step command', () => {
  const v = verifyForSignature({ job: 'Lint Workflows', step: 'Audit — no push-to-main workflow cancels main commits' }, FIXTURE_YML);
  assert.equal(v.line, 'VERIFY: node scripts/audit-workflow-concurrency.js');
  assert.equal(v.note, null);
});

test('resolves a Unit Tests signature to its own safe-form step command', () => {
  const v = verifyForSignature({ job: 'Unit Tests', step: 'Temporal override regression (BRO-2835)' }, FIXTURE_YML);
  assert.equal(v.line, 'VERIFY: node scripts/test-temporal-override-regression.js');
  assert.equal(v.note, null);
});

test('resolves a Data Validation signature to its own safe-form step command', () => {
  const v = verifyForSignature({ job: 'Data Validation', step: 'Run data validation' }, FIXTURE_YML);
  assert.equal(v.line, 'VERIFY: node scripts/validate-data.js');
  assert.equal(v.note, null);
});

test('a double-quoted run: value strips the quotes before safe-form validation', () => {
  const v = verifyForSignature({ job: 'Lint Workflows', step: 'Audit — quoted run value (double)' }, FIXTURE_YML);
  assert.equal(v.line, 'VERIFY: node scripts/audit-workflow-concurrency.js');
  assert.equal(v.note, null);
});

test('a single-quoted run: value strips the quotes before safe-form validation', () => {
  const v = verifyForSignature({ job: 'Lint Workflows', step: 'Audit — quoted run value (single)' }, FIXTURE_YML);
  assert.equal(v.line, 'VERIFY: node scripts/audit-workflow-concurrency.js');
  assert.equal(v.note, null);
});

// ── unknown/unresolvable step -> job-level proxy ────────────────────────────

test('a step name not present in the job falls back to the job-level proxy', () => {
  const v = verifyForSignature({ job: 'Lint Workflows', step: 'Some Renamed Step' }, FIXTURE_YML);
  assert.equal(v.line, 'VERIFY: node scripts/audit-workflow-concurrency.js');
  assert.match(v.note, /job-level proxy/i);
  assert.match(v.note, /Some Renamed Step/);
});

test('a step whose run: is a multi-line block (no single command) falls back to the job-level proxy', () => {
  const v = verifyForSignature({ job: 'Unit Tests', step: 'Run unit tests (no-data-dependency)' }, FIXTURE_YML);
  assert.equal(v.line, 'VERIFY: node scripts/run-unit-tests.js');
  assert.match(v.note, /job-level proxy/i);
});

test('actionlint\'s multi-line run: block in an unregistered job falls back the same way', () => {
  // "Lint workflow files" exists as a step but its run: is a `|` block —
  // same treatment as "step not found": job-level proxy.
  const v = verifyForSignature({ job: 'Lint Workflows', step: 'Lint workflow files' }, FIXTURE_YML);
  assert.equal(v.line, 'VERIFY: node scripts/audit-workflow-concurrency.js');
  assert.match(v.note, /job-level proxy/i);
});

// ── unsafe command -> omitted, VERIFY: owner-judgment + a note ──────────────

test('a resolved step command that fails safe-form validation is NOT armed — owner-judgment with a note instead', () => {
  const v = verifyForSignature({ job: 'Lint Workflows', step: 'Audit cast-changes.json' }, FIXTURE_YML);
  assert.equal(v.line, 'VERIFY: owner-judgment');
  assert.match(v.note, /not on the safe-form allowlist/i);
  assert.match(v.note, /audit-cast-changes\.js --gate/);
});

test('an unknown job with no registered proxy and no resolvable step is owner-judgment with a note', () => {
  const v = verifyForSignature({ job: 'Some Future Job', step: 'Some Step' }, FIXTURE_YML);
  assert.equal(v.line, 'VERIFY: owner-judgment');
  assert.match(v.note, /no job-level.*proxy/i);
});

test('empty/unreadable workflow text degrades to owner-judgment (never throws)', () => {
  const v = verifyForSignature({ job: 'Data Validation', step: 'Run data validation' }, '');
  // No job/step can be found in empty text, but Data Validation DOES have a
  // registered proxy, so it still arms rather than falling all the way to
  // owner-judgment.
  assert.equal(v.line, 'VERIFY: node scripts/validate-data.js');
});

// ── real file smoke test ────────────────────────────────────────────────────

test('every JOB_PROXY_COMMANDS key is a real job name in the REAL test.yml (a rename must not silently orphan the proxy)', () => {
  const dirname = path.dirname(new URL(import.meta.url).pathname);
  const realYml = fs.readFileSync(path.join(dirname, '..', '..', '.github', 'workflows', 'test.yml'), 'utf8');
  for (const job of Object.keys(JOB_PROXY_COMMANDS)) {
    assert.ok(jobExistsInWorkflow(realYml, job), `JOB_PROXY_COMMANDS names job "${job}", which no longer exists in test.yml — every future red-signature card for it will silently degrade to owner-judgment`);
  }
});

test('against the REAL test.yml: a known-stable step resolves to its own command', () => {
  const dirname = path.dirname(new URL(import.meta.url).pathname);
  const realYml = fs.readFileSync(path.join(dirname, '..', '..', '.github', 'workflows', 'test.yml'), 'utf8');
  const cmd = findStepRunCommandInWorkflow(realYml, 'Data Validation', 'Run data validation');
  assert.equal(cmd, 'node scripts/validate-data.js');
});

// ── BRO-4151: two real steps that used to degrade to owner-judgment ────────
//
// Both step commands were already resolvable (findStepRunCommandInWorkflow
// found them fine) but failed safe-form validation, so verifyForSignature
// went straight to owner-judgment with no job-level fallback — the red-first
// pass then skipped these cards outright (no-safe-verify) instead of
// dispatching them. Fixed by admitting each step's own command into
// SAFE_CHECK_FORMS (autonomous-triage-core.js), not by changing this file.

test('against the REAL test.yml: the PII audit step (BRO-4147) now arms its own command', () => {
  const dirname = path.dirname(new URL(import.meta.url).pathname);
  const realYml = fs.readFileSync(path.join(dirname, '..', '..', '.github', 'workflows', 'test.yml'), 'utf8');
  const v = verifyForSignature({ job: 'Lint Workflows', step: 'Audit — no submitter PII in committed data/audit files' }, realYml);
  assert.equal(v.line, 'VERIFY: node scripts/lint-committed-pii.js');
  assert.equal(v.note, null);
});

test('against the REAL test.yml: the stranded-commit-cascade bash integration step (BRO-4149) now arms its own command', () => {
  const dirname = path.dirname(new URL(import.meta.url).pathname);
  const realYml = fs.readFileSync(path.join(dirname, '..', '..', '.github', 'workflows', 'test.yml'), 'utf8');
  const v = verifyForSignature({ job: 'Unit Tests', step: 'Run push-with-retry stranded-commit-cascade test (bash integration)' }, realYml);
  assert.equal(v.line, 'VERIFY: bash scripts/lib/push-with-retry.stranded-commit-cascade.test.sh');
  assert.equal(v.note, null);
});

// BRO-6262: a failing unit test re-verifies against its own file, so the Done gate
// is not held hostage by unrelated reds in the whole-suite proxy.
test('a Unit Tests signature with a failing test file narrows the proxy to node --test <file>', () => {
  const v = verifyForSignature({ job: 'Unit Tests', step: 'Run unit tests (no-data-dependency)', testFile: 'tests/unit/show-hero-integrity.test.mjs' }, FIXTURE_YML, { isTsxTest: () => false });
  assert.equal(v.line, 'VERIFY: node --test tests/unit/show-hero-integrity.test.mjs');
  assert.equal(explainUnsafeCheckCommand('node --test tests/unit/show-hero-integrity.test.mjs').ok, true);
});

test('a tsx-manifest test file gets npx tsx --test, and an unsafe path falls back to the proxy', () => {
  const tsx = verifyForSignature({ job: 'Unit Tests', step: 'Run unit tests (no-data-dependency)', testFile: 'tests/unit/show-market.test.ts' }, FIXTURE_YML, { isTsxTest: () => true });
  assert.equal(tsx.line, 'VERIFY: npx tsx --test tests/unit/show-market.test.ts');
  const bad = verifyForSignature({ job: 'Unit Tests', step: 'Run unit tests (no-data-dependency)', testFile: '../etc/x.test.mjs' }, FIXTURE_YML, { isTsxTest: () => false });
  assert.equal(bad.line, `VERIFY: ${JOB_PROXY_COMMANDS['Unit Tests']}`);
});

test('the default tsx check reads the real manifest', () => {
  const tsxFile = fs.readFileSync(path.join(process.cwd(), 'tests/unit-test-manifest-tsx.txt'), 'utf8').split('\n').map((l) => l.trim()).find((l) => /\.test\.(m?js|ts)$/.test(l) && l.startsWith('tests/'));
  if (!tsxFile) return;
  assert.match(verifyForSignature({ job: 'Unit Tests', step: 'x', testFile: tsxFile }, FIXTURE_YML).line, /^VERIFY: npx tsx --test /);
});

test('a job with no proxy command never gets a narrowed file command (stays owner-judgment)', () => {
  const v = verifyForSignature({ job: 'Some Unregistered Job', step: 'x', testFile: 'tests/unit/a.test.mjs' }, FIXTURE_YML, { isTsxTest: () => false });
  assert.equal(v.line, 'VERIFY: owner-judgment');
});
