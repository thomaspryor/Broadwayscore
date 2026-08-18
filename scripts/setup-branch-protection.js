#!/usr/bin/env node
/**
 * scripts/setup-branch-protection.js — declarative source of truth for main's
 * GitHub branch protection (BRO-378 "Phase 2").
 *
 * Before this script, main's protection existed only as live GitHub state,
 * changed by hand at some point in the past and remembered only in
 * memory/feedback_branch_protection_direct_push.md — no diff, no rollback
 * command, no record of what was applied or why. This script makes the
 * target state a reviewable object in the repo and the apply step
 * idempotent: GET current -> diff -> print -> PUT only with --apply.
 *
 * ============================================================================
 * THE EMPIRICAL FINDING THAT SHAPED THIS FILE (2026-08-18, BRO-378):
 * ============================================================================
 * The ticket's literal ask was `required_pull_request_reviews` + `enforce_
 * admins` + `required_status_checks`. Six plan reviewers (Codex + 4 Claude
 * agents + Gemini) agreed that would break this repo's ~300 direct-push-to-
 * main workflows outright, since required_pull_request_reviews rejects any
 * push that isn't a PR merge. The plan that shipped instead ("Plan B") was
 * `enforce_admins: true` + `required_status_checks` (an always-run check)
 * WITHOUT required_pull_request_reviews — believed safe because the prior
 * memory file (feedback_branch_protection_direct_push.md, dated 2026-05-23)
 * recorded that required_status_checks only ever gated PR merges, never a
 * raw `git push`.
 *
 * That memory was WRONG, or at least incomplete for this case. Plan B was
 * applied live to main at 2026-08-18T01:08:36Z and immediately verified
 * against a real production workflow (Update Deploy Watermark, dispatched
 * run 32087193625): its direct push was rejected outright —
 *
 *   remote: error: GH006: Protected branch update failed for refs/heads/main.
 *   remote: - Required status check "Lint Workflows" is expected.
 *
 * — on all 3 retry attempts, confirming this is not a transient failure.
 * Root cause: `required_status_checks` requires the pushed commit's exact SHA
 * to already have a passing check run recorded. A commit made directly (not
 * via a branch that already had CI run against it) can never satisfy that —
 * GitHub rejects it before any check even has a chance to run, independent of
 * `enforce_admins` or the identity doing the push. Protection was reverted to
 * its original state (enforce_admins:false, no required_status_checks) within
 * 3 minutes of the failure; the deploy-watermark bot's own retry-with-rebase
 * discarded its local commit safely, no data was lost.
 *
 * CONCLUSION: there is no configuration of classic GitHub branch protection
 * that (a) has a non-empty `required_status_checks` list AND (b) leaves this
 * repo's direct-push architecture working. The ticket's acceptance test
 * (enforce_admins true + non-empty required checks) is therefore NOT
 * satisfiable without breaking production, full stop — not a matter of
 * finding the right flag combination. Closing the actual gap the ticket names
 * ("direct pushes are not gated by required checks") requires migrating the
 * ~300 workflows off direct push (GitHub Rulesets with a bypass-actor list is
 * the likely mechanism, a different API from this ticket's acceptance test,
 * and its own multi-session project) — or accepting that CLAUDE.md's
 * review-gate.mjs / pre-push hooks are the real enforcement layer for that
 * path today. Recorded as a DECISION NEEDED on BRO-378, not decided here.
 * ============================================================================
 *
 * WHAT THIS SCRIPT ACTUALLY MANAGES TODAY: SAFE_TARGET below — force-push and
 * branch-deletion protection (already the live baseline; this script makes it
 * reviewable and idempotent, changes nothing functionally). enforce_admins is
 * left false: with no required_status_checks or required_pull_request_reviews
 * in force, enforce_admins has nothing to enforce (a bare `enforce_admins:
 * true` here would be a no-op flag, not real hardening).
 *
 * FULL_ENFORCEMENT_TARGET is kept in the codebase as the aspirational,
 * NOT-currently-safe target for use only after a fleet migration off direct
 * push. `--target=full-enforcement` diffs against it (dry-run only by
 * default — see main()); applying it against the current fleet WILL repeat
 * the outage documented above.
 *
 * Usage:
 *   node scripts/setup-branch-protection.js                         # diff SAFE_TARGET, dry run
 *   node scripts/setup-branch-protection.js --apply                 # apply SAFE_TARGET
 *   node scripts/setup-branch-protection.js --target=full-enforcement   # diff only — NOT safe to --apply today, see header
 *   node scripts/setup-branch-protection.js --repo=owner/name --branch=main
 */

