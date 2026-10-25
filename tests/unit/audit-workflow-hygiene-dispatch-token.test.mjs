// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — the detector under test
// only parses workflow YAML text; no data/*.json is read.
/**
 * Unit tests for findScriptWithoutDispatchToken (rule (x), BRO-2872): a step
 * that runs opening-night-checklist.js without GITHUB_TOKEN makes every
 * remediation dispatch fail `no-token`. Pattern: require() the real function.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findScriptWithoutDispatchToken, TOKEN_REQUIRED_SCRIPTS } = require('../../scripts/lib/audit-workflow-hygiene-rules.js');

const ROOT = path.resolve(import.meta.dirname, '../..');
const STEP = (env = '') => `      - name: Checklist
${env}        run: node scripts/opening-night-checklist.js --show=x --json
`;
const wf = ({ top = '', job = '', steps = STEP() } = {}) => `name: t
on: workflow_dispatch
${top}
jobs:
  build:
    runs-on: ubuntu-latest
${job}    steps:
${steps}`;

describe('findScriptWithoutDispatchToken', () => {
  test('flags a checklist step with no token anywhere', () => {
    const hits = findScriptWithoutDispatchToken(wf({ steps: STEP('        env:\n          RESEND_API_KEY: x\n') }));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].job, 'build');
  });
  test('passes with GITHUB_TOKEN in step env', () => {
    const env = '        env:\n          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n';
    assert.equal(findScriptWithoutDispatchToken(wf({ steps: STEP(env) })).length, 0);
  });
  test('passes with the token in job env or workflow env', () => {
    const t = '  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n';
    assert.equal(findScriptWithoutDispatchToken(wf({ job: '    env:\n  ' + t })).length, 0);
    assert.equal(findScriptWithoutDispatchToken(wf({ top: 'env:\n' + t })).length, 0);
  });
  test('ignores comments and unrelated scripts', () => {
    const steps = `      - name: x
        run: |
          # node scripts/opening-night-checklist.js
          node scripts/other.js
`;
    assert.equal(findScriptWithoutDispatchToken(wf({ steps })).length, 0);
  });
  test('registry lists the checklist script', () => {
    assert.ok(TOKEN_REQUIRED_SCRIPTS.includes('opening-night-checklist.js'));
  });
  test('every real workflow that runs the checklist passes (the BRO-2872 regression)', () => {
    const dir = path.join(ROOT, '.github/workflows');
    const bad = [];
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.yml'))) {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      if (raw.includes('hygiene-dispatch-token-ok:')) continue;
      if (findScriptWithoutDispatchToken(raw).length) bad.push(f);
    }
    assert.deepEqual(bad, []);
  });
  test('the audit CLI reports no (x) violation on the repo', () => {
    const r = spawnSync('node', ['scripts/audit-workflow-hygiene.js'], { cwd: ROOT, encoding: 'utf8' });
    assert.ok(!/\(x\) Self-healing script/.test(r.stderr + r.stdout), r.stderr.slice(-500));
  });
});
