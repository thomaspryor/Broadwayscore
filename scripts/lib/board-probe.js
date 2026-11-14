#!/usr/bin/env node
// scripts/lib/board-probe.js — the THREE-WAY board health verdict the gate
// hooks branch on. Pure classification: no fetch, no fs, no process.
//
// Task S1-T2 of sprint-plan-notion-linear-cutover.md, and the reason Sprint 4
// can safely rewrite the gate hooks at all.
//
// Today ~/.claude/hooks/notion-card-required-commit.sh has only a TWO-way
// answer: a 4-second probe either exits 0 or it doesn't (:56). "Exits 0" means
// enforce, and everything else means fail open. That collapses two very
// different worlds into one:
//
//   * unreachable — no HTTP response at all (DNS, refused, timeout). The board
//     is gone. CLAUDE.md §6 says warn and continue, so: fail open.
//   * erroring    — the board answered, and the answer was unusable (401 on a
//     rotated key, 5xx, a GraphQL error, no key configured at all). Today this
//     ENFORCES, because the probe process exits non-zero for a reason the hook
//     cannot see... or exits zero having proved nothing. Either way a
//     rate-limit blip or an expired token turns into a fleet-wide commit
//     outage that no session can repair, since repairing it requires
//     committing. S4-T3b makes this fail open too, and it can only do that if
//     something tells it the difference.
//   * healthy     — reached, authenticated, answered with data. Enforce.
//
// The verdict WORD is the contract the bash hooks grep for. Do not rename one
// without S4-T3b.

'use strict';

const retryPolicy = require('./linear-retry-policy');

const VERDICTS = {
  HEALTHY: 'healthy',
  ERRORING: 'erroring',
  UNREACHABLE: 'unreachable',
};

// Distinct non-zero codes so a caller that only has `$?` (a bash hook) can
// still tell the two failure worlds apart without parsing stdout.
const EXIT_CODES = {
  [VERDICTS.HEALTHY]: 0,
  [VERDICTS.ERRORING]: 3,
  [VERDICTS.UNREACHABLE]: 4,
};

/**
 * @param {Error} err  thrown by linear-client.graphql()
 * @returns {{verdict: string, reason: string}}
 */
function classifyProbeError(err) {
  if (!err) return { verdict: VERDICTS.HEALTHY, reason: 'ok' };

  // No credential is a local misconfiguration, not a dead network. Calling it
  // `unreachable` would be a lie that reads as "Linear is down" in a digest,
  // and would send someone to check Linear's status page instead of .env.
  if (/LINEAR_API_KEY not set/i.test(String(err.message || ''))) {
    return { verdict: VERDICTS.ERRORING, reason: 'no-api-key' };
  }

  // graphql() attaches .status only when an HTTP response actually came back,
  // so its presence is the proof that the host answered.
  if (Number.isFinite(err.status)) {
    return { verdict: VERDICTS.ERRORING, reason: `http-${err.status}` };
  }

  // A GraphQL-level error means HTTP 200 with an error body — maximally
  // reachable, still unusable.
  if (Array.isArray(err.linearErrors) && err.linearErrors.length) {
    const codes = err.linearErrors
      .map((e) => (e && e.extensions && e.extensions.code) || null)
      .filter(Boolean);
    return { verdict: VERDICTS.ERRORING, reason: codes.length ? `graphql-${codes.join(',')}` : 'graphql-error' };
  }

  // Timeout, DNS failure, connection refused, socket reset: nothing answered.
  if (retryPolicy.isTransientNetworkError(err)) {
    // name before code: undici sets `code` to a bare numeric DOMException code
    // (23) on an AbortSignal timeout, which reads as noise in a hook log,
    // while `name` is the useful "TimeoutError".
    const label = err.name || err.code || 'network';
    return { verdict: VERDICTS.UNREACHABLE, reason: /^[0-9]+$/.test(String(label)) ? 'network' : String(label) };
  }

  // Anything left is a bug in our own client rather than a statement about the
  // board. Grade it erroring, not unreachable: claiming the network is down on
  // the strength of an unrecognised exception is exactly the wrong direction
  // for a health check to guess in.
  return { verdict: VERDICTS.ERRORING, reason: 'unclassified' };
}

// One line, verdict word first, so a hook can do
// `grep -o 'BOARD_PROBE: [a-z]*'` and get the contract with no parsing.
function formatProbeLine(board, verdict, reason, detail) {
  const tail = detail ? ` — ${detail}` : '';
  return `BOARD_PROBE: ${verdict} board=${board} reason=${reason}${tail}`;
}

module.exports = { VERDICTS, EXIT_CODES, classifyProbeError, formatProbeLine };
