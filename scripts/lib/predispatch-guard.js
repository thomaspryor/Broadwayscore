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
const { notionIdOf } = require('./dispatch-guards.js');

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

/**
 * predispatchGuard — the wired-in dispatch-path caller of classifyCandidate
 * (task #1800). Until now classifyCandidate was only reachable by a human
 * running `node scripts/predispatch-check.js --id N` by hand; nothing in the
 * real dispatch path (bsc-next.js) ever called it, so a falsely-reopened
 * card sailed straight into a wasted auto-dispatch.
 *
 * Lives here, not in scripts/lib/dispatch-guards.js, despite matching that
 * file's card-reading guard shape (closedCardGuard, staleOutcomeGuard):
 * dispatch-guards.js is explicitly the SHARED layer between bsc-next.js and
 * linear-next.js, and linear-next.js's dispatch path never fetches a Notion
 * card at all — a single-caller function does not belong in the multi-
 * dispatcher shared file. This file's own header already draws the correct
 * line: pure decision logic lives here, all I/O in the CLI wrapper — a
 * thin pure wrapper around classifyCandidate belongs at the same layer.
 *
 * Corpus-validated before being wired in as a live blocking refusal (plan
 * review, task #1800): run against every pending/in_progress card in the
 * live task mirror (208 cards), 30 classified REOPEN-SUSPECT. Three
 * spot-checked by hand all shared the identical root cause — Auto-corrected
 * ... by reconcile-dead-completions: task #N was marked completed while its
 * dispatch was journaled dead ... this card had been incorrectly pushed to
 * Done — confirming these are genuine false-reopens (redispatching them
 * would relaunch already-shipped work), not a heuristic false-positive
 * problem.
 *
 * CHECK-FIRST and OK-TO-DISPATCH are deliberately non-blocking here — this
 * matches predispatch-check.js's own CLI exit-code contract
 * (predispatch-check.js:109), which only treats DO-NOT-DISPATCH and
 * REOPEN-SUSPECT as refusals.
 *
 * `--allow-reopen-suspect` (not --force): dispatch-guards.js:242's comment
 * on closedCardGuard's own --allow-closed-card explains why --force
 * deliberately never bypasses a closed-card-shaped refusal — a dedicated,
 * ledger-visible flag is the escape hatch instead. Same philosophy applies
 * here: a card classified DO-NOT-DISPATCH/REOPEN-SUSPECT needs its own
 * explicit override, not the general-purpose --force.
 *
 * `card == null` (degraded Notion fetch) ALLOWS, same "honest unknown, never
 * refuse" contract every sibling guard in dispatch-guards.js uses — a
 * refusal here would let a Notion outage block dispatch entirely.
 *
 * Bug caught by bsc-next.test.mjs's existing --allow-closed-card coverage:
 * when card.status is a plain terminal Done/Archived/Cancelled (no PARKED
 * marker, not REOPEN-SUSPECT-shaped), classifyCandidate's DO-NOT-DISPATCH
 * here is the SAME refusal class closedCardGuard already gates on — the
 * caller who passed --allow-closed-card already authorized dispatching a
 * closed card and must not be asked for a second, redundant flag. Only that
 * narrow case defers to --allow-closed-card; a PARKED: note or a Paused
 * status (which closedCardGuard deliberately never treats as closed) still
 * needs --allow-reopen-suspect.
 *
 * @param {DispatchGuardTask} task
 * @param {object|null} card - notion-brain.js `get <uuid>` output, or null
 *   when the fetch degraded
 * @param {object} opts - CLI args object (checked for allow-reopen-suspect,
 *   allow-closed-card, dry-run, print-prompt)
 * @returns {string|null} a refusal message, or null to allow dispatch
 */
function predispatchGuard(task, card, opts) {
  const o = opts || {};
  if (o['allow-reopen-suspect'] || o['dry-run'] || o['print-prompt']) return null;
  if (!card) return null;
  const result = classifyCandidate({ card, task });
  if (result.verdict !== 'DO-NOT-DISPATCH' && result.verdict !== 'REOPEN-SUSPECT') return null;
  if (o['allow-closed-card'] && result.verdict === 'DO-NOT-DISPATCH' &&
    TERMINAL_CARD_STATUSES.has(card.status) && result.flags.includes(`card-status-terminal:${card.status}`)) {
    return null;
  }
  const pid = notionIdOf(task);
  const flagText = result.flags.length ? ` (${result.flags.join(', ')})` : '';
  const why = result.verdict === 'REOPEN-SUSPECT'
    ? 'the card carries a completedDate plus a substantial recorded Outcome and what looks like a commit sha — this looks like real finished work that a dispatch would redo, not a fresh task.'
    : 'the card is explicitly marked not-dispatchable right now (a PARKED: note, or a terminal/Paused status).';
  return `REFUSING to dispatch #${task.id}: predispatch-guard classifies its Notion card ${result.verdict}${flagText} — ${why}\n` +
    `  Fix one of:\n` +
    `    1. Verify by hand: node scripts/predispatch-check.js --id ${task.id}${pid ? ` (or: node scripts/notion-brain.js get ${pid})` : ''}\n` +
    `    2. If it's genuinely fresh work, correct the card in Notion (clear the stale Outcome, or un-park it), then dispatch again.\n` +
    `    3. Re-run with --allow-reopen-suspect to dispatch anyway (recorded in the ledger).`;
}

module.exports = { classifyCandidate, resolveNotionUuid, REVIEW_STATUSES, predispatchGuard };
