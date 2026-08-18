// tests/unit/branch-protection.test.mjs — BRO-378 Phase 2.
//
// Two layers, deliberately kept apart:
//  1. Pure tests over scripts/setup-branch-protection.js's diff/payload logic
//     (require()'d real functions, CLAUDE.md rule 15 — no re-copied logic,
//     no network). These run everywhere, always.
//  2. A live check against `gh api repos/.../branches/main/protection` — the
//     ticket's literal acceptance bar (enforce_admins true + non-empty
//     required checks). Gated behind `gh auth status` succeeding first: the
//     CI "Unit Tests" job runs this file via the tests/unit/*.test.mjs glob
//     with no GH_TOKEN available (confirmed via plan-review, 2026-08-17), so
//     an unconditional live call would be flaky-by-construction there, not a
//     real regression signal. Skipped, not failed, when auth is unavailable —
//     same tolerant shape as tests/unit/board-probe.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { TARGET_PROTECTION, REQUIRED_CHECK_CONTEXTS, diffProtection, toPutPayload } =
  require(path.join(REPO, 'scripts/setup-branch-protection.js'));

test('target protection declares enforce_admins true and a non-empty required-checks list', () => {
  assert.equal(TARGET_PROTECTION.enforce_admins, true);
  assert.ok(Array.isArray(TARGET_PROTECTION.required_status_checks.contexts));
  assert.ok(TARGET_PROTECTION.required_status_checks.contexts.length > 0);
});

test('every required-check context name exists as a job in some workflow file', () => {
  // Guards the exact failure mode the ticket calls out: a required-check
  // context whose job gets renamed/removed strands every future PR pending
  // forever. Grep-based, not exhaustive YAML parsing — good enough to catch
  // "the job was renamed and nobody updated this list".
  const workflowsDir = path.join(REPO, '.github', 'workflows');
  const files = readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const allText = files.map((f) => readFileSync(path.join(workflowsDir, f), 'utf8')).join('\n');

  for (const context of REQUIRED_CHECK_CONTEXTS) {
    const nameLine = new RegExp(`name:\\s*${context.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
    assert.ok(nameLine.test(allText), `required-check context "${context}" is not a job name: (name:) in any .github/workflows/*.yml file`);
  }
});

test('diffProtection reports no changes when live state already matches target', () => {
  const liveEquivalent = {
    required_status_checks: { strict: false, contexts: [...REQUIRED_CHECK_CONTEXTS] },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: null,
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_conversation_resolution: { enabled: false },
    required_linear_history: { enabled: false },
    lock_branch: { enabled: false },
    allow_fork_syncing: { enabled: false },
  };
  assert.deepEqual(diffProtection(liveEquivalent, TARGET_PROTECTION), []);
});

test('diffProtection reports every field that drifts from target', () => {
  const driftedLive = {
    required_status_checks: null, // no required checks configured at all
    enforce_admins: { enabled: false },
    required_pull_request_reviews: { required_approving_review_count: 1 },
    allow_force_pushes: { enabled: true }, // drifted from target's false
    allow_deletions: { enabled: false },
    required_conversation_resolution: { enabled: false },
    required_linear_history: { enabled: false },
    lock_branch: { enabled: false },
    allow_fork_syncing: { enabled: false },
  };
  const changes = diffProtection(driftedLive, TARGET_PROTECTION);
  const fields = changes.map((c) => c.field).sort();
  assert.deepEqual(fields, ['allow_force_pushes', 'enforce_admins', 'required_pull_request_reviews', 'required_status_checks']);
});

test('diffProtection treats an unprotected branch (null) as fully drifted, not a crash', () => {
  const changes = diffProtection(null, TARGET_PROTECTION);
  assert.ok(changes.length > 0);
  assert.ok(changes.some((c) => c.field === 'enforce_admins'));
});

test('toPutPayload never sends required_pull_request_reviews truthy — the deliberate scope boundary', () => {
  // TARGET_PROTECTION.required_pull_request_reviews is null by design: this
  // repo's ~300 direct-push-to-main workflows would reject on their next run
  // if this ever flips non-null without first migrating them off direct
  // push. See the header comment in setup-branch-protection.js for the full
  // rationale and the plan-review verdict that established it.
  const payload = toPutPayload(TARGET_PROTECTION);
  assert.equal(payload.required_pull_request_reviews, null);
});

function ghAuthAvailable() {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('live: repos/thomaspryor/Broadwayscore branches/main/protection has enforce_admins true and non-empty required checks', { skip: !ghAuthAvailable() && 'gh not authenticated in this environment — CI Unit Tests job has no GH_TOKEN' }, () => {
  const out = execFileSync('gh', ['api', 'repos/thomaspryor/Broadwayscore/branches/main/protection'], { encoding: 'utf8' });
  const protection = JSON.parse(out);
  assert.equal(protection.enforce_admins && protection.enforce_admins.enabled, true, 'enforce_admins must be enabled on main');
  const contexts = (protection.required_status_checks && protection.required_status_checks.contexts) || [];
  assert.ok(contexts.length > 0, 'required_status_checks.contexts must be non-empty on main');
});
