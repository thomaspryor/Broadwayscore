/**
 * linear-session-reporting.js — pure decision logic for the Linear twin of
 * Notion's session-reporting loop (BRO-387). Notion enforces "every session
 * has a card" via 13 hooks that call scripts/notion-brain.js; Linear has had
 * none of that, so a session's work could land on main without ever
 * appearing on the Linear board. This file is the pure, unit-testable core
 * that scripts/linear-session.js (the CLI, does the actual GraphQL I/O via
 * scripts/lib/linear-client.js) and the ~/.claude/hooks/linear-issue-*.sh
 * hooks (enforcement) both build on — same split as
 * scripts/lib/linear-issue-create.js's pure pickStateForMode() vs its I/O
 * wrapper createLinearIssue().
 *
 * No `require('./linear-client')` here on purpose: every function takes the
 * data it needs (an issue, a states list, a status string) as plain
 * arguments and returns a plan describing what to do — never performs I/O
 * itself. That's what makes this file testable without a LINEAR_API_KEY.
 */

'use strict';

// Team BRO currently has TWO states of type "started" (In Progress, In
// Review) — see linear-issue-create.js:58's byType() helper, which is
// correct for park/dispatch (those only ever need "unstarted"/"backlog")
// but would be ambiguous here. Claiming and reporting both need a SPECIFIC
// named state, not "any started state", so this file matches by name first
// and falls back to type only when the exact name isn't present (e.g. a
// workspace admin renames "In Progress" to "Doing").
const CLAIM_STATE_NAME = 'In Progress';

const STATUS_TO_STATE_NAME = {
  done: 'Done',
  'in-review': 'In Review',
  paused: 'Backlog',
  // 'blocked' deliberately maps to no state change — BRO-387's own
  // instructions: "leave the state as-is rather than guessing at 'In
  // Review'" when a session can't finish.
};

const STATUS_TO_STATE_TYPE_FALLBACK = {
  done: 'completed',
  'in-review': 'started',
  paused: 'backlog',
};

// Normalizes Linear's two shapes for a states list: getTeam() returns
// {nodes:[...]} (GraphQL connection shape), callers in tests pass a bare
// array. linear-issue-create.js:58 hit this exact bug in production
// (states.find is not a function) before adding the same normalization —
// duplicated here rather than imported because that file's byType() is
// private (not exported) and this module intentionally has zero require()s
// into linear-issue-create.js to stay a leaf dependency both linear-session.js
// and the hooks can build on without pulling in intake-breaker/card-disposition.
function normalizeStates(states) {
  if (Array.isArray(states)) return states;
  if (states && Array.isArray(states.nodes)) return states.nodes;
  return [];
}

function pickStateByName(states, name) {
  const list = normalizeStates(states);
  const target = String(name).toLowerCase();
  return list.find((s) => s && String(s.name).toLowerCase() === target) || null;
}

function pickStateByType(states, type) {
  const list = normalizeStates(states);
  return list.find((s) => s && s.type === type) || null;
}

/**
 * Decide what a `claim` should do, given the issue currently fetched from
 * Linear (or null if none matched) and the team's workflow states.
 *
 * - No issue found            -> create a new one, straight into "In Progress".
 * - Issue already "In Progress" (by name) -> noop, nothing to change.
 * - Issue in any other state (Todo, Backlog, In Review, Done, Canceled)
 *   -> activate: move it to "In Progress". This deliberately covers
 *   reopening a Done/Canceled issue too — a session claiming an issue means
 *   "I am working this now", and refusing to reopen would just leave the
 *   claim silently no-op'd with no sentinel written, defeating the point.
 *
 * @param {object} p
 * @param {object|null} p.issue Linear issue shape ({id, state:{name,type}, ...}) or null
 * @param {object|Array} p.states team.states (either shape, see normalizeStates)
 * @param {string} [p.requestedTitle] required when issue is null
 * @param {string} [p.requestedDescription]
 */
