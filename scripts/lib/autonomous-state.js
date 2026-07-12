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
  'tap.approve': { from: 'needs-approval', to: 'approved' },
  // tap.reject accepts multiple source states: needs-approval, and approved
  // (a reject always beats a standing approval before merge runs).
  'tap.reject': { from: ['needs-approval', 'approved'], to: 'rejected' },
  'merge.success': { from: 'approved', to: 'merged' },
  'merge.stale-branch': { from: 'approved', to: 'failed', autoReason: 'stale-approval' },
  'merge.reverify-fail': { from: 'approved', to: 'needs-approval' },
  'merge.oscillation': { from: 'approved', to: 'failed', autoReason: 'oscillation' },
  'split.children-terminal': { from: 'split-proposed', to: 'merged' },
};

const EVENTS = Object.keys(TRANSITIONS);

const TERMINAL_STATES = new Set(['merged', 'rejected', 'failed']);

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
 * @returns {boolean} true for merged, rejected, failed.
 */
function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

module.exports = { STATES, EVENTS, TRANSITIONS, transition, isTerminal };
