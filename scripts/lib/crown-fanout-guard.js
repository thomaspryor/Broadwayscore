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
 *
 * Liveness and the successor exemption are the CALLER's job, not this
 * predicate's (cmux-launch.js does both before calling shouldLaunchNewCrown):
 * this module only ever sees an array the caller has already decided counts
 * as "live", and title-matching stays pure and mockable without an injected
 * liveness function (rule 15).
 *
 * Known limitation, deliberately not closed here (Codex adversarial review,
 * 2026-09-07): this is a check-then-act, not a lock — two crown launches
 * starting within the same instant can both list zero live crowns and both
 * proceed. Closing that would mean holding scripts/lib/file-lock.js across
 * the ENTIRE launch (including up to a 6-minute slow-boot verification wait
 * inside launchCmuxSessionInner), which would make one crown launch block an
 * unrelated one for minutes — a worse failure than the race it prevents. The
 * incident this guard closes was never a millisecond race: five crowns
 * accumulated over WEEKS of separate, uncoordinated handoffs, and this check
 * closes exactly that failure mode. A true simultaneous double-launch is a
 * real but much narrower residual risk than what shipped before this fix.
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
 * @param {Array<{ref:string,title:string}>} existingWorkspaces crown-titled
 *   workspaces the caller has already confirmed are LIVE (claude alive, not
 *   just present in `cmux list-workspaces`) and, if `successorOf` was given,
 *   already excludes that ref. Passing an unfiltered listing here would treat
 *   a dead corpse tab as a permanent block and a sanctioned predecessor as an
 *   independent duplicate — see cmux-launch.js's call site.
 * @param {string} title the title of the workspace about to be launched.
 *   Only a crown-mandate title (see isCrownLaunchTitle) is gated at all —
 *   this predicate is a no-op for every other launch (auto-dispatch task
 *   sessions, the watchdog tab, opening-night monitors, ...).
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
      `refusing to launch a duplicate "${title}". Message the existing session to consolidate instead ` +
      `of spawning a sibling. If this IS a sanctioned successor hand-off, pass successorOf: ` +
      `process.env.CMUX_WORKSPACE_ID (your own predecessor's workspace id) so only your own predecessor ` +
      `is exempted — any OTHER live crown still refuses. force:true is for a genuinely deliberate second, ` +
      `independent crown; it also bypasses the terminal-capacity preflight, so prefer successorOf for a hand-off.`,
  };
}

module.exports = { isCrownLaunchTitle, shouldLaunchNewCrown };
