import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectWorkflowChecks } from './land-preflight.mjs';

// Checks job logs: 39823444261, 40082084074 and 41050140329 refused
// audit-unsafe-show-dir-listing; 41339055902 lint-resend-calls; 41538224925
// audit-alert-senders; 41802620334 audit-direct-provider-calls; 43930505585
// audit-tests-vs-derived-data. Runs 41742751940 and 42393944631 refused the
// orphan-test audit, which already has its own preflight. These are samples,
// not the complete 23-run cohort, and have not been replayed as landing trees.
test('script and test changes select the audits observed in land refusals', () => {
  for (const file of ['scripts/example.js', 'scripts/lib/example.js', 'tests/unit/example.test.mjs', 'src/example.ts']) {
    const checks = selectWorkflowChecks([file]);
    for (const script of ['audit-unsafe-show-dir-listing.js', 'lint-resend-calls.js', 'audit-alert-senders.js', 'audit-direct-provider-calls.js', 'audit-tests-vs-derived-data.js']) {
      assert.ok(checks.some(c => c.args[0] === `scripts/${script}`), `${file}: ${script}`);
    }
  }
  assert.deepEqual(selectWorkflowChecks(['README.md']), []);
});
