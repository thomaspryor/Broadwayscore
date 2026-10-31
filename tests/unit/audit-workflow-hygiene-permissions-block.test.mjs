// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — the detector under test
// never reads data/*.json; it only parses workflow YAML text.
/**
 * Unit tests for findMissingTopLevelPermissions (rule (aa), BRO-6398): a
 * workflow with no top-level `permissions:` block runs its jobs on the repo
 * default (write-all). Pattern: require() the real function (CLAUDE.md rule 15).
 * The last test sweeps the real .github/workflows so a new workflow landing
 * without a block fails here even if the audit wiring changes.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findMissingTopLevelPermissions } = require('../../scripts/lib/audit-workflow-hygiene-rules.js');
const ROOT = path.resolve(import.meta.dirname, '../..');

const wf = (top = '') => `name: t
on: workflow_dispatch
${top}jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

describe('findMissingTopLevelPermissions', () => {
  test('flags a workflow with no permissions block anywhere', () => {
    const hits = findMissingTopLevelPermissions(wf());
    assert.equal(hits.length, 1);
    assert.match(hits[0].text, /no top-level permissions/);
  });
  test('a job-level block alone is not enough (other jobs inherit the default)', () => {
    const raw = `name: t\non: workflow_dispatch\njobs:\n  a:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n    steps:\n      - run: echo\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`;
    assert.equal(findMissingTopLevelPermissions(raw).length, 1);
  });
  test('accepts a top-level block (block form and flow form)', () => {
    assert.equal(findMissingTopLevelPermissions(wf('permissions:\n  contents: read\n')).length, 0);
    assert.equal(findMissingTopLevelPermissions(wf('permissions: { contents: read }\n')).length, 0);
  });
  test('ignores a reusable-workflow-less file with no jobs', () => {
    assert.equal(findMissingTopLevelPermissions('name: t\non: push\n').length, 0);
  });
  test('every workflow in .github/workflows declares one', () => {
    const dir = path.join(ROOT, '.github/workflows');
    const offenders = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).filter((f) => {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      return !raw.includes('hygiene-permissions-ok:') && findMissingTopLevelPermissions(raw).length > 0;
    });
    assert.deepEqual(offenders, []);
  });
});
