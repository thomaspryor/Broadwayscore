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
const { findDispatchWithoutActionsWrite, DISPATCH_COMPOSITES } = require('../../scripts/lib/audit-workflow-hygiene-rules.js');

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
    for (const cmd of ['gh run cancel 123', 'gh run rerun 123 --failed', 'gh api repos/o/r/actions/workflows/9/dispatches -f ref=main']) {
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

describe('composites, token provenance, repository_dispatch', () => {
  const read = 'permissions:\n  contents: write\n';

  test('uses: of a dispatching composite is a dispatch (dispatch-deploy, the update-theatr case)', () => {
    const steps = '      - name: Deploy\n        uses: ./.github/actions/dispatch-deploy # after scrape\n';
    const hits = findDispatchWithoutActionsWrite(wf({ top: read, steps }));
    assert.equal(hits.length, 1);
    assert.match(hits[0].text, /dispatch-deploy/);
    const ok = findDispatchWithoutActionsWrite(wf({ top: `${read}  actions: write\n`, steps }));
    assert.equal(ok.length, 0);
  });

  test('secrets.GITHUB_TOKEN is the workflow token, not a PAT, so it does not exempt the step', () => {
    const steps = `      - name: D
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: gh workflow run other.yml
`;
    assert.equal(findDispatchWithoutActionsWrite(wf({ top: read, steps })).length, 1);
  });

  test('a PAT set at job level or workflow level exempts the job steps', () => {
    const steps = '      - name: D\n        run: gh workflow run other.yml\n';
    const job = '    env:\n      GH_TOKEN: ${{ secrets.REVIEW_TEXTS_TOKEN }}\n';
    assert.equal(findDispatchWithoutActionsWrite(wf({ top: read, job, steps })).length, 0);
    const top = `${read}env:\n  GH_TOKEN: \${{ secrets.REVIEW_TEXTS_TOKEN }}\n`;
    assert.equal(findDispatchWithoutActionsWrite(wf({ top, steps })).length, 0);
  });

  test('repository_dispatch (repos/o/r/dispatches) needs contents: write, not actions: write', () => {
    const steps = '      - name: D\n        run: gh api repos/o/r/dispatches -f event_type=x\n';
    assert.equal(findDispatchWithoutActionsWrite(wf({ top: read, steps })).length, 0);
    const wfd = '      - name: D\n        run: gh api repos/o/r/actions/workflows/123/dispatches -f ref=main\n';
    assert.equal(findDispatchWithoutActionsWrite(wf({ top: read, steps: wfd })).length, 1);
  });

  test('every composite action that runs a dispatch-class gh call with the workflow token is listed', () => {
    const dir = path.join(ROOT, '.github/actions');
    const dispatchRe = /\bgh\s+(?:workflow\s+run|run\s+(?:cancel|rerun))\b/;
    const unlisted = fs
      .readdirSync(dir)
      .filter((name) => fs.existsSync(path.join(dir, name, 'action.yml')))
      .filter((name) => {
        const body = fs.readFileSync(path.join(dir, name, 'action.yml'), 'utf8');
        const calls = body.split('\n').some((l) => !l.trim().startsWith('#') && dispatchRe.test(l));
        const pat = /\b(?:GH_TOKEN|GITHUB_TOKEN)\s*:\s*\$\{\{\s*secrets\.(?!GITHUB_TOKEN\b)/.test(body);
        const inputToken = /\b(?:GH_TOKEN|GITHUB_TOKEN)\s*:\s*\$\{\{\s*inputs\./.test(body);
        return calls && !pat && !inputToken;
      })
      .filter((name) => !DISPATCH_COMPOSITES.includes(name));
    assert.deepEqual(
      unlisted,
      [],
      `composite(s) dispatch with the workflow token but are not in DISPATCH_COMPOSITES ` +
        `(scripts/lib/audit-workflow-hygiene-rules.js): ${unlisted.join(', ')}`,
    );
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

  test('update-theatr.yml: the swallowed deploy-dispatch 403 comes back if actions: write is removed', () => {
    const raw = fs.readFileSync(path.join(ROOT, '.github/workflows/update-theatr.yml'), 'utf8');
    assert.deepEqual(findDispatchWithoutActionsWrite(raw), []);
    const mutated = raw.replace(/^ {2}actions: write.*$/m, '');
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
      for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(dir, `inert-${i}.yml`), '# hygiene-notify-ok: inert fixture\n# hygiene-permissions-ok: inert fixture (BRO-6398 rule aa)\nname: inert\non: workflow_dispatch\njobs: {}\n');
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
