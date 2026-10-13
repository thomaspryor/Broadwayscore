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

// BRO-4077: an ordinary "👑 OWNER — <mandate>" hand-off (not the BRO-343 crown,
// not the "👑 OWNER watchdog" singleton) had no duplicate guard at all: a caller
// that crashed AFTER a successful launch and re-ran produced two live workspaces
// with the identical title (2026-09-23, workspace:35 and :36). Same-title is the
// key because the title is the only thing both launches share.
function isOwnerLaunchTitle(title) {
  const t = String(title || '');
  return OWNER_PREFIX_RE.test(t) && !isCrownLaunchTitle(t) && !/\bOWNER\s+watchdog\b/i.test(t);
}

// cmux prepends an activity glyph (braille spinner, ✅/🤖) to a live tab's title
// (dispatch-watchdog.js strips it the same way), so a working tab never equals
// the title we pass in. Strip the leading non-letter/non-digit/non-👑 run and
// collapse whitespace before comparing.
function normalizeLaunchTitle(title) {
  return String(title || '').replace(/^[^\p{L}\p{N}👑]*/u, '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {Array<{ref:string,title:string}>} existingWorkspaces workspaces the
 *   caller considers LIVE, with the successor's own predecessor already removed.
 *   A listed identical-title tab counts as live even before claude registers
 *   (the slow-boot window is minutes: the incident's re-run came seconds later);
 *   a genuine corpse is closed or bypassed with force:true.
 */
function shouldLaunchSameTitle(existingWorkspaces, title) {
  if (!isOwnerLaunchTitle(title)) return { allow: true };
  const want = normalizeLaunchTitle(title);
  const existing = (existingWorkspaces || []).find((w) => w && normalizeLaunchTitle(w.title) === want);
  if (!existing) return { allow: true };
  return {
    allow: false,
    existing,
    reason:
      `a workspace with the identical title is already running in ${existing.ref} ("${existing.title}") — ` +
      `refusing to launch a duplicate "${title}". If a prior launch of this work crashed after creating it, ` +
      `use that workspace. If it is a dead tab, close it first. A sanctioned successor hand-off passes ` +
      `successorOf: process.env.CMUX_WORKSPACE_ID; force:true is for a deliberate second session.`,
  };
}

module.exports = { isCrownLaunchTitle, shouldLaunchNewCrown, isOwnerLaunchTitle, normalizeLaunchTitle, shouldLaunchSameTitle };
