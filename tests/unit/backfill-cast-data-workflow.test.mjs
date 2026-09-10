import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { auditWorkflowText } = require('../../scripts/lib/audit-push-retry-budgets.js');

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const WORKFLOW_FILE = 'backfill-cast-web.yml';
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', WORKFLOW_FILE);

/**
 * BRO-427: "Backfill Cast Data (Web Search)" failed 5 times in 24h, every
 * time at the "Commit and push" step, with the same signature — a git-push
 * transport HANG at push-with-retry.sh's GIT_NET_TIMEOUT_SEC cap, not a
 * rejection. Root cause: the step ran on the shared MAX_RETRIES=5/
 * PUSH_DEADLINE_SEC=240 defaults, which scripts/audit-push-retry-budgets.js
 * flags as undersized for a job with this much unused job-timeout headroom
 * (60 min timeout, ~2 min of real work). Fixed by raising MAX_RETRIES/
 * PUSH_DEADLINE_SEC/PUSH_API_FALLBACK_AFTER_ATTEMPTS to the same 25/900/3
 * combo already proven in weekly-integrity.yml (BRO-2811, 2026-09-08).
 *
 * This test reuses the audit tool's own logic (not a reimplementation) so a
 * future edit that quietly shrinks these numbers back down is caught here
 * instead of waiting for the next live incident.
 */
test('backfill-cast-web.yml "Commit and push" step is not push-retry-budget-undersized', () => {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const results = auditWorkflowText(text, WORKFLOW_FILE);
  const step = results.find((r) => r.step === 'Commit and push');

  assert.ok(step, `expected to find a "Commit and push" push-with-retry.sh call in ${WORKFLOW_FILE}`);
  assert.deepEqual(
    step.flags,
    [],
    `expected no push-retry-budget flags on "Commit and push", got: ${step.flags.join(', ')}`,
  );
});
