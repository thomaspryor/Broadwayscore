#!/usr/bin/env node
'use strict';
/**
 * apply-branch-ruleset.js — idempotently create/update the "code changes
 * require a PR" ruleset on `main` (BRO-264 Phase 2). See
 * scripts/lib/branch-ruleset-paths.js for the full rationale and the
 * restricted-path glob list.
 *
 * Idempotent: re-running with the same --enforcement finds the existing
 * ruleset by name (RULESET_NAME) and PUTs an update instead of creating a
 * duplicate. Trivially reversible: `node scripts/apply-branch-ruleset.js
 * --delete`.
 *
 * Usage:
 *   node scripts/apply-branch-ruleset.js --enforcement=evaluate   (dry-run, default)
 *   node scripts/apply-branch-ruleset.js --enforcement=active     (blocking)
 *   node scripts/apply-branch-ruleset.js --status                 (print current state)
 *   node scripts/apply-branch-ruleset.js --delete                 (remove the ruleset)
 *
 * Requires: `gh` CLI authenticated with repo admin access (rulesets require
 * admin:repo_hook / repo admin scope).
 *
 * PLATFORM BLOCKER (found live 2026-08-26, BRO-264): the `file_path_restriction`
 * rule type is a "push ruleset" rule. Attempting it against a `target:"branch"`
 * ruleset on this repo returns 422 "Invalid rule 'file_path_restriction'".
 * Attempting the correct `target:"push"` shape returns 422 with two decisive
 * errors: "Source public repos cannot have push rules" AND "Source only
 * org-owned repos can have push rules" — thomaspryor/Broadwayscore is a
 * personal-account repo, not org-owned, so push rulesets (file_path_restriction,
 * file_extension_restriction, max_file_size, max_file_path_length) are
 * UNAVAILABLE here regardless of enforcement mode. Separately, "evaluate"
 * (dry-run) enforcement itself 422s with "not supported on this plan, please
 * upgrade to Enterprise" — so even the ramp step this script offers cannot
 * run on this plan today. No ruleset was created by any of the live probes
 * that surfaced this (all failed before persisting anything) — this repo's
 * branch protection is unchanged.
 *
 * This module and buildRulesetPayload() are kept because the restricted-path
 * glob list and the file_path_restriction design are still the RIGHT design
 * (push-only semantics, doesn't touch PR merges) if this repo is ever moved
 * to an org, or if the plan is upgraded. Do not call this script expecting
 * it to succeed today — `node scripts/apply-branch-ruleset.js --enforcement=active`
 * will 422. The viable alternative for a personal repo (a `pull_request`
 * branch-target rule with a bypass actor for the Actions bot identity) needs
 * its bypass-actor mechanics verified against a live test push BEFORE it is
 * applied for real — that verification did not fit this session's remaining
 * time and is the recommended next step (see the BRO-264 Linear comment).
 */

const { execFileSync } = require('child_process');
const { buildRulesetPayload, RULESET_NAME } = require('./lib/branch-ruleset-paths.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const REPO = process.env.GH_REPO || 'thomaspryor/Broadwayscore';

function gh(args, input) {
  return execFileSync('gh', args, {
    input: input ? JSON.stringify(input) : undefined,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

function findExistingRuleset() {
  const list = JSON.parse(gh(['api', `repos/${REPO}/rulesets`]));
  return list.find((r) => r.name === RULESET_NAME) || null;
}

function parseArgs(argv) {
  const out = { enforcement: 'evaluate', status: false, delete: false };
  for (const a of argv) {
    if (a === '--status') out.status = true;
    else if (a === '--delete') out.delete = true;
    else if (a.startsWith('--enforcement=')) out.enforcement = a.split('=')[1];
  }
  return out;
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log(`Usage: node scripts/apply-branch-ruleset.js [--enforcement=evaluate|active] [--status] [--delete]

Idempotently create/update/inspect/delete the "${RULESET_NAME}" ruleset on
main. See the PLATFORM BLOCKER note at the top of this file before running
--enforcement=active or --enforcement=evaluate: as of 2026-08-26 both 422 on
this repo (push rulesets require an org-owned repo on this GitHub plan).
--status and --delete are always safe to run.`);
    return;
  }
  const { enforcement, status, delete: doDelete } = parseArgs(process.argv.slice(2));
  const existing = findExistingRuleset();

  if (status) {
    if (!existing) {
      console.log(`No ruleset named "${RULESET_NAME}" exists on ${REPO}.`);
      return;
    }
    const full = JSON.parse(gh(['api', `repos/${REPO}/rulesets/${existing.id}`]));
    console.log(JSON.stringify(full, null, 2));
    return;
  }

  if (doDelete) {
    if (!existing) {
      console.log(`No ruleset named "${RULESET_NAME}" exists on ${REPO} — nothing to delete.`);
      return;
    }
    gh(['api', '-X', 'DELETE', `repos/${REPO}/rulesets/${existing.id}`]);
    console.log(`Deleted ruleset "${RULESET_NAME}" (id ${existing.id}) on ${REPO}.`);
    return;
  }

  const payload = buildRulesetPayload({ enforcement });

  if (existing) {
    gh(['api', '-X', 'PUT', `repos/${REPO}/rulesets/${existing.id}`, '--input', '-'], payload);
    console.log(`Updated ruleset "${RULESET_NAME}" (id ${existing.id}) on ${REPO} → enforcement=${enforcement}.`);
  } else {
    const created = JSON.parse(gh(['api', '-X', 'POST', `repos/${REPO}/rulesets`, '--input', '-'], payload));
    console.log(`Created ruleset "${RULESET_NAME}" (id ${created.id}) on ${REPO} → enforcement=${enforcement}.`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { findExistingRuleset, parseArgs };
