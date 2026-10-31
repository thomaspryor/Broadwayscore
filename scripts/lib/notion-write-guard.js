/**
 * notion-write-guard.js — Phase 1 of the Linear migration (BRO-377): Notion is
 * READ-ONLY for new pages.
 *
 * WHY CREATES AND NOT UPDATES. The thing that has to stop is DIVERGENCE — two
 * boards accumulating separate work. Only a create can do that. Blocking
 * updates as well would be strictly worse than useless: `notion-action-poll.js`
 * marks an action processed with a `pages.update`, so refusing updates makes it
 * re-process the same action forever, and existing open cards could never be
 * closed, which would leave the old board permanently dirty exactly when we are
 * trying to drain it. Read-only here means "no NEW Notion pages", and the old
 * board stays writable enough to be wound down.
 *
 * Context that makes this necessary rather than tidy: the Notion→Linear mirror
 * froze 2026-08-20 at task id 1285, so `linearMirrorGuard`
 * (scripts/lib/dispatch-guards.js) returned null for every task above it — the
 * only guard against two sessions taking the same work off different boards.
 * Every new Notion card widened that hole.
 *
 * Pure decision function, no I/O, no process.exit — the caller decides how to
 * refuse. Tested by scripts/lib/notion-write-guard.test.mjs, which require()s
 * this function rather than restating it (CLAUDE.md rule 15).
 */

'use strict';

// Deliberately an env var and not a file: the file-shaped escape hatches on
// this machine (BOARD_GATE_DISABLED) are machine-wide and outlive the session
// that set them — one forgotten touch silently re-opens Notion for every
// process for days, which is precisely how the board gates ended up disabled
// from 2026-08-20 onward without anyone noticing. An env var expires with the
// command that carries it.
const ESCAPE_ENV = 'NOTION_WRITES_ALLOWED';

/**
 * @param {Record<string,string|undefined>} env - normally process.env
 * @returns {{allowed: boolean, reason: string|null}}
 *   allowed:true with a reason when an escape hatch is in play (the caller
 *   should log it — a silent bypass is how a temporary exception becomes
 *   permanent); allowed:true with reason:null is the ordinary pre-cutover path.
 */
function notionCreateVerdict(env = {}) {
  if (env[ESCAPE_ENV] === '1') {
    return {
      allowed: true,
      reason: `${ESCAPE_ENV}=1 — Notion read-only bypassed for this command`,
    };
  }
  return {
    allowed: false,
    reason:
      'Notion is READ-ONLY (Linear migration Phase 1, BRO-377). Do not create Notion cards.\n' +
      '  File it on the board instead:\n' +
      '    node scripts/linear-brain.js create "<title>" --dispatch|--park "<reason>" --notes "..."\n' +
      '  Existing Notion cards can still be updated and closed; only NEW pages are refused.\n' +
      `  One-off override for this command only: ${ESCAPE_ENV}=1 <command>`,
  };
}

module.exports = { notionCreateVerdict, ESCAPE_ENV };
