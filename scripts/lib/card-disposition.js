/**
 * card-disposition.js — the single gate every card/issue creator (Notion,
 * Linear, whatever comes next) must pass through before filing.
 *
 * Card creation and dispatch used to be two separate steps, and the second
 * one was optional — so the default outcome of noticing a problem was a
 * card nobody worked (measured 2026-08-12: 11 items filed, 1 dispatched,
 * only after the owner asked twice). Making the choice REQUIRED, with no
 * default, is what closes that gap: a caller cannot file a card without
 * saying, right there, whether it's being worked now or why it isn't.
 *
 * Pure and side-effect-free on purpose (CLAUDE.md rule 15) so both
 * notion-brain.js and the Linear issue chokepoint share one tested gate
 * instead of two hand-rolled copies that drift.
 */

'use strict';

const MIN_PARK_REASON_LENGTH = 10;

const USAGE_MESSAGE =
  'Card creation must decide: pass --dispatch to work it now, or --park "<reason>" to park it ' +
  'with a stated reason. Neither was given — that silent third state is the bug this gate exists to close.\n' +
  '  --dispatch                   create it and work it now\n' +
  `  --park "<reason (>=${MIN_PARK_REASON_LENGTH} chars)>"  create it parked, with a reason a reader can act on`;

/**
 * @param {{dispatch?: boolean, park?: string|boolean}} opts
 * @returns {{ok: true, mode: 'dispatch'|'park', reason?: string} | {ok: false, reason: string, message: string}}
 */
function resolveDisposition({ dispatch, park } = {}) {
  const hasDispatch = !!dispatch;
  // A bare `--park` with no value parses as `true`, not a string — treat that
  // the same as "no reason given" rather than silently accepting it.
  const hasPark = typeof park === 'string' && park.trim().length > 0;
  const parkGivenButEmpty = !hasPark && (park === true || (typeof park === 'string' && park.trim().length === 0));

  if (hasDispatch && (hasPark || parkGivenButEmpty)) {
    return {
      ok: false,
      reason: 'BOTH_FLAGS',
      message: 'Pass exactly one of --dispatch or --park "<reason>", not both.',
    };
  }

  if (!hasDispatch && !hasPark && !parkGivenButEmpty) {
    return { ok: false, reason: 'NO_DISPOSITION', message: USAGE_MESSAGE };
  }

  if (parkGivenButEmpty) {
    return {
      ok: false,
      reason: 'PARK_REASON_MISSING',
      message: `--park requires a reason: --park "<reason (>=${MIN_PARK_REASON_LENGTH} chars)>".`,
    };
  }

  if (hasPark && park.trim().length < MIN_PARK_REASON_LENGTH) {
    return {
      ok: false,
      reason: 'PARK_REASON_TOO_SHORT',
      message:
        `--park reason must be at least ${MIN_PARK_REASON_LENGTH} characters ` +
        `("${park.trim()}" is ${park.trim().length}). State WHY this isn't being worked now — ` +
        `"why is nothing happening on this" must be answerable from the card.`,
    };
  }

  if (hasDispatch) return { ok: true, mode: 'dispatch' };
  return { ok: true, mode: 'park', reason: park.trim() };
}

module.exports = { resolveDisposition, MIN_PARK_REASON_LENGTH, USAGE_MESSAGE };
