/**
 * no-payload-reaper — pure decision logic for bsc-prune's no-payload sweep
 * (card #856, Session-system overhaul S3, 4b).
 *
 * Distinct from bsc-prune's existing idle-unmarked listing (a workspace whose
 * claude process died) and its ✅-marked close (a session that finished):
 * this catches a workspace whose claude process is ALIVE but stuck at a
 * login prompt from the moment it launched — "Not logged in" (the exact
 * failure class cmux-launch.js's auth preflight now blocks at launch time,
 * card #856 4a) or a still-live session that lost auth mid-run. Nothing ever
 * happens in that pane; it just sits there burning a tab slot forever
 * because it's neither idle (process is alive) nor ✅-marked (nothing ever
 * ran to mark it).
 *
 * Owner rule (2026-08-02, "auto-close is limited to 🤖 auto-dispatched tabs,
 * full stop" — see prune-closeable.js's isCloseable) governs here too: this
 * module's caller must gate on hasAutoDispatchMarker(title) before ever
 * calling noPayloadReaperTick — an owner-opened tab must NEVER be reaped,
 * no matter how long it sits on a login screen. "Quarantine 2 empty turns
 * then close next tick" (task spec): a ref survives its first two
 * consecutive no-payload sightings (quarantined, not closed); the THIRD
 * consecutive sighting is what closes it — never an instant kill on the
 * first observation, since a launch that's mid-render for a few seconds
 * must not read as "no payload forever."
 */

'use strict';

// Strong, low-false-positive signal only (deliberately NOT "chrome never
// rendered" — that would also catch a merely slow-booting session, which
// cmux-launch.js's own boot-verification machinery already handles more
// carefully than a screen-text heuristic ever could).
const NO_PAYLOAD_RE = /(not logged in|please run\s*\/login|invalid api key|no conversation history)/i;

function screenLooksNoPayload(screenText) {
  return NO_PAYLOAD_RE.test(String(screenText || ''));
}

const QUARANTINE_LIMIT = 2;

/**
 * One sweep tick. `observations` = [{ ref, title, noPayload }] for every
 * candidate workspace already screen-read this tick (I/O and the 🤖-only
 * gate both happen in the caller — this function is pure). `priorState` =
 * { [ref]: consecutiveCount } persisted from the previous tick.
 *
 * Returns { toClose, toQuarantine, state }:
 *  - toClose: observations whose consecutive no-payload count just exceeded
 *    QUARANTINE_LIMIT — the caller closes these and drops them from state.
 *  - toQuarantine: observations still within the quarantine window (count
 *    1 or 2) — reported but not closed.
 *  - state: the new priorState for next tick. A ref that recovered (this
 *    tick's noPayload is false) or was just closed is absent — recovery is
 *    a clean reset, not a decaying count.
 */
function noPayloadReaperTick(observations, priorState = {}) {
  const state = {};
  const toClose = [];
  const toQuarantine = [];
  for (const obs of observations) {
    if (!obs.noPayload) continue; // recovered (or never flagged) — no state carried forward
    const count = (priorState[obs.ref] || 0) + 1;
    if (count > QUARANTINE_LIMIT) {
      toClose.push({ ...obs, count });
    } else {
      state[obs.ref] = count;
      toQuarantine.push({ ...obs, count });
    }
  }
  return { toClose, toQuarantine, state };
}

module.exports = { screenLooksNoPayload, noPayloadReaperTick, QUARANTINE_LIMIT, NO_PAYLOAD_RE };
