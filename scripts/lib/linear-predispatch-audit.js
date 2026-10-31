'use strict';

/**
 * linear-predispatch-audit.js — Linear as the backlog source for
 * predispatch-queue-audit.js (BRO-3431).
 *
 * WHY THIS EXISTS. predispatch-queue-audit.js only ever read
 * ~/.claude/tasks/<list>/*.json — the Notion mirror, frozen at task id 1285
 * since 2026-08-20 (CLAUDE.md §6). Measured 2026-09-14: its snapshot read
 * "67 of 135 queued cards blocked from auto-dispatch ... 47 ok-to-dispatch",
 * which send-morning-digest.js renders verbatim as "Predispatch queue
 * backlog" every morning. The real board held 1002 open Linear issues, 684
 * of them armed — a fleet-wide "the migration is done" narrative was built on
 * top of a number that undercounted the true backlog by roughly 7x. This is
 * the second source, mirroring the BRO-3390 pattern in
 * linear-watchdog-source.js: reuse its query/eligibility primitives rather
 * than re-deriving them, so "queued" and "blocked" mean the same thing here
 * as they do to the watchdog's own drain.
 *
 * SCOPE. "queued" here = open (non-terminal), not-yet-started, P0/P1 Linear
 * issues — the same population linear-watchdog-source.js's
 * fetchLinearWatchdogTasks() would consider dispatching. A Medium/Low-
 * priority issue isn't "blocked", it's simply outside the auto-dispatch
 * mandate (CLAUDE.md: "P0/P1 = dispatch at creation") — counting it as
 * blocked would just be a different lie about the same number, so
 * ineligibleReason()'s 'not-p0-p1' verdict is excluded from this tally
 * entirely rather than folded into DO-NOT-DISPATCH.
 *
 * VERDICT MAPPING onto buildQueueAuditSnapshot's existing 4-bucket vocabulary
 * (scripts/lib/predispatch-queue-audit.js) — chosen so the CLI wrapper can
 * concatenate these classifications onto the Notion-mirror ones and feed both
 * through the SAME tally/render path with zero changes to that module:
 *   eligible (ineligibleReason === null)      -> OK-TO-DISPATCH
 *   'unarmed'                                  -> DO-NOT-DISPATCH (no safe
 *                                                 verify command; structurally
 *                                                 cannot be headless-dispatched)
 *   'autofix-filed-tracker'                    -> DO-NOT-DISPATCH (owned by
 *                                                 linear-drain-parked.js, not
 *                                                 real backlog for this tally)
 *   'headless-blocked: ...'                    -> CHECK-FIRST (needs a human
 *                                                 look — PARKED sentinel,
 *                                                 visual-QA gate, etc. — same
 *                                                 spirit as the Notion
 *                                                 classifier's CHECK-FIRST)
 *   already-started / terminal-state / no-state /
 *   malformed / not-p0-p1                      -> excluded (not "queued")
 *
 * No REOPEN-SUSPECT here: that verdict is specific to a Notion card that
 * carries a completedDate + outcome + sha while its status was reset — a
 * shape that has no analog in a Linear issue's state model (a Done issue
 * really is done; reopening it is reconcile-dead-completions.js's job, not
 * this audit's).
 *
 * Pure functions only — the one function that talks to Linear
 * (fetchLinearBacklogClassifications) never throws; a Linear outage must
 * leave the Notion-sourced half of the tally intact rather than crash the
 * whole audit run (same posture as linear-watchdog-source.js's
 * fetchLinearWatchdogTasks and dispatch-watchdog.js's refreshLinearTasks).
 */

const {
  buildWatchdogBacklogQuery,
  priorityOf,
  ineligibleReason,
} = require('./linear-watchdog-source.js');

const DEFAULT_MAX_PAGES = 30;
const DEFAULT_PAGE_LIMIT = 100;

/**
 * PURE. Map one raw Linear issue node onto the {verdict, name, id} shape
 * buildQueueAuditSnapshot's tallyVerdicts/classifyCandidate-result consumer
 * already accepts. Returns null when the issue is outside this audit's
 * "queued" scope (see header) — the caller must not count a null toward
 * tally.total.
 */
function classifyLinearIssueForAudit(issue) {
  if (!issue || !issue.identifier) return null;
  const stateType = issue.state && issue.state.type;
  if (stateType === 'started') return null; // being worked right now — not "queued"
  if (!priorityOf(issue)) return null; // outside the P0/P1 auto-dispatch mandate entirely

  const reason = ineligibleReason(issue);
  const id = `linear:${issue.identifier}`;
  const name = String(issue.title || issue.identifier);

  if (reason === null) return { verdict: 'OK-TO-DISPATCH', status: (issue.state && issue.state.name) || null, name, id };
  if (reason === 'unarmed' || reason === 'autofix-filed-tracker') {
    return { verdict: 'DO-NOT-DISPATCH', status: (issue.state && issue.state.name) || null, name, id, flags: [reason] };
  }
  if (reason.startsWith('headless-blocked')) {
    return { verdict: 'CHECK-FIRST', status: (issue.state && issue.state.name) || null, name, id, flags: [reason] };
  }
  // already-started/terminal-state/no-state/malformed: excluded above or
  // structurally unreachable given the state-type/priority checks already
  // passed — anything else falls through to null (not counted) rather than
  // guess at a verdict for a reason this module doesn't recognize yet.
  return null;
}

/**
 * The one function that talks to Linear. NEVER throws — see header. Returns
 * {ok, reason, classifications, scanned}; callers must leave the Notion-
 * sourced half of the audit working when ok === false rather than treat an
 * empty classifications array as "no Linear backlog exists".
 */
async function fetchLinearBacklogClassifications(client, opts = {}) {
  const classifications = [];
  const maxPages = Number.isInteger(opts.maxPages) && opts.maxPages > 0 ? opts.maxPages : DEFAULT_MAX_PAGES;
  const teamKey = opts.teamKey || 'BRO';
  const pageLimit = opts.pageLimit || DEFAULT_PAGE_LIMIT;
  let scanned = 0;
  let after = null;

  if (!client || typeof client.graphql !== 'function') {
    return { ok: false, reason: 'no-linear-client', classifications, scanned: 0 };
  }

  try {
    for (let page = 0; page < maxPages; page++) {
      const data = await client.graphql(buildWatchdogBacklogQuery(pageLimit), { teamKey, after });
      const nodes = (data && data.issues && data.issues.nodes) || [];
      const pageInfo = (data && data.issues && data.issues.pageInfo) || { hasNextPage: false };
      for (const issue of nodes) {
        scanned++;
        const c = classifyLinearIssueForAudit(issue);
        if (c) classifications.push(c);
      }
      if (!pageInfo.hasNextPage) break;
      after = pageInfo.endCursor;
      if (page === maxPages - 1) {
        // Same truncation guard as fetchLinearWatchdogTasks: a silently
        // truncated queue reads identically to a small backlog, which is
        // exactly the failure mode this module exists to end.
        return {
          ok: false,
          reason: `linear-scan-truncated: hit maxPages=${maxPages} with more pages remaining`,
          classifications: [],
          scanned,
        };
      }
    }
  } catch (e) {
    return {
      ok: false,
      reason: `linear-fetch-failed: ${e && e.message ? e.message : String(e)}`,
      classifications: [],
      scanned,
    };
  }

  return { ok: true, reason: null, classifications, scanned };
}

module.exports = {
  classifyLinearIssueForAudit,
  fetchLinearBacklogClassifications,
};
