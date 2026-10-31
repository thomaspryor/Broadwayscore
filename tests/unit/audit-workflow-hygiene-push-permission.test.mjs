// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — the detector under test
// never reads data/*.json; it only parses workflow YAML text.
/**
 * Unit tests for findPushWithoutWritePermission (rule (v), BRO-5302): a job
 * that pushes the root checkout (push-with-retry.sh, or a composite that runs
 * it) while its declared permissions lack `contents: write` 403s on every
 * attempt. Pattern: require() the real function (CLAUDE.md rule 15).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  findPushWithoutWritePermission,
  ROOT_PUSH_COMPOSITES,
  NESTED_PUSH_COMPOSITES,
} = require('../../scripts/lib/audit-workflow-hygiene-rules.js');

const ROOT = path.resolve(import.meta.dirname, '../..');
const PUSH_STEP = `      - name: Commit ledger
        run: |
          git commit -m "x"
          bash scripts/lib/push-with-retry.sh
`;
const wf = ({ top = '', job = '', steps = PUSH_STEP } = {}) => `name: t
on: workflow_dispatch
${top}
jobs:
  build:
    runs-on: ubuntu-latest
${job}    steps:
${steps}`;

describe('findPushWithoutWritePermission', () => {
  test('flags a push under workflow-level contents: read (the orchestrator case)', () => {
    const hits = findPushWithoutWritePermission(wf({ top: 'permissions:\n  contents: read\n  actions: write\n' }));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].job, 'build');
  });

  test('flags a block that omits contents entirely (the outlet-listing-poller case)', () => {
    assert.equal(findPushWithoutWritePermission(wf({ top: 'permissions:\n  actions: write\n' })).length, 1);
  });

  test('flags an empty inline block `permissions: {}`', () => {
    assert.equal(findPushWithoutWritePermission(wf({ top: 'permissions: {}\n' })).length, 1);
  });

  test('passes contents: write at workflow level, with a comment inside the block', () => {
    const top = 'permissions:\n  # note\n  contents: write\n  actions: write\n';
    assert.equal(findPushWithoutWritePermission(wf({ top })).length, 0);
  });

  test('passes write-all', () => {
    assert.equal(findPushWithoutWritePermission(wf({ top: 'permissions: write-all\n' })).length, 0);
  });

  test('job-level write overrides workflow-level read', () => {
    const job = '    permissions:\n      contents: write\n';
    assert.equal(findPushWithoutWritePermission(wf({ top: 'permissions:\n  contents: read\n', job })).length, 0);
  });

  test('job-level read overrides workflow-level write', () => {
    const job = '    permissions:\n      contents: read\n';
    assert.equal(findPushWithoutWritePermission(wf({ top: 'permissions:\n  contents: write\n', job })).length, 1);
  });

  test('no permissions block anywhere inherits the repo default and is skipped', () => {
    assert.equal(findPushWithoutWritePermission(wf()).length, 0);
  });

  test('a read job without a push is not flagged', () => {
    const steps = '      - run: echo hello\n';
    assert.equal(findPushWithoutWritePermission(wf({ top: 'permissions:\n  contents: read\n', steps })).length, 0);
  });

  test('an echo or comment that merely names push-with-retry.sh is not a call', () => {
    const steps = `      - run: |
          echo "push-with-retry.sh compensates for this"
          # bash scripts/lib/push-with-retry.sh
`;
    assert.equal(findPushWithoutWritePermission(wf({ top: 'permissions:\n  contents: read\n', steps })).length, 0);
  });

  test('flags a root-pushing composite under contents: read (the scrapingdog case)', () => {
    const steps = '      - uses: ./.github/actions/commit-scraper-spend-ledger\n';
    const hits = findPushWithoutWritePermission(wf({ top: 'permissions:\n  contents: read\n', steps }));
    assert.equal(hits.length, 1);
    assert.match(hits[0].text, /commit-scraper-spend-ledger/);
  });

  test('a nested-repo composite (push-core-data) is not a root push', () => {
    const steps = '      - uses: ./.github/actions/push-core-data\n';
    assert.equal(findPushWithoutWritePermission(wf({ top: 'permissions:\n  contents: read\n', steps })).length, 0);
  });

  test('reports the correct 1-based line number', () => {
    const raw = wf({ top: 'permissions:\n  contents: read\n' });
    const [hit] = findPushWithoutWritePermission(raw);
    assert.match(raw.split('\n')[hit.lineNum - 1], /push-with-retry\.sh/);
  });
});

describe('syntax variants', () => {
  const read = 'permissions:\n  contents: read\n';
  const run = (cmd) => wf({ top: read, steps: `      - name: P\n        run: ${cmd}\n` });

  test('bash -x, source, dot, and bare ./ invocations all count as a push', () => {
    for (const cmd of [
      'bash -x scripts/lib/push-with-retry.sh',
      'bash -e -x scripts/lib/push-with-retry.sh 5 main',
      'sh scripts/lib/push-with-retry.sh',
      'source scripts/lib/push-with-retry.sh',
      '. scripts/lib/push-with-retry.sh',
      './scripts/lib/push-with-retry.sh',
    ]) {
      assert.equal(findPushWithoutWritePermission(run(cmd)).length, 1, cmd);
    }
  });

  test('a path inside an echo is not a push', () => {
    assert.equal(findPushWithoutWritePermission(run('echo "see ./scripts/lib/push-with-retry.sh"')).length, 0);
  });

  test('flow-map and quoted contents: write are treated as write', () => {
    assert.equal(findPushWithoutWritePermission(wf({ top: 'permissions: { contents: write }\n' })).length, 0);
    assert.equal(findPushWithoutWritePermission(wf({ top: "permissions:\n  contents: 'write'\n" })).length, 0);
  });

  test('read-all and a job-level empty block are not write', () => {
    assert.equal(findPushWithoutWritePermission(wf({ top: 'permissions: read-all\n' })).length, 1);
    const job = '    permissions: {}\n';
    assert.equal(findPushWithoutWritePermission(wf({ top: 'permissions:\n  contents: write\n', job })).length, 1);
  });

  test('a trailing comment after the composite name still matches', () => {
    const steps = '      - uses: ./.github/actions/commit-stage-latency # emits stage events\n';
    assert.equal(findPushWithoutWritePermission(wf({ top: read, steps })).length, 1);
  });
});

describe('audit CLI wiring (rule v reaches the exit code)', () => {
  const audit = path.join(ROOT, 'scripts/audit-workflow-hygiene.js');
  const runAudit = (body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-pushperm-'));
    try {
      fs.writeFileSync(path.join(dir, 'x.yml'), body);
      for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(dir, `inert-${i}.yml`), '# hygiene-notify-ok: inert fixture\n# hygiene-permissions-ok: inert fixture (BRO-6398 rule aa)\nname: inert\non: workflow_dispatch\njobs: {}\n');
      return spawnSync('node', [audit], { env: { ...process.env, HYGIENE_WORKFLOW_DIR: dir }, encoding: 'utf8' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  // the same body shape for all three runs; only the permission/exemption differs
  const body = (perm, marker = '') =>
    `name: x\n${marker}on: workflow_dispatch\n${perm}jobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Push\n        run: |\n          git config user.name "github-actions[bot]"\n          git add data/audit/x.json\n          git commit -m x\n          bash scripts/lib/push-with-retry.sh\n      - name: Notify on failure\n        if: failure()\n        uses: ./.github/actions/notify-failure\n        with:\n          title: x\n`;

  test('read permission fails the audit and names rule (v)', () => {
    const r = runAudit(body('permissions:\n  contents: read\n'));
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /\(v\) Root push/);
  });

  test('contents: write passes', () => {
    const r = runAudit(body('permissions:\n  contents: write\n'));
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  test('hygiene-push-perm-ok exemption passes', () => {
    const r = runAudit(body('permissions:\n  contents: read\n', '# hygiene-push-perm-ok: pushes via a PAT remote\n'));
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

describe('composite classification pin', () => {
  test('every composite action that runs push-with-retry.sh is classified root or nested', () => {
    const dir = path.join(ROOT, '.github/actions');
    const known = new Set([...ROOT_PUSH_COMPOSITES, ...NESTED_PUSH_COMPOSITES]);
    const unclassified = fs
      .readdirSync(dir)
      .filter((name) => fs.existsSync(path.join(dir, name, 'action.yml')))
      .filter((name) => {
        const body = fs.readFileSync(path.join(dir, name, 'action.yml'), 'utf8');
        return body.split('\n').some((l) => !l.trim().startsWith('#') && /push-with-retry\.sh/.test(l));
      })
      .filter((name) => !known.has(name));
    assert.deepEqual(
      unclassified,
      [],
      `composite(s) call push-with-retry.sh but are in neither ROOT_PUSH_COMPOSITES nor NESTED_PUSH_COMPOSITES ` +
        `(scripts/lib/audit-workflow-hygiene-rules.js): ${unclassified.join(', ')}`,
    );
  });
});

describe('real workflows', () => {
  test('the four BRO-5302 workflows now grant contents: write', () => {
    for (const f of [
      'opening-night-orchestrator',
      'opening-night-reviews',
      'outlet-listing-poller',
      'scrapingdog-account-usage',
    ]) {
      const raw = fs.readFileSync(path.join(ROOT, `.github/workflows/${f}.yml`), 'utf8');
      assert.deepEqual(findPushWithoutWritePermission(raw), [], f);
    }
  });
});
