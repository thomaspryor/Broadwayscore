import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectWorkflowChecks } from './land-preflight.mjs';

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
