/**
 * linear-dispatch.js — pure decision logic + GraphQL query/mutation TEXT for
 * scripts/linear-next.js (task #1303, BRO-266 Linear transition). This is the
 * Linear-issue counterpart of bsc-next.js's inline buildSeed()/priorityRank()/
 * routing logic, kept in its own scripts/lib/ file (not copied into
 * linear-next.js or linear-client.js) so both the CLI and its tests
 * require() the exact same code (CLAUDE.md rule 15).
 *
 * No I/O, no fetch — scripts/lib/linear-client.js is the only place that
 * actually talks to Linear's GraphQL endpoint (CI-gated by
 * scripts/audit-linear-issuecreate-chokepoint.js); this file only builds the
 * query/mutation TEXT that client sends and the pure decisions linear-next.js
 * makes around it (priority sort, mac-only routing override, the seed
 * prompt).
 */

'use strict';

const crypto = require('crypto');
const { buildAutoTitle } = require('./workspace-naming');
// Idempotency helpers (hasLiveLedgerEntry below) reuse dispatch-ledger.js's
// own pure predicates (latestAttemptForTask/isLatestDispatchDead/JOB_EVENTS)
// rather than re-deriving "is the most recent attempt for this task still
// live" a second way — entries/taskId are passed in by the caller
// (linear-next.js does the actual readEntries() I/O), so this file performs
// no ledger I/O itself.
const dispatchLedger = require('./dispatch-ledger.js');

// v1 machine-bound routing (see decideRouting below): an issue carrying this
// label always forces a local cmux tab, whatever --headless/--tab flag was
// passed. No Cyrus/queue routing yet — deliberately out of scope for #1303.
const MAC_ONLY_LABEL = 'mac-only';

// ── GraphQL query/mutation TEXT (pure — returns a string, no network) ──────

// Fetches everything linear-next.js needs to seed a dispatch: title,
// description (the card body), state (to know what "In Progress"/"In
// Review" resolve to isn't needed here — linear-client.js's listOpenIssues
// return the team's state list separately via getTeam()), priority, labels
// (for the mac-only routing check), url (quoted in the seed), and comments
// (not currently rendered into the seed, but fetched so a future version can
// show prior context without a second round trip).
function buildIssueQuery() {
  return `query($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      priority
      url
      state { id name type }
      labels(first: 20) { nodes { id name } }
      comments(first: 20) { nodes { id body createdAt user { name } } }
    }
  }`;
}

