/**
 * linear-staleness-check.js — pure detection of "this issue moved without me
 * seeing it" (BRO-3869).
 *
 * BRO-3456: a sibling session ran a corrected significance test, concluded
 * the experiment, archived the flag, and deployed — all while this session
 * was independently still investigating the same card. This session's
 * re-entry into BRO-3456 never re-fetched the issue's CURRENT state/comments
 * before acting, so it filed BRO-3660 proposing to reactivate a flag that had
 * already been correctly, deliberately archived minutes earlier — a proposal
 * to revert a reviewed, shipped, production decision.
 *
 * This module is the pure decision half: given an issue (the shape
 * linear-client.getIssue() returns — state:{name,type},
 * comments:{nodes:[{id,body,createdAt,user}]}) and the ISO timestamp this
 * session last knew that issue's state, report what changed since then.
 * scripts/check-linear-staleness.js is the I/O wrapper that fetches the
 * issue and calls this; scripts/linear-session.js's `report --since=` wires
 * it into the one call every session already makes when closing out a card
 * (CLAUDE.md rule 15: pure logic lives in scripts/lib/, I/O wraps it).
 *
 * Deliberately non-blocking: a session finding a card changed since it last
 * looked isn't automatically wrong to keep working it — the point is to
 * surface the divergence to the owner BEFORE proposing or executing a
 * production-impacting action, not to auto-refuse. See the "checkRegistryConflict
 * is warn-only" precedent this mirrors in posthog-flag-admin-core.js.
 */

'use strict';

// linear-state-types.js (BRO-2466) is already "the one place that names
// Linear's terminal workflow-state TYPES" — its own header exists precisely
// to prevent a second, independent copy of this list drifting out of sync
// when a 4th terminal type ever shows up. An earlier version of this file
// hardcoded its own ['completed','canceled'] Set (missing 'duplicate' until
// an adversarial review caught it, BRO-3869) — exactly the drift that file
// was built to prevent. Derive from the canonical array instead of
// reintroducing a second hand-maintained copy. Kept as a Set (not the
// canonical Array) since every consumer here and in linear-session-
// reporting.js/linear-brain.js calls `.has()`.
const { TERMINAL_STATE_TYPES: CANONICAL_TERMINAL_STATE_TYPES } = require('./linear-state-types');
const TERMINAL_STATE_TYPES = new Set(CANONICAL_TERMINAL_STATE_TYPES);

// issue: linear-client.getIssue()'s return shape.
// sessionKnownAt: ISO 8601 string — when THIS session last knew the issue's
// state (its own claim time, last read, or last report on this issue — NOT
// the issue's creation date). Throws on missing/invalid input rather than
// silently treating "no timestamp" as "nothing changed", which would make
// the check a no-op exactly when a caller forgot to track it.
function checkIssueStaleness(issue, sessionKnownAt) {
  if (!issue) throw new Error('checkIssueStaleness: issue is required');
  if (!sessionKnownAt) throw new Error('checkIssueStaleness: sessionKnownAt (ISO timestamp) is required');

  const knownAtMs = Date.parse(sessionKnownAt);
  if (Number.isNaN(knownAtMs)) {
    throw new Error(`checkIssueStaleness: sessionKnownAt is not a valid date: ${sessionKnownAt}`);
  }
  // A future sessionKnownAt (bad clock, wrong timezone, a copy-pasted
  // placeholder) would silently suppress every real signal forever — every
  // comment and state change ever made is "before" it. 5min tolerance for
  // ordinary clock skew between this machine and Linear's server clock
  // (adversarial review finding, BRO-3869).
  if (knownAtMs > Date.now() + 5 * 60 * 1000) {
    throw new Error(`checkIssueStaleness: sessionKnownAt is in the future: ${sessionKnownAt}`);
  }

  const signals = [];

  const stateType = issue.state && issue.state.type;
  if (TERMINAL_STATE_TYPES.has(stateType)) {
    signals.push({
      type: 'terminal-state',
      detail: `Issue is already in a terminal state ("${issue.state.name}") — someone concluded it.`,
    });
  }

  const comments = (issue.comments && issue.comments.nodes) || [];
  const newComments = comments.filter((c) => c && c.createdAt && Date.parse(c.createdAt) > knownAtMs);
  if (newComments.length > 0) {
    const authors = [...new Set(newComments.map((c) => (c.user && c.user.name) || 'unknown'))];
    signals.push({
      type: 'new-comments',
      detail: `${newComments.length} comment(s) posted after ${sessionKnownAt} by ${authors.join(', ')} — this session hasn't seen them.`,
      comments: newComments.map((c) => ({
        id: c.id,
        createdAt: c.createdAt,
        author: (c.user && c.user.name) || 'unknown',
      })),
    });
  }

  return { stale: signals.length > 0, signals };
}

// Sorted-ascending copy of a comments connection's nodes, truncated to the
// newest `n`. Shared by every caller that wants "the last N comments" from a
// Linear issue query — the comments(first: 50, orderBy: createdAt) connection
// does NOT reliably return createdAt-ascending order (confirmed live against
// BRO-3456: it comes back newest-first despite the query's orderBy), so a
// bare `.slice(-n)` on the raw nodes silently shows the OLDEST n instead
// (code-review finding, BRO-3869). Extracted here rather than duplicated in
// every caller (linear-session.js's cmdClaim, linear-brain.js's update) —
// same technique as linear-dispatch.js's sortedCommentBodies, but keeping
// the full {id, createdAt, user, body} shape callers need to print an
// attributed excerpt, not just the body string.
function newestComments(issue, n) {
  const nodes = (issue && issue.comments && issue.comments.nodes) || [];
  return nodes
    .slice()
    .sort((a, b) => {
      const ca = String((a && a.createdAt) || '');
      const cb = String((b && b.createdAt) || '');
      return ca < cb ? -1 : ca > cb ? 1 : 0;
    })
    .slice(-n);
}

module.exports = { checkIssueStaleness, TERMINAL_STATE_TYPES, newestComments };