function planClaim({ issue, states, requestedTitle, requestedDescription }) {
  if (!issue) {
    if (!requestedTitle) {
      throw new Error('planClaim: no existing issue found and no requestedTitle given to create one');
    }
    const state = pickStateByName(states, CLAIM_STATE_NAME) || pickStateByType(states, 'started');
    if (!state) {
      throw new Error(`planClaim: no "${CLAIM_STATE_NAME}" (or any started-type) state found on this team`);
    }
    return {
      action: 'create',
      title: requestedTitle,
      description: requestedDescription || '',
      stateId: state.id,
      stateName: state.name,
    };
  }

  // Type-based, not name-based: team BRO has TWO states of type 'started'
  // (In Progress, In Review), and the dispatcher's own claim
  // (linear-next.js:reportDispatchOnIssue) can land an issue in either one —
  // BRO-387 itself was found sitting in "In Review" from its own dispatch.
  // Forcing every non-"In Progress" started state back to "In Progress"
  // would fight that: re-claiming an issue a PRIOR session correctly left in
  // "In Review" pending review would wrongly yank it back into progress.
  // "started" of any name means someone is actively on it — leave it alone.
  const currentType = issue.state && issue.state.type;
  if (currentType === 'started') {
    return { action: 'noop', issueId: issue.id, stateName: issue.state.name };
  }

  const state = pickStateByName(states, CLAIM_STATE_NAME) || pickStateByType(states, 'started');
  if (!state) {
    throw new Error(`planClaim: no "${CLAIM_STATE_NAME}" (or any started-type) state found on this team`);
  }
  return { action: 'activate', issueId: issue.id, stateId: state.id, stateName: state.name };
}

// Ad-hoc `claim --title=...` dedup: find an OPEN issue with this exact title
// (case-insensitive, trimmed) among issues already fetched by the caller.
// Deliberately NOT linear-client.js's searchIssues()/findOpenIssueForTerm —
// that pair is built for the alert router's conditionKey SUBSTRING dedupe
// (any open issue whose title/body CONTAINS the term), first-match, no
// descriptions unless explicitly fetched. Reusing it here would match a
// different issue that merely contains this title as a substring, or the
// wrong one first — this needs an exact title match, not a substring scan.
function findIssueByExactTitle(issues, title) {
  const target = String(title || '').trim().toLowerCase();
  if (!target) return null;
  const list = Array.isArray(issues) ? issues : [];
  return list.find((iss) => iss && String(iss.title || '').trim().toLowerCase() === target) || null;
}

// Tagged marker printed by `linear-session.js claim` on success, parsed by
// ~/.claude/hooks/linear-issue-verify.sh — same convention as
// notion-brain.js's __NOTION_CARD_ID__= marker (notion-create-verify.sh:46),
// chosen because it survives stdout being piped through tail/jq/grep in a
// way that "the last line was valid JSON" does not.
const ISSUE_ID_MARKER_PREFIX = '__LINEAR_ISSUE_ID__=';

function buildIssueIdMarker(id) {
  return `${ISSUE_ID_MARKER_PREFIX}${id}`;
}

// Three-tier parse, in order of reliability — mirrors notion-create-verify.sh's
// card_id extraction (marker -> JSON .id -> UUID regex) but as a pure,
// independently testable function instead of only existing as inline bash.
// `combined` is stdout+stderr concatenated (the marker may go to either
// stream depending on how the CLI is invoked); `stdout` alone is used for
// the JSON-parse tier since stderr is never valid JSON here.
function extractIssueId(combined, stdout) {
  const markerMatch = String(combined || '').match(/__LINEAR_ISSUE_ID__=([0-9a-f-]+)/i);
  if (markerMatch) return markerMatch[1];

  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed.id === 'string' && parsed.id) return parsed.id;
  } catch {
    // not JSON — fall through
  }

  const uuidMatch = String(stdout || '').match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  );
  return uuidMatch ? uuidMatch[0] : null;
}

// The literal every session-report comment opens with. Exported (BRO-2543)
// because linear-dispatch.js's reportedOutcomeGuard has to RECOGNISE these
// comments on an issue's thread, and a second hand-rolled copy of the string
// in that file is exactly the drift CLAUDE.md rule 15 forbids — the guard
// requires this module and matches against parseSessionReportStatus() rather
// than re-deriving the format. Kept without the trailing " (" so the same
// constant serves both the writer (which appends the status) and the reader.
const SESSION_REPORT_PREFIX = '**Session report';

// Pulls the status back out of a comment body this module wrote.
//
// Returns the lowercased status string ('done'/'in-review'/'paused'/
// 'blocked'), or null when the body is not a session report at all. A report
// carrying a status this module doesn't recognise still parses — the caller
// decides what to do with an unknown status, rather than this parser silently
// reclassifying it as "not a report" (a body that opens with the prefix IS a
// report, whatever the parenthetical says).
//
// Deliberately anchored at the START of the body: buildOutcomeCommentBody
// always puts the header on line 1, and matching mid-body would let a worker
// QUOTING a previous report (or this very guard's refusal text, which names
// the format) register as a fresh report of its own.
function parseSessionReportStatus(body) {
  const re = new RegExp('^' + SESSION_REPORT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\(([^)]*)\\)\\*\\*');
  const m = String(body == null ? '' : body).trim().match(re);
  return m ? m[1].trim().toLowerCase() : null;
}

