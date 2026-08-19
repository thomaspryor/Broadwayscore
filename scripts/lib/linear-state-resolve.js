#!/usr/bin/env node
// scripts/lib/linear-state-resolve.js — resolve a user-typed workflow state
// name to a real Linear state (S4-T1 of sprint-plan-notion-linear-cutover.md).
//
// PURE, and separate from linear-brain.js, for the reason CLAUDE.md rule 15
// gives: the interesting behaviour here is what happens on a name that does
// NOT match, and that is only testable without a network stub if it is pure.
//
// WHY THIS IS NOT A notion-brain STATUS TRANSLATION. notion-brain.js speaks
// `--status Done|Paused` — a fixed four-value vocabulary belonging to the
// Notion board. Linear's states are per-team, configurable, and carry a `type`
// the names do not expose. The plan is explicit that this must NOT half-mirror
// the Notion vocabulary, and the alert-router repoint already refused the same
// temptation: a translation layer that maps "Paused" onto whatever Linear state
// looks closest is a guess that silently moves work to the wrong column. So the
// caller names a REAL Linear state, and an unrecognised name is an error that
// prints the actual valid set rather than being coerced.

'use strict';

/**
 * @param {string} wanted            the state name the user typed
 * @param {Array<{id,name,type}>} states  the team's workflow states
 * @returns {{ok: true, state: object} | {ok: false, error: string, valid: string[]}}
 *
 * Case- and whitespace-insensitive, because "done" vs "Done" is a typo, not a
 * different intent — but nothing fuzzier than that. No prefix matching, no
 * nearest-neighbour: "Do" must not silently resolve to "Done" when a team also
 * has "Doing".
 */
function resolveState(wanted, states) {
  const list = Array.isArray(states) ? states.filter((s) => s && s.name) : [];
  const valid = list.map((s) => s.name);
  const w = String(wanted == null ? '' : wanted).trim();

  if (!w) {
    return { ok: false, error: 'no state name given', valid };
  }
  const hit = list.find((s) => s.name.toLowerCase() === w.toLowerCase());
  if (!hit) {
    return { ok: false, error: `unknown state "${w}"`, valid };
  }
  return { ok: true, state: hit };
}

/**
 * The message a caller prints on failure. Kept here so the CLI and its test
 * assert the same string — the acceptance criterion is that an unknown state
 * "exits non-zero with the valid states listed", and a test that hand-writes
 * its own expected message proves nothing about what the CLI actually prints.
 */
function formatStateError(result) {
  const valid = result.valid && result.valid.length ? result.valid.join(', ') : '(none found on this team)';
  return `${result.error}. Valid states: ${valid}`;
}

module.exports = { resolveState, formatStateError };
