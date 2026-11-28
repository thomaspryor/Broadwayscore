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
  'with a stated reason, or --self when this session is already doing the work. Neither was given — that silent third state is the bug this gate exists to close.\n' +
  '  --dispatch                   create it and let a worker take it\n' +
  '  --self                       create it In Progress, claimed by this session (its own work, BRO-6130)\n' +
  '  --child "<what>"             create it In Progress, claimed, for a child session this one is starting now (BRO-6359)\n' +
  `  --park "<reason (>=${MIN_PARK_REASON_LENGTH} chars)>"  create it parked, with a reason a reader can act on`;

/**
 * @param {{dispatch?: boolean, park?: string|boolean, self?: boolean}} opts
 * @returns {{ok: true, mode: 'dispatch'|'park'|'self', reason?: string} | {ok: false, reason: string, message: string}}
 */
function resolveDisposition({ dispatch, park, self, child } = {}) {
  const hasDispatch = !!dispatch;
  // BRO-6359: --child "<what>" = a child session is starting on this card now; filed exactly like --self
  // (In Progress, claimed) so no worker takes it.
  const hasSelf = !!self || (typeof child === 'string' && child.trim().length >= MIN_PARK_REASON_LENGTH);
  // A bare `--park` with no value parses as `true`, not a string — treat that
  // the same as "no reason given" rather than silently accepting it.
  const hasPark = typeof park === 'string' && park.trim().length > 0;
  const parkGivenButEmpty = !hasPark && (park === true || (typeof park === 'string' && park.trim().length === 0));

  const given = [hasDispatch, hasSelf, hasPark || parkGivenButEmpty].filter(Boolean).length;
  if (given > 1) {
    return {
      ok: false,
      reason: 'BOTH_FLAGS',
      message: 'Pass exactly one of --dispatch, --self, --child or --park "<reason>".',
    };
  }

  if (!hasDispatch && !hasSelf && !hasPark && !parkGivenButEmpty) {
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

  if (hasSelf) return { ok: true, mode: 'self' };
  if (hasDispatch) return { ok: true, mode: 'dispatch' };
  return { ok: true, mode: 'park', reason: park.trim() };
}

module.exports = { resolveDisposition, MIN_PARK_REASON_LENGTH, USAGE_MESSAGE };
