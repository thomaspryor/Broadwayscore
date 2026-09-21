/**
 * digest-autofix-mirror-park-guard.js — stops digest-autofix.js from ever
 * filing a "BSC Daily: Watchdog parked #<bare numeric>" Linear tracker for
 * the frozen Notion mirror (BRO-3923).
 *
 * WHY. dispatch-watchdog.js's pageOwner() titles a parked card "Watchdog
 * parked #<taskId> ..." where <taskId> is EITHER a `linear:BRO-N` identifier
 * or a bare Notion-mirror integer (frozen 2026-08-20, CLAUDE.md §6). Every
 * such call routes through owner-alert-router.js's disposition:'digest' path
 * into send-morning-digest.js's sections.health.queued, which
 * digest-autofix.js's planAutofix()/fileCard() turns into a real Linear
 * issue titled "BSC Daily: <title>" — a tracker for a board nobody can act
 * on. 31 of these were canceled by hand on 2026-09-21: BRO-3878 (2026-09-20)
 * stopped the watchdog from making FRESH claims against the mirror, but
 * claims already sitting in the shared dispatch ledger from before that fix
 * kept aging past CLAIM_LABEL_GRACE_MS and getting parked/paged regardless
 * — dispatch-watchdog-core.js's awaitingClaim/noLaunchPark deliberately
 * still surfaces those as owner-visible signal (BRO-3429, #1564 tests), so
 * the fix belongs here, at the point digest-autofix.js decides what to
 * FILE, not there.
 *
 * Extracted as its own leaf (CLAUDE.md §15) rather than a regex dropped into
 * scripts/lib/autonomous-email-render.js's QUEUED_TELEMETRY_BLOCKLIST: that
 * list is a static per-heading string match (task #1641), while this
 * predicate parses the id out of the title and runs it through
 * task-id-namespace.js's own declared board state (BRO-3423) — the same
 * test dispatch-watchdog-core.js's retryable/p01Queue guards already use —
 * so it can never hand-roll a second, divergent "is this the retired board"
 * check.
 */
'use strict';

const { isRetiredBoardTaskId } = require('./task-id-namespace.js');

// The literal shape every pageOwner() "Watchdog parked" title starts with
// (dispatch-watchdog.js's 3 call sites) — "Watchdog parked #<taskId> ...".
const WATCHDOG_PARKED_TITLE_RE = /^Watchdog parked #(\S+)/;

/** PURE. Would filing/reattaching a Linear tracker for this title target the frozen Notion mirror? */
function isWatchdogParkedMirrorTracker(title) {
  const m = WATCHDOG_PARKED_TITLE_RE.exec(String(title || '').trim());
  return !!m && isRetiredBoardTaskId(m[1]);
}

module.exports = { isWatchdogParkedMirrorTracker, WATCHDOG_PARKED_TITLE_RE };
