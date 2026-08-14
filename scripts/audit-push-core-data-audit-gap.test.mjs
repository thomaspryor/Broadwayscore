import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  checkWorkflow,
  findInvokedScripts,
  scriptWritesAuditJson,
  hasAlternativePersistMechanism,
} = require('./audit-push-core-data-audit-gap.js');

const PUSH_CORE_DATA_STEP = `
      - name: Push core data
        uses: ./.github/actions/push-core-data
        with:
          token: \${{ secrets.REVIEW_TEXTS_TOKEN }}
`;

// scripts/check-bd-breaker.js writes data/audit/bd-circuit-breaker.json via a
// STATE_PATH const + fs.writeFileSync(STATE_PATH, ...) — a real, on-disk
// example of the write-via-variable shape the detector must catch.
test('scriptWritesAuditJson: true for a real script that writes an audit ledger via a variable', () => {
  assert.equal(scriptWritesAuditJson('scripts/check-bd-breaker.js'), true);
});

// Regression for the original false positive: validate-data.js mentions a
// data/audit/*.json path only inside an unrelated error() string, and
// separately calls writeFileSync for something else — the two must not be
// conflated into "this script writes an audit ledger".
test('scriptWritesAuditJson: false for validate-data.js (unrelated writeFileSync + audit-path mention)', () => {
  assert.equal(scriptWritesAuditJson('scripts/validate-data.js'), false);
});

test('scriptWritesAuditJson: false for a script that does not exist on disk', () => {
  assert.equal(scriptWritesAuditJson('scripts/does-not-exist-9999.js'), false);
});

test('checkWorkflow: flags a workflow invoking check-bd-breaker.js with only push-core-data', () => {
  const raw = `
jobs:
  audit:
    steps:
      - run: node scripts/check-bd-breaker.js
${PUSH_CORE_DATA_STEP}`;
  const result = checkWorkflow('fake.yml', raw);
  assert.ok(result);
  assert.deepEqual(result.writingScripts, ['scripts/check-bd-breaker.js']);
});

test('checkWorkflow: not flagged once an explicit git add + push-with-retry.sh is present', () => {
  const raw = `
jobs:
  audit:
    steps:
      - run: node scripts/check-bd-breaker.js
      - run: |
          git add data/audit/bd-circuit-breaker.json
          git commit -m x
          bash scripts/lib/push-with-retry.sh
${PUSH_CORE_DATA_STEP}`;
  assert.equal(checkWorkflow('fixed.yml', raw), null);
});

test('checkWorkflow: exempt annotation suppresses the check entirely', () => {
  const raw = `
# hygiene-audit-persist-ok: scratch file, no cross-run state
jobs:
  audit:
    steps:
      - run: node scripts/check-bd-breaker.js
${PUSH_CORE_DATA_STEP}`;
  assert.equal(checkWorkflow('exempt.yml', raw), null);
});

test('checkWorkflow: workflow with no push-core-data call is never flagged', () => {
  const raw = `
jobs:
  audit:
    steps:
      - run: node scripts/check-bd-breaker.js
`;
  assert.equal(checkWorkflow('no-push-core-data.yml', raw), null);
});

test('findInvokedScripts ignores commented-out lines', () => {
  const raw = `
      - run: |
          # node scripts/should-be-ignored.js
          node scripts/real-invocation.js
`;
  assert.deepEqual(findInvokedScripts(raw), ['scripts/real-invocation.js']);
});

test('hasAlternativePersistMechanism: recognizes explicit git add data/audit + push-with-retry', () => {
  const raw = `
      - run: |
          git add data/audit/foo.json
          bash scripts/lib/push-with-retry.sh
`;
  assert.equal(hasAlternativePersistMechanism(raw), true);
});

test('hasAlternativePersistMechanism: recognizes stage-data-changes.sh covering data/ + push-with-retry (fetch-all-image-formats.yml shape)', () => {
  const raw = `
      - run: |
          bash scripts/lib/stage-data-changes.sh data/ public/images/shows/
          git commit -m x
          bash scripts/lib/push-with-retry.sh 5 HEAD:main
`;
  assert.equal(hasAlternativePersistMechanism(raw), true);
});

test('hasAlternativePersistMechanism: no push-with-retry.sh anywhere means no alternative, even with git add', () => {
  const raw = `
      - run: git add data/audit/foo.json && git commit -m x
`;
  assert.equal(hasAlternativePersistMechanism(raw), false);
});
