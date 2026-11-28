/**
 * notion-writes.js — the one place every `pages.update` call in this repo
 * goes through (BRO-2471).
 *
 * Phase 1 (BRO-377, notion-write-guard.js) gated `pages.create` because
 * notion-brain.js has exactly one create call site — a natural chokepoint.
 * Updates had no such property: auto-fix-friction-card.js and
 * notion-action-poll.js called `notion.pages.update()` directly, so any
 * future guard, counter, or audit placed at the CLI was blind to them.
 *
 * This is deliberately a plain passthrough, NOT a gate. Refusing updates the
 * way creates are refused would make notion-action-poll.js reprocess the
 * same action forever and would strand every open card unclosable exactly
 * while the old board is being drained (see notion-write-guard.js's header
 * for the full incident). The point of this file is only to give a future
 * decision — proving no writes remain before retiring the poller, or
 * counting remaining Notion write traffic — exactly one place to look.
 */

'use strict';

function updatePage(notion, params) {
  return notion.pages.update(params);
}

module.exports = { updatePage };
