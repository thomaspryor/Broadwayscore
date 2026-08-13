#!/usr/bin/env node
/**
 * intake-breaker.js — a daily circuit breaker on issue CREATION.
 *
 * WHY. The flow audit of 2026-08-12 measured real intake at 34.3 cards/day
 * against real burn-down of 5.7/day: net +28.6/day and accelerating (weekly net
 * +85, +93, +202, +336, +170). 1,577 of 1,947 open cards were session-authored,
 * so sessions are the pump, not the bots. And nothing anywhere bounded creation:
 * every filer could mint issues without limit, which is how a single looping
 * workflow or a confused session can add a hundred cards nobody asked for.
 *
 * WHAT THIS IS NOT. This is deliberately NOT the WIP cap the audit recommends
 * ("above N open cards, reject unless the caller closes one"). A WIP cap is a
 * policy decision about how the owner wants to work and it changes behaviour on
 * a normal day; it needs his sign-off. This is the narrower, uncontroversial
 * half: a breaker sized ABOVE normal volume that only trips on a storm. On a
 * 34-card day it does nothing. On a 200-card runaway it stops the bleeding and
 * says so loudly.
 *
 * FAIL-OPEN, DELIBERATELY. If the ledger is unreadable this ALLOWS the create.
 * That is the opposite of the choice made in audit-archived-in-progress.js,
 * which refuses when its ledger is missing, and the asymmetry is intentional:
 *   - there, absent input made an ANSWER wrong ("nothing ever started"), so
 *     refusing to answer is correct;
 *   - here, absent input would make a GUARD wrong, and a guard that fails closed
 *     wedges all issue creation across every session and workflow on the
 *     machine. Losing a breaker for one run is recoverable; losing the ability
 *     to file anything is not.
 * The ledger is gitignored (it is append-only local telemetry, and a tracked
 * file every session appends to is a merge-conflict generator), so "absent" is
 * a completely normal state in a fresh worktree.
 *
 * Escape hatch: INTAKE_BREAKER_DISABLED=1 bypasses it entirely, and the refusal
 * message says so, because a breaker with no documented override gets worked
 * around by deleting it.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const LEDGER_PATH = path.join(REPO, 'data', 'audit', 'intake-ledger.jsonl');
const DISABLE_ENV = 'INTAKE_BREAKER_DISABLED';

// Sized from the measurement, not from taste: mean real intake is 34.3/day and
// the worst single day in the audited window was well under this. 60 leaves
// clear headroom for a legitimately busy day (an opening night that files a
// dozen coverage gaps, a large audit landing its findings) while still catching
// a runaway loop, which produces hundreds.
const DEFAULT_DAILY_CAP = 60;

/**
 * Pure decision. Injected counts/now so the test exercises the real predicate.
 *
 * @param {object} p
 * @param {number} p.createdToday - issues already created today by this machine
 * @param {number} [p.cap]
 * @param {boolean} [p.disabled] - the env override, resolved by the caller
 * @returns {{allow: boolean, reason: string|null, createdToday: number, cap: number}}
 */
function evaluateIntake({ createdToday, cap = DEFAULT_DAILY_CAP, disabled = false }) {
  const n = Number.isFinite(createdToday) ? createdToday : 0;
  if (disabled) return { allow: true, reason: 'breaker disabled by env', createdToday: n, cap };
  if (n < cap) return { allow: true, reason: null, createdToday: n, cap };
  return {
    allow: false,
    createdToday: n,
    reason: `intake breaker: ${n} issues already created today (cap ${cap}). `
      + 'This is a storm guard, not a queue limit — normal days are ~34. Something is '
      + 'probably filing in a loop. Check what created the most recent entries in '
      + 'data/audit/intake-ledger.jsonl before filing more. '
      + `Override for one run with ${DISABLE_ENV}=1 if this is genuinely a legitimate burst.`,
  };
}

/** YYYY-MM-DD in UTC — matches how the ledgers in data/audit already key days. */
function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * How many issues this machine recorded creating on `now`'s day.
 * Returns 0 when the ledger is unreadable — see the fail-open note in the header.
 */
function countCreatedToday(now, ledgerPath = LEDGER_PATH) {
  const key = dayKey(now);
  let raw;
  try { raw = fs.readFileSync(ledgerPath, 'utf8'); } catch { return 0; }
  let n = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // Substring test before JSON.parse: this runs on every single create and the
    // ledger grows all day. Cheap reject first, parse only same-day candidates.
    if (!line.includes(key)) continue;
    try { if (dayKey(Date.parse(JSON.parse(line).ts)) === key) n += 1; } catch { /* skip malformed */ }
  }
  return n;
}

/** Append one creation record. Never throws — telemetry must not break a create. */
function recordCreated({ identifier, title, now = Date.now(), ledgerPath = LEDGER_PATH }) {
  try {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.appendFileSync(ledgerPath, `${JSON.stringify({
      ts: new Date(now).toISOString(),
      identifier: identifier || null,
      title: String(title || '').slice(0, 200),
    })}\n`);
  } catch { /* telemetry only */ }
}

/** Convenience for the chokepoint: read env + ledger, return the decision. */
function checkIntake(now = Date.now(), ledgerPath = LEDGER_PATH) {
  return evaluateIntake({
    createdToday: countCreatedToday(now, ledgerPath),
    disabled: process.env[DISABLE_ENV] === '1',
  });
}

module.exports = {
  evaluateIntake, countCreatedToday, recordCreated, checkIntake, dayKey,
  DEFAULT_DAILY_CAP, LEDGER_PATH, DISABLE_ENV,
};
