// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — the detector under test
// only parses workflow YAML text; no data/*.json is read.
/**
 * Unit tests for findDispatchWithoutActionsWrite (rule (w), BRO-5302 cousin):
 * `gh workflow run` / `gh run cancel|rerun` with the workflow token in a job
 * whose declared permissions lack `actions: write` 403s, usually swallowed by
 * `|| echo`. Pattern: require() the real function (CLAUDE.md rule 15).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findDispatchWithoutActionsWrite } = require('../../scripts/lib/audit-workflow-hygiene-rules.js');

const ROOT = path.resolve(import.meta.dirname, '../..');
const DISPATCH_STEP = `      - name: Dispatch
        env:
          GH_TOKEN: \${{ github.token }}
        run: gh workflow run other.yml -f mode=x
`;
const wf = ({ top = '', job = '', steps = DISPATCH_STEP } = {}) => `name: t
on: workflow_dispatch
${top}
jobs:
  build:
    runs-on: ubuntu-latest
${job}    steps:
${steps}`;

describe('findDispatchWithoutActionsWrite', () => {
  test('flags a workflow-token dispatch under contents: read only', () => {
    const hits = findDispatchWithoutActionsWrite(wf({ top: 'permissions:\n  contents: read\n' }));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].job, 'build');
  });

  test('passes when actions: write is declared at workflow level', () => {
    assert.equal(findDispatchWithoutActionsWrite(wf({ top: 'permissions:\n  contents: read\n  actions: write\n' })).length, 0);
  });

  test('job-level actions: write overrides a read-only workflow default', () => {
    const job = '    permissions:\n      actions: write # dispatch\n';
    assert.equal(findDispatchWithoutActionsWrite(wf({ top: 'permissions:\n  contents: read\n', job })).length, 0);
  });

  test('job-level block without actions overrides a workflow-level grant', () => {
    const job = '    permissions:\n      contents: read\n';
    assert.equal(findDispatchWithoutActionsWrite(wf({ top: 'permissions:\n  actions: write\n', job })).length, 1);
  });

  test('no permissions block anywhere inherits the repo default and is skipped', () => {
    assert.equal(findDispatchWithoutActionsWrite(wf()).length, 0);
  });

  test('a step authenticating with a secrets-backed PAT is not flagged', () => {
    const steps = `      - name: Dispatch
        env:
          GH_TOKEN: \${{ secrets.REVIEW_TEXTS_TOKEN }}
        run: gh workflow run other.yml
`;
    assert.equal(findDispatchWithoutActionsWrite(wf({ top: 'permissions:\n  contents: read\n', steps })).length, 0);
  });

  test('cancel, rerun and a /dispatches API call are all dispatch-class calls', () => {
    for (const cmd of ['gh run cancel 123', 'gh run rerun 123 --failed', 'gh api repos/o/r/dispatches -f event_type=x']) {
      const steps = `      - name: D\n        run: ${cmd}\n`;
      assert.equal(findDispatchWithoutActionsWrite(wf({ top: 'permissions:\n  contents: read\n', steps })).length, 1, cmd);
    }
  });

  test('a comment or an unrelated gh call is not flagged', () => {
    const steps = `      - name: D\n        run: |\n          # gh workflow run x.yml\n          gh run list --limit 1\n`;
    assert.equal(findDispatchWithoutActionsWrite(wf({ top: 'permissions:\n  contents: read\n', steps })).length, 0);
  });

  test('reports a correct 1-based line number', () => {
    const raw = wf({ top: 'permissions:\n  contents: read\n' });
    const [hit] = findDispatchWithoutActionsWrite(raw);
    assert.match(raw.split('\n')[hit.lineNum - 1], /gh workflow run/);
  });
});

describe('real workflows', () => {
  test('stripping the job-level actions: write from a real dispatcher is caught (rule has teeth)', () => {
    const raw = fs.readFileSync(path.join(ROOT, '.github/workflows/finance-ingest.yml'), 'utf8');
    assert.deepEqual(findDispatchWithoutActionsWrite(raw), [], 'unmodified finance-ingest.yml is clean');
    const mutated = raw.replace(/^ {6}actions: write.*$/m, '');
    assert.notEqual(mutated, raw, 'mutation must apply');
    assert.equal(findDispatchWithoutActionsWrite(mutated).length, 1);
  });

  test('no real workflow has the gap', () => {
    const dir = path.join(ROOT, '.github/workflows');
    const bad = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yml'))) {
      for (const h of findDispatchWithoutActionsWrite(fs.readFileSync(path.join(dir, f), 'utf8'))) {
        bad.push(`${f}:${h.lineNum} ${h.text}`);
      }
    }
    assert.deepEqual(bad, []);
  });
});

describe('audit CLI wiring (rule w reaches the exit code)', () => {
  const audit = path.join(ROOT, 'scripts/audit-workflow-hygiene.js');
  const runAudit = (body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-dispatchperm-'));
    try {
      fs.writeFileSync(path.join(dir, 'x.yml'), body);
      return spawnSync('node', [audit], { env: { ...process.env, HYGIENE_WORKFLOW_DIR: dir }, encoding: 'utf8' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const body = (perm, marker = '') =>
    `name: x\n${marker}on: workflow_dispatch\n${perm}jobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Fire\n        env:\n          GH_TOKEN: \${{ github.token }}\n        run: gh workflow run y.yml\n      - name: Notify on failure\n        if: failure()\n        uses: ./.github/actions/notify-failure\n        with:\n          title: x\n`;

  test('read-only permissions fail the audit and name rule (w)', () => {
    const r = runAudit(body('permissions:\n  contents: read\n'));
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /\(w\) Workflow-token dispatch/);
  });

  test('actions: write passes', () => {
    const r = runAudit(body('permissions:\n  actions: write\n'));
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  test('hygiene-dispatch-perm-ok exemption passes', () => {
    const r = runAudit(body('permissions:\n  contents: read\n', '# hygiene-dispatch-perm-ok: uses a PAT remote\n'));
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});
