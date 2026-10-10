/**
 * done-evidence-source.js — the candidate set for the daily evidence
 * re-verification sweep (BRO-3426): every Linear issue in Done (recently),
 * In Review, or In Progress.
 *
 * WHY NOT linear-recheck-source.js. That module already fetches Linear
 * candidates for the nightly acceptance recheck, and reusing it was the first
 * thing tried. It cannot serve this sweep: its filter is
 * `EXCLUDED_STATE_TYPES = TERMINAL_STATE_TYPES`, i.e. it deliberately drops
 * every completed issue, and its header argues at length for that choice
 * (re-fetching every completed issue the team has ever had, forever, growing
 * without bound). Done is half of THIS sweep's whole question — "does the
 * board's claim that this is finished still hold" — so the exclusion is
 * exactly backwards here. The two sources answer different questions about
 * the same board and are kept separate rather than bent into one flag.
 *
 * What IS reused: the pagination/deadline/never-throws shape, the
 * `{cards, truncated, error}` contract, the injectable client, and the
 * no-orderBy reasoning — all copied deliberately from that module so the two
 * behave identically where they overlap. See its header for why an `orderBy:
 * updatedAt` would skip or duplicate rows mid-pagination.
 *
 * mapIssueToCard is PURE, so the whole candidate-shaping path is testable
 * against a plain fixture with no network stub.
 */

'use strict';

const { sortedCommentBodies } = require('./linear-dispatch.js');

const ATTEMPT_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 2;
const DEADLINE_MS = 60000;
const PAGE_SIZE = 100;
// Measured 2026-09-15: the three states below hold 368 issues live, i.e. 4
// pages. 30 is the same cap linear-recheck-source.js uses and leaves ~8x
// headroom; hitting it reports `truncated` rather than silently shrinking the
// sweep.
const MAX_PAGES = 30;

// The three buckets BRO-3426 names. Filtered by state NAME rather than type:
// this team's `In Review` and `In Progress` are both `started`-type states, so
// a type filter cannot tell them apart, and `Done` needs its own recency cut
// anyway (below).
const CANDIDATE_STATES = Object.freeze(['Done', 'In Review', 'In Progress']);

// How far back a completed issue stays interesting. Past this the claim has
// been standing long enough that a nightly re-check adds nothing, and the
// board's completed set grows without bound — the same unbounded-growth
// objection linear-recheck-source.js raises against including terminal states
// at all, answered here with a window instead of an exclusion.
const DONE_WINDOW_DAYS = 14;

