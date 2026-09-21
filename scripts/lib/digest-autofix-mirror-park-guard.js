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
 * — at the time, dispatch-watchdog-core.js's awaitingClaim/noLaunchPark and
 * jobBlocked deliberately still surfaced those as owner-visible signal
 * (BRO-3429, #1564 tests), so the fix belonged here, at the point
 * digest-autofix.js decides what to FILE, not there.
 *
 * BRO-3437 UPDATE: that classification-layer decision was reversed once
 * board-targeting-audit.js caught `watchdog-park` itself still writing
 * 100% retired-board ids — a parked bare-numeric id has no live Linear card
 * for the owner to act on, so "surface it" and "page about it" were both
 * pure noise, not signal. dispatch-watchdog-core.js's jobBlocked and
 * awaitingClaim loops now gate on isLiveBoardTaskId() too, so no NEW
 * watchdog-park row can ever name a retired-board id again. This guard
 * stays in place as defense-in-depth for legacy rows already sitting in the
 * ledger from before that fix landed — it costs nothing to keep and this
 * module's job (stop digest-autofix.js from filing a tracker for one) is
 * still correct even though its trigger condition should now be rare.
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

// Every pageOwner() "Watchdog parked" call carries a stable
// `watchdog-park:<taskId>` conditionKey (dispatch-watchdog.js's 3 call
// sites) — normalizeQueuedRows() in digest-autofix.js already threads
// q.conditionKey onto the row, so this is the PREFERRED match: a structured
// key can't be broken by a later wording/punctuation edit to the title the
// way a text-prefix match can (ship-check/Codex finding, BRO-3923).
const WATCHDOG_PARK_CONDITION_KEY_RE = /^watchdog-park:(\S+)$/;

// Fallback for rows with no conditionKey (health.errors/warns/extraIssues
// never carry one) — the literal shape every pageOwner() title starts with:
// "Watchdog parked #<taskId> ...".
const WATCHDOG_PARKED_TITLE_RE = /^Watchdog parked #(\S+)/;

/** PURE. Would filing/reattaching a Linear tracker for this row target the frozen Notion mirror? */
function isWatchdogParkedMirrorTracker(title, conditionKey) {
  const ckMatch = WATCHDOG_PARK_CONDITION_KEY_RE.exec(String(conditionKey || '').trim());
  if (ckMatch) return isRetiredBoardTaskId(ckMatch[1]);
  const m = WATCHDOG_PARKED_TITLE_RE.exec(String(title || '').trim());
  return !!m && isRetiredBoardTaskId(m[1]);
}

module.exports = { isWatchdogParkedMirrorTracker, WATCHDOG_PARK_CONDITION_KEY_RE, WATCHDOG_PARKED_TITLE_RE };