'use strict';

const { execFileSync } = require('node:child_process');

const DEFAULT_REPO = 'thomaspryor/Broadwayscore';
const DEFAULT_BRANCH = 'main';

// The one check every PR against main can always earn, IF a required-checks
// list is ever safely usable again: "Lint Workflows" is test.yml's first
// job, has no `if:` path-based gate, and test.yml's `pull_request` trigger
// (unlike its `push` trigger) carries no `paths:` filter — runs on every PR.
const REQUIRED_CHECK_CONTEXTS = ['Lint Workflows'];

// What this script applies today. Matches the live baseline captured before
// BRO-378 touched anything — --apply against current live state is a no-op.
const SAFE_TARGET = {
  required_status_checks: null,
  enforce_admins: false,
  required_pull_request_reviews: null,
  restrictions: null,
  allow_force_pushes: false,
  allow_deletions: false,
  required_conversation_resolution: false,
  required_linear_history: false,
  lock_branch: false,
  allow_fork_syncing: false,
  block_creations: false,
};

// NOT SAFE TO APPLY against the current direct-push fleet — see the header
// comment's empirical finding. Kept as the documented target for AFTER a
// fleet migration off direct pushes to main.
const FULL_ENFORCEMENT_TARGET = {
  required_status_checks: {
    strict: false,
    contexts: REQUIRED_CHECK_CONTEXTS,
  },
  enforce_admins: true,
  required_pull_request_reviews: null,
  restrictions: null,
  allow_force_pushes: false,
  allow_deletions: false,
  required_conversation_resolution: false,
  required_linear_history: false,
  lock_branch: false,
  allow_fork_syncing: false,
  block_creations: false,
};

const TARGETS = { safe: SAFE_TARGET, 'full-enforcement': FULL_ENFORCEMENT_TARGET };

/**
 * Pure diff between GitHub's live protection GET response and a target
 * object (SAFE_TARGET or FULL_ENFORCEMENT_TARGET's shape). Only compares the
 * fields the target declares — a live field this script doesn't manage (e.g.
 * a future GitHub addition) is left alone, never flagged as drift.
 */
function diffProtection(current, target) {
  const changes = [];
  const currentChecks = current && current.required_status_checks
    ? { strict: !!current.required_status_checks.strict, contexts: current.required_status_checks.contexts || [] }
    : null;
  const targetChecks = target.required_status_checks;
  if (JSON.stringify(currentChecks) !== JSON.stringify(targetChecks)) {
    changes.push({ field: 'required_status_checks', from: currentChecks, to: targetChecks });
  }

  const currentEnforceAdmins = !!(current && current.enforce_admins && current.enforce_admins.enabled);
  if (currentEnforceAdmins !== target.enforce_admins) {
    changes.push({ field: 'enforce_admins', from: currentEnforceAdmins, to: target.enforce_admins });
  }

  const currentPrReviews = current && current.required_pull_request_reviews ? true : false;
  const targetPrReviews = target.required_pull_request_reviews !== null;
  if (currentPrReviews !== targetPrReviews) {
    changes.push({ field: 'required_pull_request_reviews', from: currentPrReviews, to: targetPrReviews });
  }

  // This script's scope is force-push/deletion/enforce_admins/required-checks
  // — it never intends to touch a push allowlist (`restrictions`). But
  // GitHub's PUT is not a partial update: omitting `restrictions` clears it.
  // toPutPayload() always sends `restrictions: null` (both targets' declared
  // value), so if a live restriction exists it MUST show up here — silently
  // dropping it on --apply was a real gap a ship-check reviewer caught
  // (2026-08-18). main() refuses to apply this specific change without an
  // explicit flag.
  const currentHasRestrictions = !!(current && current.restrictions);
  const targetHasRestrictions = target.restrictions !== null;
  if (currentHasRestrictions !== targetHasRestrictions) {
    changes.push({ field: 'restrictions', from: currentHasRestrictions, to: targetHasRestrictions, destructive: true });
  }

  for (const field of ['allow_force_pushes', 'allow_deletions', 'required_conversation_resolution', 'required_linear_history', 'lock_branch', 'allow_fork_syncing', 'block_creations']) {
    const currentVal = !!(current && current[field] && current[field].enabled);
    const targetVal = target[field];
    if (currentVal !== targetVal) {
      changes.push({ field, from: currentVal, to: targetVal });
    }
  }

  return changes;
}

