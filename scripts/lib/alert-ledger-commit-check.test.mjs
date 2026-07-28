import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { findMissingLedgerCommits } = require('./alert-ledger-commit-check.js');

const MISSING_COMMIT_FIXTURE = `name: Bad Example
on:
  push:
jobs:
  broken:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        uses: actions/github-script@v7
        with:
          script: |
            const { routeAlert } = require('./scripts/lib/owner-alert-router.js');
            await routeAlert({ conditionKey: 'x', title: 'y', disposition: 'auto' });
      - name: Commit other stuff
        run: |
          git add data/audit/some-other-file.json
          git commit -m 'x'
`;

const DIRECT_COMMIT_FIXTURE = `name: Good Example (direct git add)
on:
  push:
jobs:
  ok:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        run: |
          node -e "require('./scripts/lib/owner-alert-router.js').resolveCondition('x')"
      - name: Commit
        run: |
          git add data/audit/alert-ledger.json 2>/dev/null || true
          git commit -m 'x'
`;

const LOOP_COMMIT_FIXTURE = `name: Good Example (for-loop staging)
on:
  push:
jobs:
  ok:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        uses: actions/github-script@v7
        with:
          script: |
            const { routeAlert } = require('./scripts/lib/owner-alert-router.js');
            await routeAlert({ conditionKey: 'x', title: 'y', disposition: 'digest' });
      - name: Commit
        run: |
          for f in data/audit/foo.json data/audit/alert-ledger.json; do
            [ -e "$f" ] && git add "$f" || echo "skip (absent): $f"
          done
          git commit -m 'x'
`;

const OTHER_JOB_COMMIT_FIXTURE = `name: Bad Example (commit in a DIFFERENT job)
on:
  push:
jobs:
  alerter:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        run: |
          node -e "require('./scripts/lib/owner-alert-router.js').resolveCondition('x')"
  committer:
    runs-on: ubuntu-latest
    steps:
      - name: Commit
        run: |
          git add data/audit/alert-ledger.json 2>/dev/null || true
          git commit -m 'x'
`;

const NO_ROUTE_ALERT_FIXTURE = `name: Unrelated
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm run build
`;

test('flags a job that calls routeAlert() with no ledger commit', () => {
  const violations = findMissingLedgerCommits(MISSING_COMMIT_FIXTURE);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /job 'broken'/);
  assert.match(violations[0], /alert-ledger\.json/);
});

test('clean: direct `git add ... alert-ledger.json` in the same job', () => {
  assert.deepEqual(findMissingLedgerCommits(DIRECT_COMMIT_FIXTURE), []);
});

test('clean: for-loop staging pattern (audit-aggregator-gap.yml style)', () => {
  assert.deepEqual(findMissingLedgerCommits(LOOP_COMMIT_FIXTURE), []);
});

test('flags routeAlert in one job when the commit happens in a DIFFERENT job', () => {
  const violations = findMissingLedgerCommits(OTHER_JOB_COMMIT_FIXTURE);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /job 'alerter'/);
});

test('no violation when the workflow never calls routeAlert/resolveCondition', () => {
  assert.deepEqual(findMissingLedgerCommits(NO_ROUTE_ALERT_FIXTURE), []);
});

test('no violation on text with no jobs: section', () => {
  assert.deepEqual(findMissingLedgerCommits('name: no-jobs\non:\n  push:\n'), []);
});

test('every real .github/workflows/*.yml is clean', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const workflowsDir = path.join(repoRoot, '.github', 'workflows');
  const files = fs.readdirSync(workflowsDir).filter(f => f.endsWith('.yml'));
  assert.ok(files.length > 50, 'sanity check: expected many workflow files');

  const failures = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
    const violations = findMissingLedgerCommits(text);
    if (violations.length) failures.push(`${file}: ${violations.join('; ')}`);
  }
  assert.deepEqual(failures, []);
});
