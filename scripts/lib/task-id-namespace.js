/**
 * task-id-namespace.js — the ONE place that declares which tracker board is
 * live and which is retired, and how to read a dispatch-ledger taskId as
 * belonging to one of them (BRO-3423).
 *
 * WHY THIS EXISTS. The fleet's dispatch ledger identifies work by a taskId
 * whose SHAPE encodes which board it came from: `linear:BRO-3423` is the live
 * Linear board, a bare-numeric `1812` is the retired Notion mirror (frozen at
 * task id 1285 on 2026-08-20, CLAUDE.md §6), and everything else
 * (`on-monitor-2026-09-14`, `sweep`, `watchdog`) is not board work at all.
 *
 * That fact was, until this module, written down nowhere and re-derived by
 * regex at each call site — and the copies had ALREADY diverged:
 *
 *   scripts/lib/digest-autofix.js:397   /^linear:([A-Z]+-\d+)$/
 *   scripts/lib/linear-watchdog-source.js:75  /^linear:([A-Z][A-Z0-9]*-\d+)$/
 *
 * The first rejects any team key containing a digit; the second accepts it.
 * Both are load-bearing (the digest-autofix one guards a `sh -c`
 * interpolation), so the divergence is a latent correctness AND safety split.
 * Both now call in here.
 *
 * THE POINT OF THE MODULE IS THE DECLARATION, NOT THE REGEX. BRO-3423 exists
 * because "we retired Notion" was stated once, in prose, and nothing
 * automated ever re-checked it against the running fleet — so the crowned
 * dispatch watchdog spent its entire day budget re-dispatching retired-board
 * ids for two weeks and nobody noticed. scripts/lib/board-targeting-audit.js
 * is the standing check that catches that class; it reads LIVE_BOARD and
 * RETIRED_BOARDS from here. When the NEXT migration happens, moving those two
 * constants is what re-points the watchdog — as opposed to the check quietly
 * becoming the thing that lies, which is precisely the failure it was built
 * to end.
 *
 * Pure module: no fs, no network, no process (CLAUDE.md §15 — tests require()
 * these functions directly rather than restating them).
 */
'use strict';

// Board identifiers. These two constants ARE the migration state of the
// fleet; see the header on why they live here and nowhere else.
const LIVE_BOARD = 'linear';
const RETIRED_BOARDS = Object.freeze(['notion']);

// Not board work: monitor heartbeats, sweep markers, watchdog self-rows.
// Deliberately a distinct value rather than null — a caller that lumps these
// in with "retired" would report the fleet as mis-targeted every time a
// monitor ticked.
const NON_BOARD = 'non-board';

// `linear:BRO-3423`. Team key is [A-Z][A-Z0-9]* — Linear permits digits after
// the first letter, which digest-autofix.js's copy did not. Anchored, and
// alphanumeric-plus-hyphen only, so callers interpolating the captured
// identifier into a shell command stay injection-safe (the property
// digest-autofix.js:397 depends on).
const LINEAR_TASK_ID_RE = /^linear:([A-Z][A-Z0-9]*-\d+)$/;

// The retired Notion mirror addressed work by bare positive integer.
const NOTION_TASK_ID_RE = /^\d+$/;

const LINEAR_TASK_PREFIX = 'linear:';

/**
 * PURE. Which board does this taskId belong to?
 * @returns {'linear'|'notion'|'non-board'}
 */
function classifyTaskIdBoard(taskId) {
  const id = String(taskId == null ? '' : taskId);
  if (LINEAR_TASK_ID_RE.test(id)) return LIVE_BOARD;
  if (NOTION_TASK_ID_RE.test(id)) return 'notion';
  return NON_BOARD;
}

/** PURE. Is this taskId on a board at all (live or retired)? */
function isBoardTaskId(taskId) {
  return classifyTaskIdBoard(taskId) !== NON_BOARD;
}

/** PURE. Is this taskId on a board we have declared retired? */
function isRetiredBoardTaskId(taskId) {
  return RETIRED_BOARDS.includes(classifyTaskIdBoard(taskId));
}

/** PURE. Is this taskId on the live board? */
function isLiveBoardTaskId(taskId) {
  return classifyTaskIdBoard(taskId) === LIVE_BOARD;
}

/**
 * PURE. The bare Linear identifier ('BRO-3423') for a `linear:` taskId, or
 * null. Callers that interpolate the result into a shell command rely on the
 * anchoring in LINEAR_TASK_ID_RE — do not loosen it.
 */
function parseLinearTaskId(taskId) {
  const m = LINEAR_TASK_ID_RE.exec(String(taskId == null ? '' : taskId));
  return m ? m[1] : null;
}

/** PURE. 'BRO-3423' -> 'linear:BRO-3423'. */
function linearTaskId(identifier) {
  return `${LINEAR_TASK_PREFIX}${identifier}`;
}

module.exports = {
  LIVE_BOARD,
  RETIRED_BOARDS,
  NON_BOARD,
  LINEAR_TASK_ID_RE,
  NOTION_TASK_ID_RE,
  LINEAR_TASK_PREFIX,
  classifyTaskIdBoard,
  isBoardTaskId,
  isRetiredBoardTaskId,
  isLiveBoardTaskId,
  parseLinearTaskId,
  linearTaskId,
};
