/**
 * predispatch-guard.js — pure decision logic for "is this Notion card safe to
 * auto-dispatch right now", promoted out of the ad-hoc predispatch-check.sh +
 * pd_meta.py + pd_cmd.py trio every BRO-343 crown session was hand-rebuilding
 * in its own scratchpad (Notion 3c0637c5-416f-8165, task #1794). The
 * scratchpad died with the session each time, so the same 6 bugs kept
 * getting rediscovered instead of fixed once — see the header of
 * predispatch-guard.test.mjs for the numbered list this file closes.
 *
 * Pure functions only — no fs, no child_process, no network. The CLI wrapper
 * (scripts/predispatch-check.js) owns all I/O: reading the local task
 * mirror, calling notion-brain.js get, printing the verdict.
 */

'use strict';

const { evaluateVerifiability } = require('./verify-gate.js');
const { TERMINAL_CARD_STATUSES } = require('./task-reclaim.js');

const PARKED_RE = /^\s*PARKED:/i;
const SHA_RE = /\b[0-9a-f]{7,40}\b/i;
const REOPEN_SUSPECT_MIN_OUTCOME_LEN = 40;

// The source card explicitly groups Paused with Done for this check
// ("cards Done/Paused vs falsely-reopened ... needed the REOPEN-SUSPECT
// verdict") — reuses task-reclaim.js's canonical TERMINAL_CARD_STATUSES
// (Done/Archived/Cancelled, the same set dispatch-guards.js's
// CLOSED_CARD_STATUSES is built from) rather than declaring a parallel list,
// plus the one addition ('Paused') this check specifically needs.
const REVIEW_STATUSES = new Set([...TERMINAL_CARD_STATUSES, 'Paused']);

function looksLikeReopenSuspect(card) {
  const outcome = String(card.outcome || '');
  return Boolean(card.completedDate)
    && outcome.length >= REOPEN_SUSPECT_MIN_OUTCOME_LEN
    && SHA_RE.test(outcome);
}

/**
 * @param {{card: object, task?: object}} args - card is notion-brain.js
 *   `get <uuid>` output shape ({name, status, notes, outcome,
 *   completedDate, ...}); task is the optional local task-mirror record.
 * @returns {{verdict: 'DO-NOT-DISPATCH'|'REOPEN-SUSPECT'|'CHECK-FIRST'|'OK-TO-DISPATCH',
 *            status: string|null, name: string|null, flags: string[],
 *            acceptanceCommand?: string}}
 */
function classifyCandidate({ card, task } = {}) {
  if (!card || typeof card !== 'object') {
    throw new TypeError('classifyCandidate requires a card object (from notion-brain.js get)');
  }
  const status = card.status || null;
  const name = card.name || (task && task.subject) || null;
  const notes = String(card.notes || '');
  const flags = [];

  // Failure mode 3: a card whose STATUS reads 'Not started' (so every other
  // check below would wave it through) but whose NOTES open with a literal
  // PARKED: marker is an explicit human override — checked first, unaffected
  // by status.
  if (PARKED_RE.test(notes)) {
    flags.push('parked-marker-in-notes');
    return { verdict: 'DO-NOT-DISPATCH', status, name, flags };
  }

  // Failure mode 5 (regression fix, #1798): a card with a completedDate, a
  // substantial outcome, and a git sha embedded in it looks like real
  // finished work that a dispatch would re-do — checked BEFORE the
  // REVIEW_STATUSES branch below, and regardless of status, because the
  // failure mode this exists to catch is a card whose status was falsely
  // flipped back to 'Not started' (e.g. by reconcile-dead-completions) while
  // still carrying that completed-work evidence. Gating this check on
  // status already being terminal (Done/Paused) made it unreachable for
  // exactly the cards it was built to catch — those never reach a terminal
  // branch at all.
  if (looksLikeReopenSuspect(card)) {
    flags.push('completed-with-outcome-and-sha');
    return { verdict: 'REOPEN-SUSPECT', status, name, flags };
  }

  if (REVIEW_STATUSES.has(status)) {
    flags.push(`card-status-terminal:${status}`);
    return { verdict: 'DO-NOT-DISPATCH', status, name, flags };
  }

  // Failure mode 4 (and its consequence): reuse the fleet's one canonical
  // safe-form acceptance-command extractor (evaluateVerifiability, backed by
  // SAFE_CHECK_FORMS in autonomous-triage-core.js) instead of a second,
  // narrower allow-list. That extractor's `node --test` form is already
  // variadic (multi-file) — a hand-rolled duplicate here is exactly the
  // drift CLAUDE.md rule 15 exists to prevent, and re-deriving a
  // single-file-only regex is literally how failure mode 4 happened the
  // first time (the scratchpad's pd_cmd.py never had access to this file).
  const { armed, cmd } = evaluateVerifiability(notes);
  if (armed && cmd) {
    flags.push('acceptance-command-available');
    return { verdict: 'CHECK-FIRST', status, name, flags, acceptanceCommand: cmd };
  }

  return { verdict: 'OK-TO-DISPATCH', status, name, flags };
}

/**
 * Resolve a Notion page uuid out of free text (a URL, a dry-run seed prompt,
 * anything). Deliberately does NOT parse Notion's slug grammar — a
 * character-class parse of "everything before the uuid" is exactly what
 * broke on an underscore in the slug (failure mode 6, task #1793: slug
 * contained 'HEAD_TRUSTED_CLEAN'), silently producing no match and a false
 * SKIP-UNKNOWN for a healthy, dispatchable card. Instead this scans the
 * whole string for 32-hex runs and takes the LAST one — that is always
 * where Notion places the id, regardless of what punctuation the slug uses.
 *
 * Prefer a structured id when one is available (e.g. task.description's
 * `[notion:<uuid>]` tag, via dispatch-guards.js's notionIdOf()) — this is
 * the fallback for callers that only have raw text.
 */
function resolveNotionUuid(text) {
  if (typeof text !== 'string') return null;
  const matches = text.match(/[0-9a-f]{32}/gi);
  if (!matches || !matches.length) return null;
  return matches[matches.length - 1].toLowerCase();
}

module.exports = { classifyCandidate, resolveNotionUuid, REVIEW_STATUSES };
