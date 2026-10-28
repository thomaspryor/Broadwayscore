'use strict';
// What execute-approved-fix.js refuses in a pending data/pending-fixes plan,
// checked before the plan lands, in two places that must agree:
//   - tests/unit/pending-fix-plans.test.mjs: every bro-* plan, in land.yml.
//   - scripts/lib/land-preflight.mjs: the plans a land push adds or changes,
//     in about a second instead of a refused ~40-minute land (BRO-5520: plans
//     of 41 and 49 actions against a cap of 25; BRO-4492: 41).
// Add new plan checks here, never inline in the test, so the push hook keeps up.
const path = require('path');
const { MAX_PLAN_ACTIONS } = require('./pending-fix-limits.js');
const { internalWordingIn, PUBLIC_TEXT_FIELDS } = require('./commercial-record-checks.js');
const { planStatusAction, DONE_STATUSES } = require('./plan-status.js');

const REVIEW_FILE_OPS = new Set(['delete', 'move', 'rename', 'restore']);
const isPending = (plan) => Boolean(plan) && plan.status === 'pending';

/** Shape problems the executor refuses a pending plan for. [] for a plan that is not pending. */
const STAMPED_SOURCE_FIELDS = {
  openingDate: { field: 'openingDateSource', value: 'human-correction' },
  synopsis: { field: 'synopsisSource', value: 'manual' },
};

/**
 * BRO-5886: ingest-html-handoff envelopes the executor would refuse (shape,
 * a key other than the committed one, total size).
 */
function handoffPlanProblems(name, actions, { publicKeyPath } = {}) {
  const handoff = require('./html-handoff.js');
  if (!actions.some((a) => a && a.type === handoff.ACTION_TYPE && !handoff.isScrubbed(a))) return [];
  const fs = require('fs');
  const file = publicKeyPath || handoff.PUBLIC_KEY_PATH;
  if (!fs.existsSync(file)) return [`${name}: ${handoff.ACTION_TYPE}: no committed public key; dispatch html-handoff-key.yml`];
  return handoff.planHandoffProblems(actions, { publicKeyPem: fs.readFileSync(file, 'utf8') }).map((p) => `${name}: ${p}`);
}

function planShapeProblems(name, plan) {
  if (!isPending(plan)) return [];
  const problems = [];
  if (!plan.planId) problems.push(`${name}: missing planId`);
  const actions = plan.plan && plan.plan.actions;
  if (!Array.isArray(actions)) return [...problems, `${name}: plan.actions is not an array`];
  // The executor loads data/pending-fixes/<issue_number>.json, and authors
  // dispatch with the plan's issueNumber; a split plan that kept its parent's
  // issueNumber re-ran the parent (BRO-5853). Same id both ways (BRO-5892).
  const base = path.basename(name, '.json');
  if (plan.issueNumber != null && String(plan.issueNumber) !== base) {
    problems.push(`${name}: issueNumber ${JSON.stringify(plan.issueNumber)} is not the file name; set it to "${base}" (the executor loads <issue_number>.json)`);
  }
  if (actions.length > MAX_PLAN_ACTIONS) {
    problems.push(`${name}: ${actions.length} actions (max ${MAX_PLAN_ACTIONS}); split it into ${path.basename(name, '.json')}-b.json`);
  }
  // Some applied edits stamp a companion source field (execute-approved-fix:
  // openingDate -> openingDateSource 'human-correction' via
  // stampHumanCorrectedOpeningDate; synopsis -> synopsisSource 'manual' via
  // setSynopsis). A later edit of that source field on the same show must
  // expect the stamped value, or its compare-and-set fails and the plan ends
  // 'partial' (BRO-5843).
  const stamped = new Map(); // `${showId}|${sourceField}` -> stamped value
  for (const a of actions) {
    // review-file-op paths are relative to the review-texts tree; the
    // data/review-texts/ prefix is refused as "Source not found" (BRO-5853).
    if (a && a.type === 'review-file-op') {
      for (const k of ['sourcePath', 'destPath']) {
        if (typeof a[k] === 'string' && /^(\.\/)?data\/review-texts\//.test(a[k])) {
          problems.push(`${name}: review-file-op ${k} "${a[k]}" must be relative to the review-texts tree; drop the data/review-texts/ prefix`);
        }
      }
      // The executor knows these four operations and reads the move target from
      // destPath only; anything else fails at apply time, after land (BRO-6481).
      if (!REVIEW_FILE_OPS.has(a.operation)) {
        problems.push(`${name}: review-file-op operation "${a.operation}" is not one of ${[...REVIEW_FILE_OPS].join(', ')}`);
      } else if ((a.operation === 'move' || a.operation === 'rename') && (typeof a.destPath !== 'string' || !a.destPath.trim())) {
        problems.push(`${name}: review-file-op ${a.operation} needs destPath${a.destinationPath ? ' (rename destinationPath to destPath)' : ''}`);
      }
    }
    if (!a || a.type !== 'data-edit' || a.file !== 'shows.json') continue;
    const stamp = STAMPED_SOURCE_FIELDS[a.field];
    if (stamp && a.newValue) { stamped.set(`${a.showId}|${stamp.field}`, stamp.value); continue; }
    const key = `${a.showId}|${a.field}`;
    if (stamped.has(key) && a.oldValue !== stamped.get(key)) {
      problems.push(`${name}: ${a.showId}.${a.field} expects ${JSON.stringify(a.oldValue)} but the earlier edit sets it to "${stamped.get(key)}"`);
    }
  }
  problems.push(...handoffPlanProblems(name, actions));
  return problems;
}