/**
 * Formats the session-end outcome comment body posted to the Linear issue.
 * Mirrors what Notion's wrap-up writes into a card's Outcome/Key Files
 * fields (CLAUDE.md §6), collapsed into one comment since Linear issues
 * don't have equivalent structured fields.
 */
function buildOutcomeCommentBody({ summary, keyFiles, verification, status }) {
  if (!summary) throw new Error('buildOutcomeCommentBody: summary is required');
  const lines = [`${SESSION_REPORT_PREFIX} (${status || 'unknown'})**`, '', summary.trim()];

  const files = Array.isArray(keyFiles) ? keyFiles.filter(Boolean) : [];
  if (files.length) {
    lines.push('', '**Key files:**', files.map((f) => `- ${f}`).join('\n'));
  }

  if (verification) {
    lines.push('', '**Verification:**', verification.trim());
  }

  return lines.join('\n');
}

const VALID_STATUSES = new Set(['done', 'in-review', 'paused', 'blocked']);

/**
 * Decide what state change (if any) `report` should apply, given a status
 * string and the team's states.
 *
 * @returns {{stateId: string, stateName: string} | {stateId: null, stateName: null}}
 */
function planCompletion({ status, states }) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`planCompletion: unknown status "${status}" — expected one of ${[...VALID_STATUSES].join(', ')}`);
  }
  if (status === 'blocked') {
    return { stateId: null, stateName: null };
  }

  const targetName = STATUS_TO_STATE_NAME[status];
  let state = pickStateByName(states, targetName);
  if (!state) {
    state = pickStateByType(states, STATUS_TO_STATE_TYPE_FALLBACK[status]);
  }
  if (!state) {
    throw new Error(
      `planCompletion: no "${targetName}" (or ${STATUS_TO_STATE_TYPE_FALLBACK[status]}-type) state found on this team`
    );
  }
  return { stateId: state.id, stateName: state.name };
}

const BYPASS_RE = /NO-LINEAR-ISSUE:\s*\S{5,}/;

function hasBypass(text) {
  return BYPASS_RE.test(String(text || ''));
}

/**
 * The refusal-path check ~/.claude/hooks/linear-issue-required-stop.sh runs
 * at Stop: a session that touched tracked code must have REPORTED to a
 * Linear issue — not merely claimed one — before it's allowed to end.
 *
 * Gating on "claimed" alone (an earlier version of this function did) is a
 * strictly weaker bar than Notion's: a session can claim at start and then
 * never call `report`, and Linear never learns anything happened — exactly
 * the "quietly do work that never appears on the board" failure BRO-387
 * exists to close. `report` accepts status='blocked' (a comment with no
 * state change) for exactly the "genuinely can't finish" case, so requiring
 * a report never traps a stuck session — it just requires SAYING so on the
 * issue instead of silently stopping.
 *
 * @param {object} p
 * @param {boolean} p.trackedEditsMade did this session edit src/, scripts/,
 *   .github/workflows/, or top-level config?
 * @param {string|null} p.reportedIssueId issue id from the "report ran
 *   successfully this session" sentinel, or null
 * @param {string} [p.bypassText] assistant text to scan for NO-LINEAR-ISSUE: bypass
 */
function evaluateSessionClose({ trackedEditsMade, reportedIssueId, bypassText }) {
  if (!trackedEditsMade) {
    return { action: 'allow', reason: 'no tracked-code edits this session' };
  }
  if (reportedIssueId) {
    return { action: 'allow', reason: `issue ${reportedIssueId} reported on this session` };
  }
  if (hasBypass(bypassText)) {
    return { action: 'allow', reason: 'NO-LINEAR-ISSUE: bypass present' };
  }
  return {
    action: 'block',
    reason:
      'tracked-code edits made but no Linear issue was reported on this session (node scripts/linear-session.js ' +
      'report --issue=BRO-N --status=<done|in-review|paused|blocked> --summary=...); bypass with ' +
      'NO-LINEAR-ISSUE: <reason> if none applies',
  };
}

module.exports = {
  CLAIM_STATE_NAME,
  STATUS_TO_STATE_NAME,
  ISSUE_ID_MARKER_PREFIX,
  // Exported (S4-T1) so callers needing the state LIST — not just a lookup —
  // reuse this shape handling instead of re-deriving it. Every hand-rolled
  // copy so far has dropped the `{nodes:[…]}` case that getTeam() returns.
  normalizeStates,
  pickStateByName,
  pickStateByType,
  planClaim,
  findIssueByExactTitle,
  buildIssueIdMarker,
  extractIssueId,
  buildOutcomeCommentBody,
  SESSION_REPORT_PREFIX,
  parseSessionReportStatus,
  VALID_STATUSES,
  planCompletion,
  hasBypass,
  evaluateSessionClose,
};
