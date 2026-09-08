/**
 * crown-fanout-guard — pure predicate refusing to launch a SECOND concurrent
 * BRO-343 "crown" (owner-loop backlog-triage) cmux session while one is
 * already running.
 *
 * Incident (BRO-2953, 2026-09-07): five top-level "👑 OWNER — Crown vNN"
 * workspaces were independently running the same BRO-343 backlog-triage +
 * dispatch loop at once, none aware of the others (workspace:11, 117, 115,
 * 120, 108 in the live fleet snapshot). Root cause, confirmed by grep: no
 * launch path checked for an existing live crown before creating a new one.
 * Every crown handoff (v30 through v44+) told its successor to "launch a
 * successor via launchCmuxSession", with no check for SIBLINGS — a fresh or
 * manual (non-chain) crown start had zero registry check either.
 * crown-duplicate-detector.js (same incident) is report-only, for tabs that
 * already exist; this module is the preventative half — it runs BEFORE a
 * workspace is created.
 *
 * Deliberately narrow match (mirrors prune-closeable.js's CROWN_TAB_RE glyph
 * convention): a "👑 OWNER" title that also names "Crown" or "BRO-343" is a
 * mandate-loop crown. "👑 OWNER watchdog — ..." (dispatch-watchdog.js) is a
 * DIFFERENT singleton role with its own tab and is deliberately NOT matched
 * here — conflating the two would let this guard refuse a watchdog launch for
 * a reason that has nothing to do with it.
 */

'use strict';

// Title must both carry the owner-loop glyph prefix AND name the crown
// mandate — "👑 OWNER watchdog — 4 in flight" has the prefix but never
// "Crown"/"BRO-343", so it is correctly excluded.
const OWNER_PREFIX_RE = /👑\s*OWNER\b/u;
const CROWN_MANDATE_RE = /\bcrown\b|\bBRO-343\b/i;

function isCrownLaunchTitle(title) {
  const t = String(title || '');
  return OWNER_PREFIX_RE.test(t) && CROWN_MANDATE_RE.test(t);
}

/**
 * @param {Array<{ref:string,title:string}>} existingWorkspaces the live
 *   fleet snapshot (`cmux list-workspaces` / cmux-workspaces.listWorkspaces())
 *   — closed workspaces never appear in this list, so presence alone means
 *   "Running or Idle but not explicitly closed."
 * @param {string} title the title of the workspace about to be launched.
 *   Only a crown-mandate title (see isCrownLaunchTitle) is gated at all —
 *   this predicate is a no-op for every other launch (auto-dispatch task
 *   sessions, the watchdog tab, opening-night monitors, ...). Note this
 *   refuses a SANCTIONED successor hand-off too, not just an independent
 *   duplicate start: the predecessor is still alive (by design) at the exact
 *   moment its successor launches, and this predicate has no way to tell
 *   "my own coordinated predecessor" from "someone else's independent crown"
 *   from the launch args alone. A hand-off script must pass force:true —
 *   see cmux-launch.js's call site for why that's the intended fix, not a
 *   gap in this one.
 * @returns {{allow:boolean, existing?:{ref:string,title:string}, reason?:string}}
 */
function shouldLaunchNewCrown(existingWorkspaces, title) {
  if (!isCrownLaunchTitle(title)) return { allow: true };

  const liveCrowns = (existingWorkspaces || []).filter(
    (w) => w && isCrownLaunchTitle(w.title)
  );
  if (liveCrowns.length === 0) return { allow: true };

  const existing = liveCrowns[0];
  return {
    allow: false,
    existing,
    reason:
      `a BRO-343 crown session is already running in ${existing.ref} ("${existing.title}") — ` +
      `refusing to launch a duplicate "${title}". Message the existing session to consolidate ` +
      `instead of spawning a sibling, or pass force:true to launch one anyway (also required for a ` +
      `sanctioned successor hand-off, since the predecessor is still alive until it self-closes).`,
  };
}

module.exports = { isCrownLaunchTitle, shouldLaunchNewCrown };