/**
 * BRO-5007: the commercial rules validator rolls back a public-text edit that
 * carries internal wording ("[Plausibility warning: ...]"). [] for a plan that is not pending.
 */
function planWordingProblems(name, plan) {
  const actions = isPending(plan) && plan.plan && plan.plan.actions;
  if (!Array.isArray(actions)) return [];
  const problems = [];
  for (const a of actions) {
    if (!a || a.file !== 'commercial.json' || !PUBLIC_TEXT_FIELDS.includes(a.field) || typeof a.newValue !== 'string') continue;
    const wording = internalWordingIn(a.newValue);
    if (wording) problems.push(`${name}: ${a.showSlug}.${a.field} contains "${wording}" (the validator rolls this back; keep research notes in Linear)`);
  }
  return problems;
}

/** Every problem that would stop a pending plan applying. */
function pendingPlanProblems(name, plan) {
  return [...planShapeProblems(name, plan), ...planWordingProblems(name, plan)];
}

/**
 * Not a land refusal (the test skips a plan that is not pending), but the
 * executor errors on a status it does not know (BRO-5015 typed "approved"). null when fine.
 */
function planStatusWarning(name, plan) {
  if (planStatusAction(plan && plan.status) !== 'error') return null;
  return `${name}: status ${JSON.stringify(plan && plan.status)} will not run; execute-approved-fix.js runs only a "pending" plan`;
}

/**
 * BRO-5647: only execute-approved-fix.yml finishes a session plan, and it
 * commits that status straight to main. So a land branch that adds a plan
 * already finished, or moves one off "pending", carries a local executor run
 * (or a hand edit), and the CI apply would skip it as done while changing
 * nothing. basePlan is the plan on main, null when the branch adds the file.
 */
function finishedOnBranchProblems(name, basePlan, plan) {
  // BRO-5935: withdrawing an obsolete plan is allowed without pretending it
  // ran in CI. Keep its identity and actions as evidence of what was dropped.
  if (plan && plan.status === 'superseded') {
    const problems = [];
    if (!basePlan || !['pending', 'partial', 'validation-failed', 'superseded'].includes(basePlan.status)) {
      problems.push(`${name}: superseded must withdraw an existing unresolved plan`);
    }
    if (typeof plan.supersededReason !== 'string' || !plan.supersededReason.trim() ||
        typeof plan.supersededAt !== 'string' || Number.isNaN(Date.parse(plan.supersededAt))) {
      problems.push(`${name}: superseded needs a dated supersededAt and a nonempty supersededReason explaining the current-data evidence`);
    }
    if (basePlan && (basePlan.planId !== plan.planId || basePlan.issueNumber !== plan.issueNumber ||
        JSON.stringify(basePlan.plan) !== JSON.stringify(plan.plan))) {
      problems.push(`${name}: superseding must preserve the original plan identity and actions`);
    }
    return problems;
  }
  if (!plan || !DONE_STATUSES.has(plan.status)) return [];
  if (basePlan && !isPending(basePlan)) return [];
  const how = basePlan ? 'moves it from "pending" to' : 'adds it as';
  return [`${name}: this branch ${how} "${plan.status}", which only a CI run of execute-approved-fix.yml writes (a local executor run does it too), so the CI apply would skip it as done and change nothing; set status back to "pending" and drop executedAt, results, rejectedAt and executedIn, or delete the file to withdraw the plan`];
}

/** A plan whose status a local executor run wrote (it tags executedIn since BRO-5647). [] otherwise. */
function localRunProblems(name, plan) {
  if (!plan || plan.executedIn !== 'local') return [];
  return [`${name}: status "${plan.status}" was written by a local execute-approved-fix run (executedIn: local), so the CI apply would skip it as done; set status back to "pending" and drop executedAt, results, rejectedAt and executedIn`];
}

module.exports = { handoffPlanProblems, pendingPlanProblems, planShapeProblems, planWordingProblems, planStatusWarning, finishedOnBranchProblems, localRunProblems };
