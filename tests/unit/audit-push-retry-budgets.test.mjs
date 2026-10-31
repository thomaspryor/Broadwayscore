import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { auditWorkflowText } from '../../scripts/lib/audit-push-retry-budgets.js';

// BRO-2461. audit-imageless-scored-shows.yml must report zero mixed-safety
// bundles under the real audit-push-retry-budgets logic. The fix is NOT to
// split the "Commit audit ledger" step (BRO-2683 did; reverted in BRO-2942
// because a split lets push-with-retry.sh's `reset --hard` wipe the uncommitted
// telemetry files). The telemetry files carry apiFallbackMerge:true, so the
// single bundle is already fallback-safe. See audit-imageless-scored-shows-push.test.mjs.
const wf = '.github/workflows/audit-imageless-scored-shows.yml';
const text = fs.readFileSync(path.join(process.cwd(), wf), 'utf8');

test('audit-imageless-scored-shows.yml: mixedSafetyBundleCount is zero', () => {
  const sites = auditWorkflowText(text, 'audit-imageless-scored-shows.yml');
  assert.ok(sites.length >= 1, 'expected at least one push-with-retry call site');
  const mixed = sites.filter((s) => s.mixedSafetyBundle);
  assert.equal(
    mixed.length,
    0,
    `mixedSafetyBundleCount must be 0; got ${JSON.stringify(mixed.map((s) => ({ step: s.step, safe: s.mixedSafetyBundleSafeFiles, disq: s.mixedSafetyBundleDisqualifyingFiles })))}`,
  );
});
