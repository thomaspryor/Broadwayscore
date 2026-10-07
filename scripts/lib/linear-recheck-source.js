/**
 * linear-recheck-source.js — Linear as a second candidate source for the
 * nightly acceptance recheck (BRO-3373).
 *
 * autonomous-acceptance-recheck.js has only ever asked notion-brain.js for
 * Done/Paused cards. The Notion→Linear mirror froze at task id 1285
 * (2026-08-20, CLAUDE.md §6) — every card filed or paused on Linear since
 * then has been invisible to it, so every RECHECK-AFTER stamp written on a
 * Linear card since that date has silently never been verified. This module
 * fetches the Linear-side candidates and maps them into the same card shape
 * scripts/lib/autonomous-recheck-core.js's selectRecheckTargets already
 * accepts — that function needed ZERO changes: doneWithinWindow already lets
 * an explicit RECHECK-AFTER stamp override the status check entirely, so a
 * card sitting in Linear's "Backlog" state (this team has no "Paused" state
 * — CLAUDE.md §6, pausing a card lands it in Backlog) is eligible exactly
 * like a Notion "Paused" card as long as it carries a stamp. What DID need
 * to change was stamp/command DISCOVERY: a Linear card's RECHECK-AFTER stamp
 * and acceptance command are typically posted in a wrap-up COMMENT (via
 * `linear-session.js report`), not the issue description — recheck-stamp.js's
 * parseRecheckAfterFromCard and this module's card.comments field, and
 * autonomous-recheck-core.js's verifiabilityForCard, both scan card.comments
 * for exactly that reason.
 *
 * mapIssueToCard is a PURE function (no I/O) so it — and therefore the whole
 * Linear candidate-selection path — is testable with a plain fixture object,
 * no network stub required. fetchLinearRecheckCandidates is the one function
 * that talks to Linear: it never throws (a Linear outage must leave the
 * Notion-sourced half of the nightly recheck working, not take the whole run
 * down), but unlike stuck-work-linear-reconcile.js's fetchLinearIssueStates
 * it does not swallow a real failure into a silent empty array either — see
 * that function's own header for why (a missing LINEAR_API_KEY in CI was
 * caught doing exactly that during ship-check).
 */

'use strict';

const { sortedCommentBodies } = require('./linear-dispatch.js');
// The one place that names Linear's terminal state TYPES (BRO-2466) — see
// that file's header for why re-hardcoding this list is the drift trap it
// exists to prevent (a past incident: a terminal type added there and missed
// in one call site silently un-closed 19 issues).
const { TERMINAL_STATE_TYPES } = require('./linear-state-types.js');

// Network budget — matches fetchLinearIssueStates' reasoning exactly: this is
// a best-effort read whose failure mode is "Linear candidates not checked
// tonight", never worth holding up the whole recheck run over.
const ATTEMPT_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 2;
const DEADLINE_MS = 60000;
const PAGE_SIZE = 100;
const MAX_PAGES = 30; // 3,000 issues — measured live at 1,260 non-terminal
// (2026-09-15); see the truncated-signal note on fetchLinearRecheckCandidates
// for what happens if the board ever outgrows this.

// Excludes every terminal type (completed/canceled/duplicate), same set
// fetchLinearIssueStates already treats as "resolved" (CLOSED_STATE_TYPES in
// stuck-work-linear-reconcile.js). A ship-check review for BRO-3373 flagged
// an earlier version of this file for INCLUDING completed issues (to catch a
// Done card that still carries an unresolved RECHECK-AFTER stamp) — dropped
// deliberately: that class is real but rare (BRO-3024 is the one live
// example, and it was closed manually rather than left for automation), and
// including it means re-fetching full description + comments for every
// completed issue this team has EVER had, forever, growing without bound. A
// recency filter (e.g. "only completed issues updated in the last N days")
// was considered and rejected: a RECHECK-AFTER stamp is explicitly meant to
// stay due indefinitely with no further comment activity until the recheck
// runs (see recheck-stamp.js / doneWithinWindow's "due the instant, stays
// due after" semantics) — an issue paused once and never touched again would
// silently age out of an updatedAt-bounded window right as its stamp became
// due, reproducing the exact invisible-forever failure this ticket exists to
// close, just via a different filter. Restricting to non-terminal issues has
// no such risk: BRO-3373's own evidence (BRO-3015, BRO-3320) is Backlog/In
// Review, both non-terminal, and a card can't sit non-terminal "as
// residue" — someone is still expected to move it.
const EXCLUDED_STATE_TYPES = TERMINAL_STATE_TYPES;