// Open (non-completed, non-canceled) issues for one team, newest-updated
// first — priority ORDER is a caller-side pure sort (sortIssuesByPriority
// below), not baked into the query, so the same fetch can serve both
// --list's priority view and any future recency view without refetching.
//
// linear-next.js's --list is a deliberate v1 choice: a LIVE fetch every
// invocation, not a notion-tasks-sync-style local mirror (~/.claude/tasks/)
// that bsc-next.js's --list reads from. At the current backlog size (~100
// open BRO issues, first:100 above covers it in one request with no
// pagination) a live round trip costs nothing meaningful and is trivially
// correct — no mirror to go stale, no sync cron to keep alive, no drift
// between "what --list shows" and "what's actually on the board". Paginated
// ($after cursor + pageInfo, consumed by linear-client.js's cursor loop) so
// crossing 100 open issues degrades to extra round trips, never silent
// truncation. Revisit the live-fetch choice itself only if a caller needs
// --list fast enough to run in a tight loop (a live GraphQL round trip every
// call does not scale to that).
function buildOpenIssuesQuery() {
  return `query($teamKey: String!, $after: String) {
    issues(
      first: 100
      after: $after
      filter: { team: { key: { eq: $teamKey } }, state: { type: { nin: ["completed", "canceled"] } } }
      orderBy: updatedAt
    ) {
      nodes {
        identifier
        title
        priority
        url
        updatedAt
        state { name type }
        labels(first: 10) { nodes { name } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
}

// "Dispatched to <ref> at <ts>" comment (see buildDispatchComment) posted
// through this mutation — the one write linear-next.js performs besides the
// state transition (which reuses linear-client.js's existing generic
// updateIssue(), no new mutation text needed).
function buildCommentMutation() {
  return `mutation($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
    }
  }`;
}

// ── priority ────────────────────────────────────────────────────────────
// Linear's raw priority ints: 0 = No priority, 1 = Urgent, 2 = High,
// 3 = Medium, 4 = Low. A bare ascending sort on the raw int would put every
// untriaged ("No priority") issue AHEAD of every Urgent one — priorityRank
// remaps 0/missing to rank 5 (last) so "top of --list" means "most urgent",
// matching Linear's own UI priority sort.
function priorityRank(issue) {
  const p = Number(issue && issue.priority);
  if (!Number.isFinite(p) || p <= 0) return 5;
  return p;
}

const PRIORITY_LABELS = { 0: 'None', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };
function priorityLabel(issue) {
  const p = Number(issue && issue.priority);
  return PRIORITY_LABELS[p] || 'None';
}

// Stable sort (Array.prototype.sort is stable per spec since Node 11) so
// same-priority issues keep the server's orderBy (updatedAt) as the tiebreak.
function sortIssuesByPriority(issues) {
  return [...(issues || [])].sort((a, b) => priorityRank(a) - priorityRank(b));
}

// ── labels / machine-bound routing (v1) ────────────────────────────────────

function issueLabelNames(issue) {
  return ((issue && issue.labels && issue.labels.nodes) || [])
    .map((l) => String((l && l.name) || '').toLowerCase())
    .filter(Boolean);
}

function hasMacOnlyLabel(issue) {
  return issueLabelNames(issue).includes(MAC_ONLY_LABEL);
}

/**
 * v1 machine-bound routing hook. A single hard override, not a policy
 * engine: an issue labeled 'mac-only' (GUI-dependent scraper, keychain,
 * physical-device work — anything that genuinely needs the operator's own
 * Mac) always routes to a local cmux tab, regardless of what --headless/--tab
 * flag the caller passed. Everything else defers entirely to the caller's
 * flag. No Cyrus/queue routing — that's explicitly out of scope for #1303.
 *
 * @param {object} issue - the fetched Linear issue (needs .labels.nodes)
 * @param {object} opts
 * @param {boolean} [opts.headless] - true when --headless was passed (and
 *   not overridden by --tab — the caller resolves that precedence before
 *   calling this)
 * @returns {{mode: 'tab'|'headless', reason: string}}
 */
function decideRouting(issue, { headless = false } = {}) {
  if (hasMacOnlyLabel(issue)) {
    return { mode: 'tab', reason: `label '${MAC_ONLY_LABEL}' forces a local cmux tab` };
  }
  return headless
    ? { mode: 'headless', reason: '--headless flag' }
    : { mode: 'tab', reason: 'default (no --headless)' };
}

// ── seed prompt ─────────────────────────────────────────────────────────

/**
 * The context a dispatched worker gets — the Linear counterpart of
 * bsc-next.js's buildSeed(). Deliberately tells the session to report back
 * ON THE ISSUE ITSELF (comment + state transition), not just to the ledger —
 * that's what makes progress visible on the Linear board to anyone who isn't
 * grepping the local dispatch ledger.
 */
function buildLinearSeed({ identifier, title, description, url, model, project, mode }) {
  return [
    `[${identifier}] ${title} —`,
    ``,
    `Work on this Linear issue as this session's focus. Implement it per CLAUDE.md rules — worktree before any code edit, /ship-check before you claim it's done.`,
    ``,
    `ISSUE: ${identifier} — ${title}`,
    url ? `Linear: ${url}` : null,
    mode ? `Dispatch mode: ${mode}` : null,
    ``,
    description || '(no description)',
    ``,
    project
      ? `This workspace is named "${buildAutoTitle({ subject: `${identifier} ${title}`, project, model })}" — the 🤖 marks it as auto-dispatched, "${project}" is its project bucket.`
      : null,
    ``,
    `When you are done (or blocked), report the outcome as a comment on this Linear issue (${identifier}) via the Linear GraphQL API (commentCreate — see scripts/lib/linear-client.js's createComment()) and set the issue's state to "In Review" (issueUpdate — linear-client.js's updateIssue()). Do not leave it silently sitting in "In Progress" with no comment — that is how work goes untracked. If you cannot finish, comment what's blocking it and leave the state as-is rather than guessing at "In Review".`,
    ``,
    `Start by confirming your understanding and a short plan, then proceed.`,
  ].filter((v) => v !== null).join('\n');
}

// "Dispatched <correlationId> to <ref> at <ts> (<mode>)" — posted on the
// issue itself (via linear-client.js's createComment) at dispatch time so
// double-dispatch is visible on the Linear board, not just in the local
// dispatch ledger. correlationId ties this comment back to the exact ledger
// entry the same dispatch wrote (see hasLiveLedgerEntry/
// findUnresolvedDispatchComment below — the two independent idempotency
// signals a retry cross-checks against). Optional so existing callers that
// pass none still get a readable comment.
function buildDispatchComment({ ref, ts, mode, correlationId }) {
  const corr = correlationId ? ` ${correlationId}` : '';
  return `Dispatched${corr} to ${ref} at ${ts}${mode ? ` (${mode})` : ''}`;
}

// Short opaque id embedded in both the ledger 'launch' entry and the Linear
// comment for one dispatch attempt, so a human (or a future audit script)
// can find "the ledger row this exact comment came from" without fuzzy-
// matching on timestamps. Not a security token — collision cost is a
// slightly confusing cross-reference, not a guessable secret, so 4 bytes is
// plenty.
function generateCorrelationId() {
  return crypto.randomBytes(4).toString('hex');
}

// ── idempotency (task #1303 plan review item 4) ────────────────────────────
//
// Two INDEPENDENT signals that "this issue already looks dispatched",
// checked before every launch attempt so a retry (this host, a different
// host, or a different invocation after the local ledger was lost/rotated)
// reconciles instead of double-launching:
//   1. findUnresolvedDispatchComment — reads the issue's OWN comment thread
//      (fetched alongside the issue, no extra round trip). Cross-machine by
//      construction: the comment lives on Linear's server, not this host.
//   2. hasLiveLedgerEntry — reads the LOCAL dispatch-ledger.jsonl. Cheap and
//      fast, but host-local (a different machine's ledger won't see it) —
//      exactly why (1) exists as a second, independent check.

// An issue already moved to a terminal workflow-state type (completed/
// canceled) has resolved whatever a prior "Dispatched ..." comment was
// about, one way or another — a stale comment on a now-closed issue is not
// evidence of a LIVE dispatch. Most-recent comment wins (last-in-array),
// matching this codebase's lastByRef/foldJobs "last record wins" convention.
function findUnresolvedDispatchComment(issue) {
  const stateType = issue && issue.state && issue.state.type;
  if (stateType === 'completed' || stateType === 'canceled') return null;
  const comments = (issue && issue.comments && issue.comments.nodes) || [];
  const dispatched = comments.filter((c) => /^Dispatched\b/.test(String((c && c.body) || '').trim()));
  return dispatched.length ? dispatched[dispatched.length - 1] : null;
}

// The most recent dispatch-ledger attempt for this task exists and is
// neither dead/unverified (dispatch-ledger's own isLatestDispatchDead) nor a
// TERMINAL success (a finished headless job, JOB_EVENTS.DONE — done means
// resolved, not "still live"). Anything else (a verified cmux 'launch', an
// in-flight 'job-spawned') counts as live.
function hasLiveLedgerEntry(taskId, entries) {
  const list = entries || [];
  const latest = dispatchLedger.latestAttemptForTask(taskId, list);
  if (!latest) return false;
  if (dispatchLedger.isLatestDispatchDead(taskId, list)) return false;
  if (latest.event === dispatchLedger.JOB_EVENTS.DONE) return false;
  return true;
}

// Terminal-state guard (task #1517, BRO-247 incident root cause): a
// re-dispatch of an issue Linear itself already considers resolved
// (completed/canceled) is never correct — the incident this closes was
// exactly that (a Done, archived issue got re-dispatched and only failed at
// the createComment/updateIssue step with a cryptic "Entity not found"
// error, task #1510's unarchive-and-retry symptom fix). buildIssueQuery
// already fetches `state { id name type }` on every getIssue() call; this is
// the first caller that reads it. Returns a refusal string (caller decides
// how to report it) or null when dispatch may proceed — same "pure
// predicate, caller does I/O/exit" shape as the other guards in this file.
function checkTerminalStateGuard(issue) {
  const stateType = issue && issue.state && issue.state.type;
  if (stateType !== 'completed' && stateType !== 'canceled') return null;
  const stateName = (issue.state && issue.state.name) || stateType;
  return `${issue.identifier} is already in a terminal state ("${stateName}") — refusing to re-dispatch. Re-run with --force if this is a deliberate re-open.`;
}

// Rail 2 (Phase 0 parallel-run safety, plan 2026-08-12, task #1341): the
// alert router's cross-system dedupe needs `description` on top of what
// buildOpenIssuesQuery() above fetches — kept as its own query (not an added
// field on the shared one) so a --list regression can never be caused by a
// change that only rail 2 needed, and vice versa. Paginated ($after +
// pageInfo) like buildOpenIssuesQuery: the workspace already holds 200+
// issues, so a single first:100 page would silently miss dedupe matches —
// exactly the double-file this query exists to prevent.
function buildOpenIssuesWithDescriptionsQuery() {
  return `query($teamKey: String!, $after: String) {
    issues(
      first: 100
      after: $after
      filter: { team: { key: { eq: $teamKey } }, state: { type: { nin: ["completed", "canceled"] } } }
    ) {
      nodes {
        identifier
        title
        description
        url
        state { name type }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
}

// Pure match for linear-client.js's searchIssues(): does any OPEN issue's
// title or description already contain this literal term (the alert's
// conditionKey)? owner-alert-router.js's dispatchCard() embeds the raw
// conditionKey in every card/issue it files — in the "## Acceptance
// criteria" line (`Condition "<key>" no longer fires...`) that has always
// been there, and now also in a dedicated `[conditionKey:<key>]` marker (see
// buildCardNotes) — so a plain substring check catches both the historical
// and the new form without needing to special-case either. First match wins,
// same "first match is enough" contract as findUnresolvedDispatchComment
// above. Client-side (not a Linear-side `contains` filter) so this never
// depends on the exact shape of Linear's filter DSL doing the right thing
// for a body-text search.
function findOpenIssueForTerm(issues, term) {
  if (!term || !Array.isArray(issues)) return null;
  for (const issue of issues) {
    if (!issue) continue;
    if (issue.title && issue.title.includes(term)) return issue;
    if (issue.description && issue.description.includes(term)) return issue;
  }
  return null;
}

module.exports = {
  MAC_ONLY_LABEL,
  buildIssueQuery,
  buildOpenIssuesQuery,
  buildOpenIssuesWithDescriptionsQuery,
  findOpenIssueForTerm,
  buildCommentMutation,
  priorityRank,
  priorityLabel,
  sortIssuesByPriority,
  issueLabelNames,
  hasMacOnlyLabel,
  decideRouting,
  checkTerminalStateGuard,
  buildLinearSeed,
  buildDispatchComment,
  generateCorrelationId,
  findUnresolvedDispatchComment,
  hasLiveLedgerEntry,
};