/**
 * The PUT body GitHub's protection endpoint expects — a different shape from
 * both the GET response and a target object's diff-friendly shape.
 *
 * `block_creations` is deliberately OMITTED here: unlike every other field a
 * target declares, GitHub's branch-protection PUT does not accept it in the
 * body — including it returns a bare 500 with an empty response body
 * (confirmed live against this repo, 2026-08-18). GET still reports it,
 * which is why diffProtection() still tracks it. If GitHub's API ever starts
 * accepting it, the empty-payload 500 will surface immediately as a PUT
 * failure, not a silent no-op.
 */
function toPutPayload(target) {
  return {
    required_status_checks: target.required_status_checks,
    enforce_admins: target.enforce_admins,
    required_pull_request_reviews: target.required_pull_request_reviews,
    restrictions: target.restrictions,
    allow_force_pushes: target.allow_force_pushes,
    allow_deletions: target.allow_deletions,
    required_conversation_resolution: target.required_conversation_resolution,
    required_linear_history: target.required_linear_history,
    lock_branch: target.lock_branch,
    allow_fork_syncing: target.allow_fork_syncing,
  };
}

function ghApiGet(repo, branch) {
  try {
    const out = execFileSync('gh', ['api', `repos/${repo}/branches/${branch}/protection`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out);
  } catch (err) {
    const stderr = String(err.stderr || err.message || '');
    if (stderr.includes('Branch not protected')) return null;
    throw new Error(`gh api GET failed: ${stderr.slice(0, 500)}`);
  }
}

function ghApiPut(repo, branch, payload) {
  const out = execFileSync(
    'gh',
    ['api', '-X', 'PUT', `repos/${repo}/branches/${branch}/protection`, '--input', '-'],
    { encoding: 'utf8', input: JSON.stringify(payload), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  return JSON.parse(out);
}

function parseArgs(argv) {
  const args = { apply: false, repo: DEFAULT_REPO, branch: DEFAULT_BRANCH, allowRestrictionsChange: false, target: 'safe' };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--allow-restrictions-change') args.allowRestrictionsChange = true;
    else if (arg.startsWith('--repo=')) args.repo = arg.slice('--repo='.length);
    else if (arg.startsWith('--branch=')) args.branch = arg.slice('--branch='.length);
    else if (arg.startsWith('--target=')) args.target = arg.slice('--target='.length);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = TARGETS[args.target];
  if (!target) {
    console.error(`Unknown --target=${args.target}. Valid: ${Object.keys(TARGETS).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  if (args.target === 'full-enforcement' && args.apply) {
    console.error('Refusing --apply with --target=full-enforcement: this is NOT safe against the current direct-push fleet — see the empirical GH006 finding in this file\'s header. Dry-run only.');
    process.exitCode = 1;
    return;
  }

  const current = ghApiGet(args.repo, args.branch);
  const changes = diffProtection(current, target);

  if (changes.length === 0) {
    console.log(`${args.repo}#${args.branch}: protection already matches --target=${args.target}. No changes.`);
    return;
  }

  console.log(`${args.repo}#${args.branch}: ${changes.length} field(s) differ from --target=${args.target}:`);
  for (const c of changes) {
    console.log(`  ${c.field}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}${c.destructive ? '  [DESTRUCTIVE]' : ''}`);
  }

  const destructive = changes.find((c) => c.destructive && c.from === true && c.to === false);
  if (destructive && !args.allowRestrictionsChange) {
    console.error(`\nRefusing to apply: this repo currently has a "${destructive.field}" push allowlist configured, and the target has none. Applying would silently delete it. Re-run with --allow-restrictions-change if that's actually intended.`);
    process.exitCode = 1;
    return;
  }

  if (!args.apply) {
    console.log('\nDry run — no changes applied. Re-run with --apply to PUT the target state.');
    return;
  }

  const result = ghApiPut(args.repo, args.branch, toPutPayload(target));
  console.log('\nApplied. Live enforce_admins:', result.enforce_admins && result.enforce_admins.enabled);
  console.log('Live required_status_checks contexts:', (result.required_status_checks && result.required_status_checks.contexts) || []);
}

module.exports = { SAFE_TARGET, FULL_ENFORCEMENT_TARGET, REQUIRED_CHECK_CONTEXTS, diffProtection, toPutPayload };

if (require.main === module) {
  main();
}