function buildRecheckCandidatesQuery() {
  // No explicit orderBy (ship-check finding, Codex): `orderBy: updatedAt`
  // sorts by a MUTABLE field, and a card can legitimately be commented on —
  // changing its own updatedAt — while this multi-page scan is still running,
  // shifting it across a page boundary mid-pagination (skip or duplicate).
  // Nothing downstream needs fetch order: selectRecheckTargets re-sorts by
  // its own starvation guard (lastRecheckedAt) after the fact. Omitting
  // orderBy falls back to Linear's default (stable, creation-order) sort,
  // same as fetchLinearIssueStates's query, which has no orderBy either.
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
        updatedAt
        completedAt
        state { name type }
        # 50, matching linear-dispatch.js's buildIssueQuery cap (BRO-2543) —
        # not unlimited: a card with more comments than this can still lose an
        # old stamp/command past the cut, same residual risk buildIssueQuery
        # itself accepts, just widened from an initial 20 (ship-check finding:
        # 20 was tighter than every other comment-reading query in this repo
        # for no stated reason).
        comments(first: 50, orderBy: createdAt) { nodes { body createdAt } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
}

/**
 * Map one raw Linear issue node to the card shape selectRecheckTargets
 * expects. Pure — no I/O, no network — so this is unit-testable directly.
 *
 * @param {object} issue - a `nodes[]` entry from buildRecheckCandidatesQuery
 *   (identifier, title, description, updatedAt, completedAt, state{name,type},
 *   comments{nodes[{body,createdAt}]})
 * @returns {{id:string,name:string,status:string,notes:string,comments:string[],completedDate:string|null,lastEditedAt:string|null}|null}
 */
function mapIssueToCard(issue) {
  if (!issue || !issue.identifier) return null;
  const stateType = issue.state && issue.state.type;
  const stateName = (issue.state && issue.state.name) || 'Unknown';
  return {
    // The identifier (e.g. "BRO-3015"), not the UUID: dispatch-ledger 'launch'
    // entries for a Linear-sourced dispatch key on `linearId: issue.identifier`
    // (scripts/linear-next.js), and selectRecheckTargets matches launches by
    // `e.notionId || e.linearId` against card.id — using anything else here
    // would make every Linear-sourced dispatch record unmatchable.
    id: issue.identifier,
    name: issue.title || '(untitled)',
    // 'Done' only for Linear's completed-type state — dead via the live
    // fetch today (fetchLinearRecheckCandidates excludes every terminal
    // type, completed included; see that exclusion's own comment), but kept
    // here so mapIssueToCard stays a complete, general-purpose mapping
    // rather than one silently coupled to its one current caller's filter.
    // Every non-completed state name (Backlog, Todo, In Progress, In
    // Review, ...) fails doneWithinWindow's no-stamp Done-fallback check
    // exactly like a Notion non-Done status would, and is only ever picked
    // up via an explicit RECHECK-AFTER stamp — never swept in by mistake.
    status: stateType === 'completed' ? 'Done' : stateName,
    notes: issue.description || '',
    // Oldest-first (sortedCommentBodies' own contract) — recheck-stamp.js
    // scans this newest-to-oldest for RECHECK-AFTER, and verify-gate.js's
    // evaluateVerifiability scans it newest-to-oldest for an acceptance
    // command, both via card.comments.
    comments: sortedCommentBodies(issue),
    // Sliced to the date component (BRO-3373 ship-check finding): Linear's
    // completedAt is a full ISO timestamp, but doneWithinWindow treats
    // completedDate as DATE-ONLY and pads +24h to reach end-of-day (matching
    // what notion-brain.js's own date-only completedDate property means).
    // Passing the full timestamp through unchanged would silently widen
    // every completed card's "still within window" eligibility by up to a
    // day past the real windowHours.
    completedDate: issue.completedAt ? issue.completedAt.slice(0, 10) : null,
    lastEditedAt: issue.updatedAt || null,
  };
}

/**
 * Fetch every non-terminal issue on the team as a recheck candidate card.
 * Never THROWS — a Linear outage must not sink the Notion half of the
 * recheck run — but, unlike stuck-work-linear-reconcile.js's
 * fetchLinearIssueStates, it does not swallow a fetch failure into a bare
 * empty array either. A real failure (bad/missing LINEAR_API_KEY, network,
 * schema drift) is reported via the returned `error` string so the caller
 * can log + ledger it (ship-check finding: an earlier version's blanket
 * try/catch made a MISSING LINEAR_API_KEY in CI indistinguishable from "zero
 * candidates tonight" — reproducing, for a different reason, the exact
 * "silently unverified forever" failure BRO-3373 exists to fix). Whatever
 * cards were already fetched before the failure are kept, not discarded.
 *
 * `truncated: true` means the page/deadline cap was hit (or a fetch failed
 * partway through pagination) with more pages potentially outstanding — the
 * caller surfaces this the same way it already surfaces a full Notion
 * listing (`recheck-truncated` ledger entry), because a fetch that silently
 * stops growing is exactly BRO-3373's own failure shape.
 *
 * @param {{graphql:Function}} [client] injectable for tests
 * @param {{deadlineMs?:number, now?:Function, teamKey?:string}} [opts]
 * @returns {Promise<{cards:Array, truncated:boolean, error:string|null}>}
 *   cards in the shape mapIssueToCard returns
 */
async function fetchLinearRecheckCandidates(client, opts = {}) {
  const cards = [];
  const now = opts.now || Date.now;
  const deadline = now() + (Number.isFinite(opts.deadlineMs) ? opts.deadlineMs : DEADLINE_MS);
  const teamKey = opts.teamKey || require('./linear-client.js').TEAM_KEY;
  const lc = client || require('./linear-client.js');
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (now() >= deadline) return { cards, truncated: true, error: null }; // partial — see contract above
    let data;
    try {
      data = await lc.graphql(
        buildRecheckCandidatesQuery(),
        { teamKey, after },
        { timeoutMs: ATTEMPT_TIMEOUT_MS, maxAttempts: MAX_ATTEMPTS }
      );
    } catch (err) {
      // Whatever was fetched on earlier pages is real and kept; the failure
      // itself must not go silent — see this function's header.
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
    if (page === MAX_PAGES - 1) return { cards, truncated: true, error: null }; // hit the page cap with more outstanding
  }
  return { cards, truncated: false, error: null };
}

module.exports = {
  EXCLUDED_STATE_TYPES,
  ATTEMPT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  DEADLINE_MS,
  buildRecheckCandidatesQuery,
  mapIssueToCard,
  fetchLinearRecheckCandidates,
};
