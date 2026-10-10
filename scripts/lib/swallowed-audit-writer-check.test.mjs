import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { findSwallowedAuditWriters, splitSteps } = require('./swallowed-audit-writer-check.js');

// Real-shape fixture: the ACTUAL broken pattern found in
// opening-night-checklist.yml before task #1073's W2.1 fix (continue-on-error
// AND a same-line `|| true` on the audit-writing node invocation).
const CONTINUE_ON_ERROR_AND_OR_TRUE_FIXTURE = `name: Example
on:
  schedule:
    - cron: '17 * * * *'
jobs:
  checklist:
    runs-on: ubuntu-latest
    steps:
      - name: Run opening night checklist
        continue-on-error: true
        run: |
          node scripts/opening-night-checklist.js --json --out=/tmp/checklist.json 2>&1 || true
`;

// Multi-line \`\\\` continuation: node call and \`|| true\` on DIFFERENT physical
// lines — mirrors the real "Run latency report" step in
// opening-night-checklist.yml. Step-level (not line-level) detection must
// still catch this.
const MULTILINE_CONTINUATION_FIXTURE = `name: Example
on:
  push:
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - name: Run latency report
        continue-on-error: true
        run: |
          node scripts/opening-night-latency-report.js \\
            --log data/audit/stage-latency.jsonl \\
            --output "$OUT" 2>&1 || true
`;

// continue-on-error alone (no \`|| true\`) is still a violation — either
// swallow mechanism on its own hides the script's real exit code.
const CONTINUE_ON_ERROR_ONLY_FIXTURE = `name: Example
on:
  push:
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - name: Run audit script
        continue-on-error: true
        run: |
          node scripts/some-audit-writer.js
`;

// A step that swallows failure but does NOT invoke an audit-writing script —
// clean (e.g. Run latency report if opening-night-latency-report.js did not
// write to data/audit/).
const SWALLOWED_NON_AUDIT_SCRIPT_FIXTURE = `name: Example
on:
  push:
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - name: Run something unrelated
        continue-on-error: true
        run: |
          node scripts/some-non-audit-script.js || true
`;

// Real false-positive found while wiring this check into
// opening-night-checklist.yml: an explanatory comment ABOUT the pattern
// (documenting that a step used to have continue-on-error/|| true) must not
// itself be read as the step having those — this step has neither.
const PROSE_COMMENT_MENTIONS_PATTERN_FIXTURE = `name: Example
on:
  push:
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - name: Run opening night checklist
        # W2.1: continue-on-error + \\\`|| true\\\` used to swallow EVERY exit code
        # this script could produce — removed below.
        run: |
          node scripts/opening-night-checklist.js --json
`;

// An audit-writing script invoked WITHOUT continue-on-error or \`|| true\` —
// clean (failures propagate normally).
const NOT_SWALLOWED_FIXTURE = `name: Example
on:
  push:
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - name: Run opening night checklist
        run: |
          node scripts/opening-night-checklist.js --json
`;

// Same broken shape as CONTINUE_ON_ERROR_AND_OR_TRUE_FIXTURE, but with an
// inline lint-allow-swallow exemption — must suppress the finding.
const ALLOWLISTED_FIXTURE = `name: Example
on:
  push:
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - name: Run opening night checklist
        # lint-allow-swallow: intentionally best-effort, downstream steps re-check
        continue-on-error: true
        run: |
          node scripts/opening-night-checklist.js --json --out=/tmp/checklist.json 2>&1 || true
`;

const isAuditWriter = (scriptPath) =>
  ['scripts/opening-night-checklist.js', 'scripts/opening-night-latency-report.js', 'scripts/some-audit-writer.js'].includes(
    scriptPath
  );

test('flags continue-on-error + same-line || true on an audit-writing script', () => {
  const violations = findSwallowedAuditWriters(CONTINUE_ON_ERROR_AND_OR_TRUE_FIXTURE, isAuditWriter);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /Run opening night checklist/);
  assert.match(violations[0], /opening-night-checklist\.js/);
});

test('flags a multi-line \\ continuation where || true is on a different physical line', () => {
  const violations = findSwallowedAuditWriters(MULTILINE_CONTINUATION_FIXTURE, isAuditWriter);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /Run latency report/);
  assert.match(violations[0], /opening-night-latency-report\.js/);
});

test('flags continue-on-error alone (no || true) on an audit-writing script', () => {
  const violations = findSwallowedAuditWriters(CONTINUE_ON_ERROR_ONLY_FIXTURE, isAuditWriter);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /continue-on-error: true/);
});

test('does not flag a swallowed step that does not invoke an audit-writing script', () => {
  const violations = findSwallowedAuditWriters(SWALLOWED_NON_AUDIT_SCRIPT_FIXTURE, isAuditWriter);
  assert.deepEqual(violations, []);
});

test('does not flag an audit-writing script invocation with no swallow mechanism', () => {
  const violations = findSwallowedAuditWriters(NOT_SWALLOWED_FIXTURE, isAuditWriter);
  assert.deepEqual(violations, []);
});

test('does not flag a comment that merely documents/mentions the swallow pattern in prose', () => {
  const violations = findSwallowedAuditWriters(PROSE_COMMENT_MENTIONS_PATTERN_FIXTURE, isAuditWriter);
  assert.deepEqual(violations, []);
});

test('lint-allow-swallow inline comment suppresses an otherwise-real violation', () => {
  const violations = findSwallowedAuditWriters(ALLOWLISTED_FIXTURE, isAuditWriter);
  assert.deepEqual(violations, []);
});

test('splitSteps splits on the repo step-list convention (- name:)', () => {
  const steps = splitSteps(CONTINUE_ON_ERROR_AND_OR_TRUE_FIXTURE);
  assert.equal(steps.length, 1);
  assert.match(steps[0][0], /- name: Run opening night checklist/);
});

test('empty/no-jobs workflow text produces no violations and no crash', () => {
  assert.deepEqual(findSwallowedAuditWriters('name: Empty\non: push\n', isAuditWriter), []);
  assert.deepEqual(findSwallowedAuditWriters('', isAuditWriter), []);
});