function buildCandidatesQuery() {
  // Recency is applied CLIENT-side (see selectCandidates) rather than as a
  // second `or:`-joined filter clause. The flat `state.name.in` form is the
  // one verified live against this workspace's API; a hand-built `or:` of
  // {state}/{completedAt} predicates is more filter syntax to get wrong for
  // no measured gain, since the unfiltered set is only 368 issues / 4 pages.
  return `query($teamKey: String!, $after: String) {
    issues(
      first: ${PAGE_SIZE}
      after: $after
      filter: { team: { key: { eq: $teamKey } }, state: { name: { in: ${JSON.stringify(CANDIDATE_STATES)} } } }
    ) {
      nodes {
        identifier
        title
        url
        description
        createdAt
        updatedAt
        completedAt
        state { name type }
        # 50, matching linear-dispatch.js's buildIssueQuery cap and
        # linear-recheck-source.js's. Both PR-EVIDENCE lines and corrected
        # VERIFY commands are normally posted as COMMENTS — a Linear
        # description cannot be edited after filing (BRO-2796) — so a sweep
        # that read descriptions alone would miss nearly all the evidence it
        # exists to re-prove. Measured live: 19 PR-EVIDENCE lines and 341
        # acceptance commands across these three states.
        comments(first: 50, orderBy: createdAt) { nodes { body createdAt } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
}

/**
 * Map one raw Linear issue node to this sweep's card shape. Pure.
 * @returns {{id,name,url,state,stateType,notes,comments,createdAt,completedAt,updatedAt}|null}
 */
function mapIssueToCard(issue) {
  if (!issue || !issue.identifier) return null;
  return {
    // The human identifier ("BRO-3426"), not the UUID: it is what the digest
    // prints, what the owner types, and what dispatch-ledger rows key on.
    id: issue.identifier,
    name: issue.title || '(untitled)',
    url: issue.url || null,
    state: (issue.state && issue.state.name) || 'Unknown',
    stateType: (issue.state && issue.state.type) || null,
    notes: issue.description || '',
    // Oldest-first (sortedCommentBodies' contract). verify-gate.js's
    // evaluateVerifiability walks it newest-first to let a corrected command
    // supersede an earlier broken one, and extractPrRef's last-match-wins
    // gives the same precedence to a re-posted PR-EVIDENCE line.
    comments: sortedCommentBodies(issue),
    // createdAt is load-bearing, not decoration: it is the instant the vacuous
    // refinement compares a check path's age against (done-evidence-remote.js
    // pathPredatesCard).
    createdAt: issue.createdAt || null,
    completedAt: issue.completedAt || null,
    updatedAt: issue.updatedAt || null,
  };
}

/**
 * Narrow the fetched set to what this sweep should judge tonight: every open
 * candidate, plus only recently-completed Done cards.
 *
 * A Done card with no completedAt at all is KEPT. Linear populates that field
 * on the completed transition, but an issue moved by an integration or an
 * older API version can lack it, and dropping those would silently shrink the
 * Done denominator the headline reports — the same class of invisible
 * shrinkage this sweep exists to catch elsewhere.
 *
 * @param {Array} cards mapIssueToCard output
 * @param {{now?:number, windowDays?:number}} [o]
 */
function selectCandidates(cards, { now = Date.now(), windowDays = DONE_WINDOW_DAYS } = {}) {
  const cutoff = now - windowDays * 86400000;
  return (Array.isArray(cards) ? cards : []).filter((c) => {
    if (!c) return false;
    if (c.state !== 'Done') return true;
    if (!c.completedAt) return true;
    const t = Date.parse(c.completedAt);
    return !Number.isFinite(t) || t >= cutoff;
  });
}

/**
 * Fetch every candidate issue. NEVER throws — a Linear outage must leave the
 * rest of the health-check job working — but, like
 * linear-recheck-source.js's fetchLinearRecheckCandidates and unlike
 * stuck-work-linear-reconcile.js's fetchLinearIssueStates, it does not swallow
 * a real failure into a bare empty array either: a missing LINEAR_API_KEY in
 * CI would otherwise be indistinguishable from "zero candidates tonight",
 * leaving the sweep permanently green and permanently blind.
 *
 * @param {{graphql:Function}} [client] injectable for tests
 * @returns {Promise<{cards:Array, truncated:boolean, error:string|null}>}
 */
async function fetchDoneEvidenceCandidates(client, opts = {}) {
  const cards = [];
  const now = opts.now || Date.now;
  const deadline = now() + (Number.isFinite(opts.deadlineMs) ? opts.deadlineMs : DEADLINE_MS);
  const lc = client || require('./linear-client.js');
  const teamKey = opts.teamKey || lc.TEAM_KEY || require('./linear-client.js').TEAM_KEY;
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (now() >= deadline) return { cards, truncated: true, error: null };
    let data;
    try {
      data = await lc.graphql(
        buildCandidatesQuery(),
        { teamKey, after },
        { timeoutMs: ATTEMPT_TIMEOUT_MS, maxAttempts: MAX_ATTEMPTS }
      );
    } catch (err) {
      // Pages already fetched are real and kept; the failure is reported, not
      // swallowed.
      return { cards, truncated: true, error: String((err && err.message) || err).slice(0, 300) };
    }
    const conn = data && data.issues;
    if (!conn) break;
    for (const node of conn.nodes || []) {
      const card = mapIssueToCard(node);
      if (card) cards.push(card);
    }
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
    if (page === MAX_PAGES - 1) return { cards, truncated: true, error: null };
  }
  return { cards, truncated: false, error: null };
}

module.exports = {
  CANDIDATE_STATES,
  DONE_WINDOW_DAYS,
  ATTEMPT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  DEADLINE_MS,
  MAX_PAGES,
  buildCandidatesQuery,
  mapIssueToCard,
  selectCandidates,
  fetchDoneEvidenceCandidates,
};
