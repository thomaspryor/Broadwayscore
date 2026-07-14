// Pure state machine for the autonomous nightly work loop's per-card automation
// state (persisted in a Notion select property called "Auto").
//
// Role: the nightly loop marks Notion cards as it triages, attempts, and merges
// work; approvals arrive via signed email taps; the CI merge step re-verifies the
// rebased diff before landing. This module is the single source of truth for
// which state moves are legal — callers never write "Auto" values directly.
//
// Wedge cases (one line each):
// - merge.stale-branch:  branch GC'd/deleted between approval and merge → failed ('stale-approval').
// - tap.reject on approved: a reject always beats a standing approval (owner changed mind pre-merge).
// - merge.reverify-fail: CI re-verify failed on the rebased diff → back to needs-approval; the
//   approval is STRIPPED, so merge.success from needs-approval throws (a fresh tap is required).
// - merge.oscillation:   ledger shows the same card already merged 2+ times → failed ('oscillation');
//   hard stop, never auto-revert.
// - split.children-terminal: all child cards of a split reached a terminal state → parent merged.
// - run.auto-approve (Sprint 3): a deterministic-green diff (test/docs/fixtures ONLY —
//   scripts/lib/autonomous-eligibility.js isDiffDeterministicGreen) skips the human tap
//   entirely. This is a MECHANICAL file-path predicate, never a model judgment call
//   ("confident prose is not safety" — owner spec 2026-07-14). Judged/behavior-changing
//   diffs always land in needs-approval via run.pass, same as before.
// - tap.revert (Sprint 3): the owner's post-merge Undo tap. Only legal from 'merged' —
//   you cannot revert work that was rejected or never landed. Reopens the card
//   ('reverted' is terminal-adjacent but the card returns to the human backlog, not
//   re-queued by the loop — clearing Auto is a separate, human-only step).
//
// Idempotency: an event whose target equals the current state returns
// { next: current, noop: true } so callers can safely replay taps/webhooks.
// Every other (state, event) pair throws — never a silent no-op, never a default.

'use strict';

const STATES = [
  '', // empty = untriaged
  'queued',
  'attempted',
  'needs-approval',
  'approved',
  'merged',
  'rejected',
  'failed',
  'split-proposed',
  'reverted',
];

// Raw transition table: event → { from, to, reasonRequired?, autoReason? }.
// Exported for exhaustive test enumeration.
const TRANSITIONS = {
  'triage.eligible': { from: '', to: 'queued' },
  'triage.split': { from: '', to: 'split-proposed' },
  'triage.fail': { from: '', to: 'failed', reasonRequired: true },
  'run.claim': { from: 'queued', to: 'attempted' },
  'run.pass': { from: 'attempted', to: 'needs-approval' },
  'run.fail': { from: 'attempted', to: 'failed', reasonRequired: true },
  // Deterministic-green diffs (Sprint 3): skip the human tap entirely. Gated
  // by the pure file-path predicate isDiffDeterministicGreen, never by an
  // LLM's confidence — see the wedge-case note above.
  'run.auto-approve': { from: 'attempted', to: 'approved', autoReason: 'deterministic-green' },
  'tap.approve': { from: 'needs-approval', to: 'approved' },
  // tap.reject accepts multiple source states: needs-approval, and approved
  // (a reject always beats a standing approval before merge runs).
  'tap.reject': { from: ['needs-approval', 'approved'], to: 'rejected' },
  'merge.success': { from: 'approved', to: 'merged' },
  'merge.stale-branch': { from: 'approved', to: 'failed', autoReason: 'stale-approval' },
  'merge.reverify-fail': { from: 'approved', to: 'needs-approval' },
  'merge.oscillation': { from: 'approved', to: 'failed', autoReason: 'oscillation' },
  'split.children-terminal': { from: 'split-proposed', to: 'merged' },
  // Owner's post-merge Undo tap (Sprint 3). Only 'merged' can be reverted.
  'tap.revert': { from: 'merged', to: 'reverted' },
};

const EVENTS = Object.keys(TRANSITIONS);

const TERMINAL_STATES = new Set(['merged', 'rejected', 'failed', 'reverted']);

function displayState(state) {
  return state === '' ? '(empty)' : state;
}

/**
 * Apply an event to the current state.
 * @param {string} current - one of STATES ('' allowed = untriaged)
 * @param {string} event - one of EVENTS
 * @param {{ reason?: string }} [opts]
 * @returns {{ next: string, reason: string|null, noop?: true }}
 * @throws on unknown state, unknown event, invalid (state, event) pair,
 *         or missing reason for a reason-required event.
 */
function transition(current, event, opts = {}) {
  if (!STATES.includes(current)) {
    throw new Error(`unknown state: ${displayState(current)}`);
  }
  const rule = TRANSITIONS[event];
  if (!rule) {
    throw new Error(`unknown event: ${event}`);
  }

  const froms = Array.isArray(rule.from) ? rule.from : [rule.from];

  if (froms.includes(current)) {
    const reason = opts.reason || rule.autoReason || null;
    if (rule.reasonRequired && !reason) {
      throw new Error(`reason required for ${event}`);
    }
    return { next: rule.to, reason };
  }

  // Idempotent replay: event whose target equals the current state.
  if (rule.to === current) {
    return { next: current, noop: true };
  }

  throw new Error(`invalid transition: ${displayState(current)} + ${event}`);
}

/**
 * @param {string} state
 * @returns {boolean} true for merged, rejected, failed, reverted.
 */
function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

module.exports = { STATES, EVENTS, TRANSITIONS, transition, isTerminal };
