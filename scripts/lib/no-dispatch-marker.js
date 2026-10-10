/**
 * no-dispatch-marker.js — the one definition of the "NO-DISPATCH:" marker
 * notion-brain.js writes onto a card created with `--dispatch --no-spawn`.
 *
 * Task #1691: `--no-spawn` tells notion-brain.js "don't launch a bsc-next
 * workspace for this card" but historically left Notion Status="In progress"
 * (or whatever `--status` said), which mirrors to the shared task list as
 * `in_progress` — a CLAIMED state — with nothing behind it. A session then
 * reported "DISPATCHED:" for 4 real work-item cards created this way; all
 * four sat permanently claimed and invisible to `bsc-next --list`.
 *
 * The fix: any card carrying this marker in its Notes is excluded from the
 * task mirror entirely (notion-tasks-sync.js's isMirrorableCard()) —
 * regardless of its Notion Status — so it can never occupy a claimed slot in
 * the shared queue. The Notion-visible Status is untouched by this marker on
 * purpose: the one legitimate existing caller
 * (scripts/sync-pending-review-to-notion.js) deliberately wants the OWNER's
 * Notion board to keep showing "In progress" for its standing review-status
 * card, while never wanting bsc-next to dispatch a workspace for it.
 *
 * Named "NO-DISPATCH" rather than "NO-SPAWN" to avoid colliding with
 * scripts/lib/digest-autofix.js's pre-existing, unrelated use of "no-spawn"
 * to mean "a dispatch that never spawned a session" (an orphan-detection
 * term, not an opt-out marker) — same class of confusion
 * owner-judgment-marker.js's module doc warns against for its own term.
 *
 * Leaf module, no imports, same shape as owner-judgment-marker.js: every
 * layer that needs to recognise this marker requires it directly instead of
 * restating the regex.
 */

'use strict';

const NO_DISPATCH_RE = /NO-DISPATCH:/;

/**
 * Does this text (card notes / task-mirror description) carry the
 * NO-DISPATCH marker?
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
function hasNoDispatchMarker(text) {
  return NO_DISPATCH_RE.test(String(text || ''));
}

module.exports = { NO_DISPATCH_RE, hasNoDispatchMarker };
