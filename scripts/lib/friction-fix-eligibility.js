'use strict';

/**
 * friction-fix-eligibility.js — which open Linear issues the Monday
 * friction auto-fixer (scripts/auto-fix-friction-card.js) may pick up.
 *
 * posthog-friction-analyzer.js files friction findings PARKED at Urgent/High
 * for this fixer, which selects them by priority. BRO-4487 caps every parked
 * filing at Medium (linear-issue-create.js's effectiveCreatePriority) and
 * stamps PARKED_CLAMP_MARKER into the description, so a priority-only filter
 * would silently find nothing every week. A Medium issue is still eligible
 * when it carries that marker, i.e. it was filed as Urgent/High and clamped.
 */

const { PARKED_CLAMP_MARKER } = require('./linear-issue-create.js');

// Linear's raw priority ints: 1 = Urgent, 2 = High (the analyzer's 'P0 Now'
// and 'P1 Next').
const ELIGIBLE_PRIORITIES = [1, 2];
const FHASH_RE = /fhash:([0-9a-f]{8})/;
// createMissingShowIssue (posthog-friction-analyzer.js) also stamps fhash and
// files at P1, but its notes say "do NOT auto-add" (CLAUDE.md Rule 3).
const MISSING_SHOW_RE = /\bmissing-show\b/i;

/** PURE. Is this open issue a friction finding the auto-fixer may work? */
function isFrictionFixCandidate(issue) {
  const description = (issue && issue.description) || '';
  if (!FHASH_RE.test(description) || MISSING_SHOW_RE.test(description)) return false;
  const priority = Number(issue.priority);
  if (ELIGIBLE_PRIORITIES.includes(priority)) return true;
  return priority === 3 && description.includes(PARKED_CLAMP_MARKER);
}

module.exports = { isFrictionFixCandidate, ELIGIBLE_PRIORITIES, FHASH_RE, MISSING_SHOW_RE };
