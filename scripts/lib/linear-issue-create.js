/**
 * linear-issue-create.js — the single chokepoint for filing a NEW Linear
 * issue. Everything else that touches Linear issue creation should go
 * through this, the way scripts/lib/owner-alert-router.js's dispatchCard()
 * is the one chokepoint all 85 alert call sites route through.
 *
 * Why this exists: on 2026-08-12 a session filed 8 Linear issues
 * (BRO-274..282) with a throwaway hand-rolled `issueCreate` GraphQL call in a
 * scratch script, and zero were dispatched — nothing enforced a decision
 * because there was no shared entry point to enforce it AT. A helper nobody
 * is forced to use changes nothing, so scripts/audit-linear-issuecreate-
 * chokepoint.js CI-gates any `issueCreate`/api.linear.app call outside this
 * file (and scripts/lib/linear-client.js itself).
 *
 * Scoped narrowly to issue CREATION with the required dispatch/park
 * disposition (card #1310). The larger, separately-tracked plan (see
 * memory/project_linear_migration_decision.md) repoints routeAlert()'s
 * dispatchCard() at Linear via an injectable-client `scripts/lib/linear.js`
 * — when that lands, this file's createLinearIssue() is the natural thing
 * for it to call, not something it needs to replace.
 */

'use strict';

const linear = require('./linear-client');
const { resolveDisposition } = require('./card-disposition');
const { checkIntake, recordCreated, ENFORCE } = require('./intake-breaker');

const USAGE_LIMIT_MESSAGE =
  'Linear issue creation refused: USAGE_LIMIT_EXCEEDED — the workspace is at (or near) the ' +
  'free-tier 250-issue cap. This is a hard failure, not a warning: archive/close stale issues ' +
  'before filing more (BRO-10 tracks the plan decision).';

function isUsageLimitExceeded(err) {
  if (Array.isArray(err && err.linearErrors)) {
    if (err.linearErrors.some((e) => e && e.extensions && e.extensions.code === 'USAGE_LIMIT_EXCEEDED')) {
      return true;
    }
  }
  return /USAGE_LIMIT_EXCEEDED|usage limit/i.test(String((err && err.message) || ''));
}

// Picks a team workflow state for the given disposition mode. `states` is
// Linear's own {id,name,type} list (type ∈ backlog/unstarted/started/
// completed/canceled) — we never invent our own status vocabulary here.
//   'park'     → a state that does NOT read as active work (backlog, or
//                unstarted as a fallback if the team has no backlog state).
//   'dispatch' → 'unstarted' (Todo), not 'started': nothing is actually
//                running yet at issue-creation time (bsc-next.js cannot
//                resolve a Linear issue id yet — task #1303, in flight
//                separately, is building that). Marking it 'started' here
//                would itself be a new silent-third-state wearing a
//                different label.
function pickStateForMode(states, mode) {
  // getTeam() returns the raw GraphQL connection shape ({ nodes: [...] }),
  // not a bare array — normalize both so this works with either. Shipped
  // broken (states.find is not a function) on every create until 2026-08-12.
  const list = Array.isArray(states) ? states : (states && states.nodes) || [];
  const byType = (type) => list.find((s) => s && s.type === type);
  if (mode === 'park') {
    const state = byType('backlog') || byType('unstarted');
    if (!state) {
      throw new Error(
        `linear-issue-create: no 'backlog' or 'unstarted' workflow state found on this team — cannot ` +
        `file a parked issue that doesn't read as in-progress. States seen: ${
          list.map((s) => `${s.name}(${s.type})`).join(', ') || '(none)'
        }`
      );
    }
    return state;
  }
  const state = byType('unstarted');
  if (!state) {
    throw new Error(
      `linear-issue-create: no 'unstarted' workflow state found on this team for --dispatch. ` +
      `States seen: ${list.map((s) => `${s.name}(${s.type})`).join(', ') || '(none)'}`
    );
  }
  return state;
}

/**
 * @param {object} p
 * @param {string} p.title
 * @param {string} p.description
 * @param {boolean} [p.dispatch]
 * @param {string} [p.park] reason, required with park, >= MIN_PARK_REASON_LENGTH chars
 * @param {number} [p.priority] Linear priority 0-4
 * @param {string} [p.projectId]
 * @returns {Promise<{issue: object, mode: 'dispatch'|'park', stateName: string}>}
 */
async function createLinearIssue({ title, description, dispatch, park, priority, projectId }) {
  const disposition = resolveDisposition({ dispatch, park });
  if (!disposition.ok) {
    const err = new Error(disposition.message);
    err.dispositionReason = disposition.reason;
    throw err;
  }

  // Storm breaker (flow audit 2026-08-12: real intake 34.3/day vs burn-down
  // 5.7/day, and NOTHING bounded creation anywhere). Sized above a normal day,
  // so this is inert in ordinary use and only stops a runaway filer. Checked
  // here because this is the one chokepoint every scripted filer goes through;
  // issues the owner files in the Linear app never reach this code and are
  // deliberately unaffected.
  // OBSERVE-ONLY: warns, never throws. Codex review established that a refusal
  // here makes owner-alert-router LOSE the alert outright — it catches the
  // failure, returns {ok:false}, and neither queues a digest row nor sends a
  // fallback (owner-alert-router.js:284-305, :535-561). Silently eating alerts is
  // worse than an over-long list. ENFORCE flips to true only once that drop path
  // has a fallback; see intake-breaker.js's header.
  const breaker = checkIntake();
  if (!breaker.allow) {
    console.warn(`[intake-breaker] ${breaker.reason}`);
    if (ENFORCE) {
      const err = new Error(breaker.reason);
      err.intakeBreaker = breaker;
      throw err;
    }
  }

  const team = await linear.getTeam();
  const state = pickStateForMode(team.states, disposition.mode);

  const finalDescription =
    disposition.mode === 'park' ? `PARKED: ${disposition.reason}\n\n${description || ''}`.trim() : (description || '');

  let issue;
  try {
    issue = await linear.createIssue({
      teamId: team.id,
      title,
      description: finalDescription,
      priority,
      stateId: state.id,
      projectId,
    });
  } catch (err) {
    if (isUsageLimitExceeded(err)) {
      const loud = new Error(USAGE_LIMIT_MESSAGE);
      loud.cause = err;
      throw loud;
    }
    throw err;
  }

  // Record AFTER the create succeeds, so a failed API call never consumes
  // breaker budget. recordCreated never throws — telemetry must not turn a
  // successful create into a reported failure.
  recordCreated({ identifier: issue?.identifier, title });

  return { issue, mode: disposition.mode, stateName: state.name };
}

module.exports = { createLinearIssue, pickStateForMode, isUsageLimitExceeded, USAGE_LIMIT_MESSAGE };
