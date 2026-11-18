import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectWorkflowChecks, CODE_AUDIT_CHECKS, materializeTree } from './land-preflight.mjs';

// BRO-7637: every land.yml run 2026-10-18..11-17 whose first failing gate was lint-workflows (14,
// from the Checks job logs: "checks RED — first failing gate: lint-workflows"), with the audit that
// was NEW on the branch. 12 are CODE_AUDIT_CHECKS audits; the 2 audit-orphan-tests ones are
// checkTestRegistration's. Replayed (tip tree vs origin/main) through checkWorkflowChecks /
// checkTestRegistration: each blocks. The 9 colocated-tests refusals (land.js) are covered by
// land-fast-tests.js colocatedTests (see its test).
const REFUSALS = [
  ['39823444261', 'audit-unsafe-show-dir-listing'],
  ['39926485691', 'audit-unsafe-show-dir-listing'],
  ['40082084074', 'audit-unsafe-show-dir-listing'],
  ['41050140329', 'audit-unsafe-show-dir-listing'],
  ['41339055902', 'lint-resend-calls'],
  ['41538224925', 'audit-alert-senders'],
  ['41736077910', 'lint-resend-calls'],
  ['41742751940', 'audit-orphan-tests'],
  ['41802620334', 'audit-direct-provider-calls'],
  ['42393944631', 'audit-orphan-tests'],
  ['42521338896', 'audit-unsafe-show-dir-listing'],
  ['42534960370', 'lint-resend-calls'],
  ['42835391352', 'audit-unsafe-show-dir-listing'],
  ['43930505585', 'audit-tests-vs-derived-data'],
];

test('script and test changes select every audit behind a lint-workflows land refusal', () => {
  for (const file of ['scripts/example.js', 'scripts/lib/example.js', 'tests/unit/example.test.mjs', 'src/example.ts']) {
    const checks = selectWorkflowChecks([file]);
    for (const [run, audit] of REFUSALS) {
      if (audit === 'audit-orphan-tests') continue; // checkTestRegistration runs it on every push
      assert.ok(checks.some(c => c.args[0] === `scripts/${audit}.js`), `${file}: ${audit} (land run ${run})`);
    }
  }
  assert.deepEqual(selectWorkflowChecks(['README.md']), []);
});

// A check red on a clean tree as checkWorkflowChecks materializes it is blind: it is red on base too, so
// every branch failure counts as pre-existing. audit-direct-provider-calls was, until it named its
// data/audit baseline in `needs` (replay of land run 41802620334 passed clean before that).
test('every code audit passes on HEAD as checkWorkflowChecks materializes it', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  let nm = null;
  for (let d = root; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'node_modules'))) { nm = path.join(d, 'node_modules'); break; }
    if (path.dirname(d) === d) break;
  }
  for (const c of CODE_AUDIT_CHECKS) {
    const dir = materializeTree(root, 'HEAD', c.needs || []);
    assert.ok(dir, 'materialized');
    try {
      if (nm) fs.symlinkSync(nm, path.join(dir, 'node_modules'), 'dir');
      const r = spawnSync(c.cmd, c.args, { cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '' } });
      assert.equal(r.status, 0, `${c.name} is red on a clean materialized tree (add what it reads to needs): ${(r.stdout + r.stderr).slice(-400)}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
});
