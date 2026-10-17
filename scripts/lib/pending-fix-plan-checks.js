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
const { planStatusAction } = require('./plan-status.js');

const isPending = (plan) => Boolean(plan) && plan.status === 'pending';

/** Shape problems the executor refuses a pending plan for. [] for a plan that is not pending. */
function planShapeProblems(name, plan) {
  if (!isPending(plan)) return [];
  const problems = [];
  if (!plan.planId) problems.push(`${name}: missing planId`);
  const actions = plan.plan && plan.plan.actions;
  if (!Array.isArray(actions)) return [...problems, `${name}: plan.actions is not an array`];
  if (actions.length > MAX_PLAN_ACTIONS) {
    problems.push(`${name}: ${actions.length} actions (max ${MAX_PLAN_ACTIONS}); split it into ${path.basename(name, '.json')}-b.json`);
  }
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

module.exports = { pendingPlanProblems, planShapeProblems, planWordingProblems, planStatusWarning };
