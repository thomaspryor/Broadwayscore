'use strict';
/**
 * BRO-8426: the earliest date a recheck command can possibly pass.
 *
 * Some acceptance checks pass only after a quiet window: recurrence-detector
 * --check-class needs 21 days without a new case, and an open alert-ledger row
 * only clears once the router's absence sweep resolves it (48h to 336h by
 * family). Workers stamped RECHECK-AFTER days before that (BRO-7437 on
 * 2026-11-28 with an earliest pass of 12-14; BRO-7669 on 11-28 with the row
 * resolvable at 11-28 23:26), so the nightly recheck failed them and filed a
 * "done claim no longer holds" card that no worker could act on (BRO-8426).
 *
 * Each probe owns its own window and argv parsing and exports
 * earliestPassForArgv(argv, nowMs) -> null | { atMs, never?, why }. This module
 * only maps a command to its probe. Any error reads as "no window known".
 */
const path = require('path');

// Script path (as written in a VERIFY line) -> module exporting earliestPassForArgv.
const PROBES = {
  'scripts/recurrence-detector.js': '../recurrence-detector.js',
  'scripts/check-alert-condition-absent.js': '../check-alert-condition-absent.js',
};

/**
 * @param {string} cmd  a recheck command, e.g. `node scripts/recurrence-detector.js --check-class x --quiet`
 * @param {number} [nowMs]
 * @returns {null | { atMs: number|null, never?: true, why: string }}
 */
function earliestPassFor(cmd, nowMs = Date.now()) {
  const tokens = String(cmd || '').trim().split(/\s+/);
  if (tokens[0] !== 'node' || !tokens[1]) return null;
  const script = path.posix.normalize(tokens[1].replace(/^\.\//, ''));
  const mod = PROBES[script];
  if (!mod) return null;
  try {
    const probe = require(mod);
    if (typeof probe.earliestPassForArgv !== 'function') return null;
    return probe.earliestPassForArgv(tokens.slice(2), nowMs) || null;
  } catch {
    return null;
  }
}

module.exports = { earliestPassFor, PROBES };
