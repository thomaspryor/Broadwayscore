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
 * WHY NOT `required_pull_request_reviews` (the ticket's literal "required
 * PR" ask): this repo has ~300 .github/workflows/*.yml files that
 * `git push origin main` directly (autonomous-merge, deploy-watermark,
 * rebuild-reviews, audit/backfill crons — CLAUDE.md's entire "Git Workflow"
 * section describes this as the repo's operating model, not an exception to
 * it). `required_pull_request_reviews` rejects ANY direct push — including
 * every one of those workflows' default GITHUB_TOKEN pushes, which are
 * "write", not "admin", permission and were never exempted by
 * `enforce_admins`. Turning it on would break the deploy pipeline and every
 * automated data-write path on their next scheduled run. Six independent plan
 * reviewers (Codex + 4 Claude agents + Gemini, 2026-08-17) confirmed this by
 * reading the actual workflow permission blocks — see the plan-review verdict
 * in .claude/review-verdicts.jsonl.
 *
 * WHAT THIS ACTUALLY BUYS: `required_status_checks` and `enforce_admins`
 * alone do NOT stop a bad direct push from landing on main — classic GitHub
 * branch protection's required-status-checks has only ever gated the
 * "Merge pull request" button/API, never a raw `git push` to the branch
 * (long-standing GitHub platform behavior, and consistent with the empirical
 * finding in the memory file above: commits landed on main in the past with
 * failing/cancelled required checks). What this DOES buy: force-push and
 * branch-deletion protection now also applies to admin-scoped tokens (not
 * just non-admins), and any FUTURE pull request against main is required to
 * have TARGET.requiredCheck green before merge — useful once/if any workflow
 * moves to a PR-based flow. Closing the actual "red code lands via direct
 * push" gap the ticket names requires either migrating the ~300 direct-push
 * workflows to a PR+bypass-actor flow (GitHub Rulesets, not this classic API)
 * or accepting that CLAUDE.md's own review-gate.mjs / pre-push hooks are the
 * real line of defense for that path today. That tradeoff is recorded as a
 * DECISION NEEDED on BRO-378, not decided by this script.
 *
 * Usage:
 *   node scripts/setup-branch-protection.js            # print live vs target diff, exit
 *   node scripts/setup-branch-protection.js --apply     # apply target to origin main
 *   node scripts/setup-branch-protection.js --repo=owner/name --branch=main
 */

'use strict';

const { execFileSync } = require('node:child_process');

const DEFAULT_REPO = 'thomaspryor/Broadwayscore';
const DEFAULT_BRANCH = 'main';

// The one check every PR against main can always earn: "Lint Workflows" is
// test.yml's first job, has no `if:` path-based gate, and test.yml's
// `pull_request` trigger (unlike its `push` trigger) carries no `paths:`
// filter — so it runs on literally every PR. Reusing it (CLAUDE.md "reuse
// first") avoids inventing and maintaining a second always-run workflow, and
// avoids the exact failure mode the ticket warns about: a required-check
// context whose job stops existing strands every future PR pending forever.
const REQUIRED_CHECK_CONTEXTS = ['Lint Workflows'];

const TARGET_PROTECTION = {
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

/**
 * Pure diff between GitHub's live protection GET response and TARGET_PROTECTION.
 * Only compares the fields TARGET_PROTECTION declares — a live field this
 * script doesn't manage (e.g. a future GitHub addition) is left alone, never
 * flagged as drift.
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
  // toPutPayload() always sends `restrictions: null` (this script's declared
  // target), so if a live restriction exists it MUST show up here — silently
  // dropping it on --apply was a real gap a reviewer caught (BRO-378 ship
  // review, 2026-08-18). main() below refuses to apply this specific change
  // without an explicit flag.
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
 * both the GET response and TARGET_PROTECTION's diff-friendly shape.
 *
 * `block_creations` is deliberately OMITTED here: unlike every other field
 * TARGET_PROTECTION declares, GitHub's branch-protection PUT does not accept
 * it in the body — including it returns a bare 500 with an empty response
 * body (confirmed live against this repo, 2026-08-18; GET still reports it,
 * which is why diffProtection() still tracks it). If GitHub's API ever
 * starts accepting it, the empty-payload 500 will surface immediately as a
 * PUT failure, not a silent no-op — nothing here is relying on it working.
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
  const args = { apply: false, repo: DEFAULT_REPO, branch: DEFAULT_BRANCH, allowRestrictionsChange: false };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--allow-restrictions-change') args.allowRestrictionsChange = true;
    else if (arg.startsWith('--repo=')) args.repo = arg.slice('--repo='.length);
    else if (arg.startsWith('--branch=')) args.branch = arg.slice('--branch='.length);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const current = ghApiGet(args.repo, args.branch);
  const changes = diffProtection(current, TARGET_PROTECTION);

  if (changes.length === 0) {
    console.log(`${args.repo}#${args.branch}: protection already matches target. No changes.`);
    return;
  }

  console.log(`${args.repo}#${args.branch}: ${changes.length} field(s) differ from target:`);
  for (const c of changes) {
    console.log(`  ${c.field}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}${c.destructive ? '  [DESTRUCTIVE]' : ''}`);
  }

  const destructive = changes.find((c) => c.destructive && c.from === true && c.to === false);
  if (destructive && !args.allowRestrictionsChange) {
    console.error(`\nRefusing to apply: this repo currently has a "${destructive.field}" push allowlist configured, and this script's target has none. Applying would silently delete it. Re-run with --allow-restrictions-change if that's actually intended.`);
    process.exitCode = 1;
    return;
  }

  if (!args.apply) {
    console.log('\nDry run — no changes applied. Re-run with --apply to PUT the target state.');
    return;
  }

  const result = ghApiPut(args.repo, args.branch, toPutPayload(TARGET_PROTECTION));
  console.log('\nApplied. Live enforce_admins:', result.enforce_admins && result.enforce_admins.enabled);
  console.log('Live required_status_checks contexts:', (result.required_status_checks && result.required_status_checks.contexts) || []);
}

module.exports = { TARGET_PROTECTION, REQUIRED_CHECK_CONTEXTS, diffProtection, toPutPayload };

if (require.main === module) {
  main();
}
