// tests/unit/branch-protection.test.mjs — BRO-378 Phase 2.
//
// Three layers:
//  1. Pure tests over scripts/setup-branch-protection.js's diff/payload logic
//     against SAFE_TARGET (require()'d real functions, CLAUDE.md rule 15 —
//     no re-copied logic, no network). These run everywhere, always, and
//     describe what this script actually applies today.
//  2. Structural tests over FULL_ENFORCEMENT_TARGET — the aspirational,
//     NOT-currently-safe config the ticket asked for. Verified as data, never
//     applied by a test.
//  3. A live check against `gh api repos/.../branches/main/protection` — the
//     ticket's literal acceptance bar (enforce_admins true + non-empty
//     required checks). This is EXPECTED TO FAIL against live main today —
//     see scripts/setup-branch-protection.js's header comment for why: this
//     exact config was applied live and immediately broke a real production
//     workflow's direct push (GH006 "Required status check ... is expected",
//     run 32087193625), then was reverted. Left un-gamed on purpose — a test
//     that's made to pass by applying a config already proven to break
//     production would be worse than an honest failure. Gated behind
//     `gh auth status` succeeding first: the CI "Unit Tests" job has no
//     GH_TOKEN (confirmed via plan-review, 2026-08-17), so it's skipped
//     there, not failed — same tolerant shape as tests/unit/board-probe.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { SAFE_TARGET, FULL_ENFORCEMENT_TARGET, REQUIRED_CHECK_CONTEXTS, diffProtection, toPutPayload } =
  require(path.join(REPO, 'scripts/setup-branch-protection.js'));

test('SAFE_TARGET (what this script actually applies) has no required checks and enforce_admins off', () => {
  // Deliberately the opposite of the ticket's literal ask — see the big
  // header comment in setup-branch-protection.js for the empirical reason.
  assert.equal(SAFE_TARGET.required_status_checks, null);
  assert.equal(SAFE_TARGET.enforce_admins, false);
  assert.equal(SAFE_TARGET.required_pull_request_reviews, null);
});

test('FULL_ENFORCEMENT_TARGET declares enforce_admins true and a non-empty required-checks list', () => {
  // This is the config the ticket's acceptance test wants live on main. It
  // exists here as documented, reviewable data for a future fleet migration
  // — main() refuses to --apply it (see main()'s full-enforcement guard).
  assert.equal(FULL_ENFORCEMENT_TARGET.enforce_admins, true);
  assert.ok(Array.isArray(FULL_ENFORCEMENT_TARGET.required_status_checks.contexts));
  assert.ok(FULL_ENFORCEMENT_TARGET.required_status_checks.contexts.length > 0);
});

test('every required-check context name exists as a job in some workflow file', () => {
  // Guards the exact failure mode the ticket calls out: a required-check
  // context whose job gets renamed/removed strands every future PR pending
  // forever. Grep-based, not exhaustive YAML parsing — good enough to catch
  // "the job was renamed and nobody updated this list". Applies to
  // REQUIRED_CHECK_CONTEXTS regardless of which target ends up shipping it.
  const workflowsDir = path.join(REPO, '.github', 'workflows');
  const files = readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const allText = files.map((f) => readFileSync(path.join(workflowsDir, f), 'utf8')).join('\n');

  for (const context of REQUIRED_CHECK_CONTEXTS) {
    const escaped = context.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Anchored to 4-space indentation — this repo's `jobs: -> <job-id>: ->
    // name:` nesting always lands the job's own `name:` at exactly that
    // depth (verified against test.yml). Anything less specific also matches
    // a step's `- name:` (6+ spaces, leading dash) or the workflow's
    // top-level `name:` (0 spaces) — neither is a check-run context GitHub
    // will ever report, so matching either is false confidence, not safety.
    const jobNameLine = new RegExp(`^ {4}name:\\s*["']?${escaped}["']?\\s*$`, 'm');
    assert.ok(jobNameLine.test(allText), `required-check context "${context}" is not a job-level name: (4-space indent) in any .github/workflows/*.yml file`);
  }
});

test('diffProtection reports no changes when live state already matches SAFE_TARGET', () => {
  const liveEquivalent = {
    required_status_checks: null,
    enforce_admins: { enabled: false },
    required_pull_request_reviews: null,
    restrictions: null,
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_conversation_resolution: { enabled: false },
    required_linear_history: { enabled: false },
    lock_branch: { enabled: false },
    allow_fork_syncing: { enabled: false },
    block_creations: { enabled: false },
  };
  assert.deepEqual(diffProtection(liveEquivalent, SAFE_TARGET), []);
});

