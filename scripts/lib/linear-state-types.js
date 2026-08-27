/**
 * linear-state-types.js — the one place that names Linear's terminal
 * workflow-state TYPES (BRO-2466). The BRO team has three: `completed`,
 * `canceled`, and `duplicate` — an issue moved to Duplicate is exactly as
 * resolved as one moved to Done or Canceled, but every open-issue query and
 * terminal-state guard in this repo used to test only the first two, so a
 * mass backlog-triage move into Duplicate (BRO-343, 19 issues on
 * 2026-08-26) silently re-counted all of them as open. Centralized here so a
 * fourth terminal type (Linear does add these — `duplicate` itself didn't
 * always exist) is a one-line change instead of re-hunting every call site,
 * the same drift trap linear-done-gate.js:14 documents for state NAMES.
 *
 * Confirmed live 2026-08-26: Linear populates `canceledAt` (not a separate
 * field) for `duplicate`-type issues, so linear-cap-policy.js's existing
 * completed/canceled closedAt fallback needs no third branch — only the
 * terminal-type guard itself needs to admit `duplicate`.
 *
 * Deliberately NOT used by linear-done-gate.js: that gate only cares about
 * transitions INTO `completed` (evidence-of-shipped-work), so a move into
 * Duplicate (or Canceled) is legitimately ungated — see its own header.
 */

'use strict';

const TERMINAL_STATE_TYPES = ['completed', 'canceled', 'duplicate'];

function isTerminalStateType(stateType) {
  return TERMINAL_STATE_TYPES.includes(stateType);
}

module.exports = { TERMINAL_STATE_TYPES, isTerminalStateType };
