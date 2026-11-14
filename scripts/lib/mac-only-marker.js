/**
 * mac-only-marker.js — the one definition of "this card needs the owner's Mac"
 * (BRO-6080).
 *
 * A cloud session that hits work only the Mac can do (launchd, the Mac's
 * cookies or keychain, a local-only file) files the card with
 * `linear-brain.js create --dispatch --mac-only "<why>"`. That writes two
 * signals: the 'mac-only' label and a "MAC-ONLY: <why>" line at the top of the
 * description. Either one marks the card:
 *   - the cloud worker picker skips it (cloud-worker-pick.js headlessUnfitReason),
 *   - the Mac's parked drain takes it as a Todo card at any triaged priority
 *     (linear-drain-parked.js isMacOnlyDrainable), but only with the line: a
 *     label alone can mean hands-on work at the Mac (GUI, keychain prompt), which
 *     an unattended session would stall on.
 * The line is there from the first write, so a failed or late label write never
 * leaves the card pickable by the cloud; the label is what people see in Linear.
 *
 * Leaf module (lazy require of linear-dispatch.js only inside isMacOnlyCard),
 * same shape as no-dispatch-marker.js: line-anchored, markdown decoration
 * tolerated, so a sentence that merely quotes the marker does not match.
 */

'use strict';

const MAC_ONLY_LINE_RE = /^[ \t>*_-]*MAC-ONLY[ \t*_]*:/m;

/** Does this text (card description) carry a "MAC-ONLY:" line? */
function hasMacOnlyLine(text) {
  return MAC_ONLY_LINE_RE.test(String(text || ''));
}

/** True when the card has the 'mac-only' label or a "MAC-ONLY:" line. */
function isMacOnlyCard(issue) {
  if (!issue) return false;
  return require('./linear-dispatch.js').hasMacOnlyLabel(issue) || hasMacOnlyLine(issue.description);
}

module.exports = { MAC_ONLY_LINE_RE, hasMacOnlyLine, isMacOnlyCard };