test('diffProtection reports every field that drifts from SAFE_TARGET', () => {
  const driftedLive = {
    required_status_checks: { strict: false, contexts: ['some-check'] }, // drifted from SAFE_TARGET's null
    enforce_admins: { enabled: true }, // drifted from SAFE_TARGET's false
    required_pull_request_reviews: { required_approving_review_count: 1 },
    restrictions: null,
    allow_force_pushes: { enabled: true }, // drifted from SAFE_TARGET's false
    allow_deletions: { enabled: false },
    required_conversation_resolution: { enabled: false },
    required_linear_history: { enabled: false },
    lock_branch: { enabled: false },
    allow_fork_syncing: { enabled: false },
    block_creations: { enabled: false },
  };
  const changes = diffProtection(driftedLive, SAFE_TARGET);
  const fields = changes.map((c) => c.field).sort();
  assert.deepEqual(fields, ['allow_force_pushes', 'enforce_admins', 'required_pull_request_reviews', 'required_status_checks']);
});

test('diffProtection flags a live push-allowlist as a destructive change, and does not silently apply it', () => {
  // The bug a ship-check reviewer caught (2026-08-18): a target's
  // restrictions:null is unconditionally sent by toPutPayload(), so an
  // existing restrictions allowlist would be silently deleted on --apply
  // unless the diff surfaces it first.
  const liveWithRestrictions = {
    required_status_checks: null,
    enforce_admins: { enabled: false },
    required_pull_request_reviews: null,
    restrictions: { users: [{ login: 'some-bot' }], teams: [], apps: [] },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_conversation_resolution: { enabled: false },
    required_linear_history: { enabled: false },
    lock_branch: { enabled: false },
    allow_fork_syncing: { enabled: false },
    block_creations: { enabled: false },
  };
  const changes = diffProtection(liveWithRestrictions, SAFE_TARGET);
  const restrictionsChange = changes.find((c) => c.field === 'restrictions');
  assert.ok(restrictionsChange, 'a live restrictions allowlist must show up as a diffed field');
  assert.equal(restrictionsChange.destructive, true);
  assert.equal(restrictionsChange.from, true);
  assert.equal(restrictionsChange.to, false);
});

test('diffProtection treats an unprotected branch (null) as fully drifted, not a crash', () => {
  const changes = diffProtection(null, FULL_ENFORCEMENT_TARGET);
  assert.ok(changes.length > 0);
  assert.ok(changes.some((c) => c.field === 'enforce_admins'));
});

test('toPutPayload never sends required_pull_request_reviews truthy for either target — the deliberate scope boundary', () => {
  // This repo's ~300 direct-push-to-main workflows would reject on their
  // next run if this ever flips non-null without first migrating them off
  // direct push. See setup-branch-protection.js's header for the full
  // rationale and the plan-review verdict that established it.
  assert.equal(toPutPayload(SAFE_TARGET).required_pull_request_reviews, null);
  assert.equal(toPutPayload(FULL_ENFORCEMENT_TARGET).required_pull_request_reviews, null);
});

test('toPutPayload never sends block_creations — GitHub 500s on it', () => {
  // Confirmed live against this repo, 2026-08-18: including block_creations
  // in the PUT body returns a bare 500 with an empty response.
  assert.equal('block_creations' in toPutPayload(SAFE_TARGET), false);
  assert.equal('block_creations' in toPutPayload(FULL_ENFORCEMENT_TARGET), false);
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
  // This is the ticket's literal acceptance bar, run against real live
  // state, un-gamed. It is EXPECTED TO FAIL until a fleet migration off
  // direct-push-to-main makes FULL_ENFORCEMENT_TARGET safe to --apply — see
  // scripts/setup-branch-protection.js's header comment for the empirical
  // GH006 production break this would otherwise reintroduce.
  const out = execFileSync('gh', ['api', 'repos/thomaspryor/Broadwayscore/branches/main/protection'], { encoding: 'utf8' });
  const protection = JSON.parse(out);
  assert.equal(protection.enforce_admins && protection.enforce_admins.enabled, true, 'enforce_admins must be enabled on main');
  const contexts = (protection.required_status_checks && protection.required_status_checks.contexts) || [];
  assert.ok(contexts.length > 0, 'required_status_checks.contexts must be non-empty on main');
});
