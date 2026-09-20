/**
 * linear-open-backlog-source.js — the candidate feed for BRO-3551's open
 * Backlog/Todo acceptance sweep.
 *
 * Every other candidate-source module in this repo (linear-recheck-source.js,
 * audit-card-verifiability.js's runLinearAudit) fetches ALL non-terminal team
 * issues in one paginated pass and filters client-side, rather than pushing
 * priority/state.type into the GraphQL filter — this file follows the exact
 * same shape for the same reason: the codebase's only prior art for a
 * state.type filter is `nin: TERMINAL_STATE_TYPES` (never `in:`), and this
 * module's own measurement (BRO-3551's evidence funnel: 1227 open -> 690
 * P1/P2 -> 544 Backlog/Todo) was taken by filtering an all-open fetch the
 * same way. Splitting the filter into GraphQL vs. client-side would make the
 * measured funnel and the code's own selection diverge for no benefit.
 *
 * mapIssueToCandidate is pure (no I/O), matching linear-recheck-source.js's
 * mapIssueToCard — the whole candidate-selection path (see
 * selectOpenBacklogSweepCandidates in autonomous-recheck-core.js) is testable
 * off plain fixtures, no network stub required.
 */

'use strict';

const { sortedCommentBodies } = require('./linear-dispatch.js');
const { TERMINAL_STATE_TYPES } = require('./linear-state-types.js');

const ATTEMPT_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 2;
const DEADLINE_MS = 60000;
const PAGE_SIZE = 100;
const MAX_PAGES = 30; // matches linear-recheck-source.js's bound — same team, same order of magnitude

const EXCLUDED_STATE_TYPES = TERMINAL_STATE_TYPES;

function buildOpenBacklogSweepQuery() {
  // No explicit orderBy — nothing downstream needs fetch order (same
  // reasoning as linear-recheck-source.js's buildRecheckCandidatesQuery).
  return `query($teamKey: String!, $after: String) {
    issues(
      first: ${PAGE_SIZE}
      after: $after
      filter: { team: { key: { eq: $teamKey } }, state: { type: { nin: ${JSON.stringify(EXCLUDED_STATE_TYPES)} } } }
    ) {
      nodes {
        identifier
        title
        description
        priority
        state { name type }
        comments(first: 50, orderBy: createdAt) { nodes { body createdAt } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
}

/**
 * Map one raw Linear issue node to the shape
 * selectOpenBacklogSweepCandidates expects.
 * @param {object} issue
 * @returns {{id:string,name:string,priority:number,stateType:string,notes:string,comments:string[]}|null}
 */
function mapIssueToCandidate(issue) {
  if (!issue || !issue.identifier) return null;
  return {
    id: issue.identifier,
    name: issue.title || '(untitled)',
    priority: Number(issue.priority) || 0,
    stateType: (issue.state && issue.state.type) || null,
    notes: issue.description || '',
    comments: sortedCommentBodies(issue),
  };
}

/**
 * Fetch every non-terminal issue on the team as an open-backlog-sweep
 * candidate. Never throws — a Linear outage must not crash the sweep — but,
 * like fetchLinearRecheckCandidates, does not swallow a real failure into a
 * silent empty array: a bad/missing LINEAR_API_KEY is reported via `error`,
 * not indistinguishable from "zero candidates this run".
 *
 * @param {{graphql:Function}} [client] injectable for tests
 * @param {{deadlineMs?:number, now?:Function, teamKey?:string}} [opts]
 * @returns {Promise<{candidates:Array, truncated:boolean, error:string|null}>}
 */
async function fetchOpenBacklogSweepCandidates(client, opts = {}) {
  const candidates = [];
  const now = opts.now || Date.now;
  const deadline = now() + (Number.isFinite(opts.deadlineMs) ? opts.deadlineMs : DEADLINE_MS);
  const teamKey = opts.teamKey || require('./linear-client.js').TEAM_KEY;
  const lc = client || require('./linear-client.js');
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (now() >= deadline) return { candidates, truncated: true, error: null };
    let data;
    try {
      data = await lc.graphql(
        buildOpenBacklogSweepQuery(),
        { teamKey, after },
        { timeoutMs: ATTEMPT_TIMEOUT_MS, maxAttempts: MAX_ATTEMPTS }
      );
    } catch (err) {
      return { candidates, truncated: true, error: String((err && err.message) || err).slice(0, 300) };
    }
    const conn = data && data.issues;
    if (!conn) break;
    for (const node of conn.nodes || []) {
      const candidate = mapIssueToCandidate(node);
      if (candidate) candidates.push(candidate);
    }
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
    if (page === MAX_PAGES - 1) return { candidates, truncated: true, error: null };
  }
  return { candidates, truncated: false, error: null };
}

module.exports = {
  EXCLUDED_STATE_TYPES,
  ATTEMPT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  DEADLINE_MS,
  buildOpenBacklogSweepQuery,
  mapIssueToCandidate,
  fetchOpenBacklogSweepCandidates,
};
