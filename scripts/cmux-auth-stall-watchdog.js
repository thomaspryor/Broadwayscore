#!/usr/bin/env node
/**
 * cmux-auth-stall-watchdog — BRO-4056: mark logged-out / stalled-resume cmux
 * tabs with the same ❓ "needs you" glyph a DECISION NEEDED tab gets, so
 * the existing sidebar/digest/bsc-needs-you machinery (which only ever reads
 * that glyph + scripts/lib/needs-you-snapshot.js's state dir) picks them up
 * without learning a new signal.
 *
 * WHY A SEPARATE WATCHDOG, not a Stop-hook extension: both shapes this
 * catches (scripts/lib/cmux-auth-stall.js's header has the full incident)
 * never complete a normal Claude turn, so the Stop hook
 * (~/.claude/hooks/lib/workspace-mark-done.js) never runs for them at all —
 * there is no WSMD_LAST_MSG to inspect. The only place either shape is
 * OBSERVABLE is the pane's rendered screen, which only a poll (this script,
 * via `cmux read-screen`) can see.
 *
 * Read-mostly and additive: never closes or restarts anything (that's a
 * human/recovery-session decision — see BRO-4056's root cause #3, where an
 * automated relaunch left tabs silently idle for ~2 days). The only WRITE
 * this script performs is a cosmetic rename (❓-prefix) plus a needs-you
 * state JSON, both idempotent and already the exact mechanism
 * workspace-mark-done.js uses for DECISION NEEDED.
 *
 *   node scripts/cmux-auth-stall-watchdog.js             scan + mark
 *   node scripts/cmux-auth-stall-watchdog.js --dry-run    scan + report only
 *   node scripts/cmux-auth-stall-watchdog.js --help
 *
 * Intended to run on the same 5-minute cadence as
 * ~/.config/claude/keychain-sentinel.sh (its LaunchAgent plist is
 * scripts/launchd/com.broadwayscore.cmux-auth-stall-watchdog.plist) so a
 * tab that goes bad between owner glances is caught within one cycle.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { cmuxAvailable, listWorkspaces, run } = require('./lib/cmux-workspaces.js');
const { detectAuthStall } = require('./lib/cmux-auth-stall.js');
const { isNeedsYouTitle, NEEDS_YOU_DIR } = require('./lib/needs-you-snapshot.js');

const USAGE = `cmux-auth-stall-watchdog — mark logged-out / stalled-resume cmux tabs ❓ NEEDS YOU.

Usage:
  node scripts/cmux-auth-stall-watchdog.js             scan every live workspace, mark hits
  node scripts/cmux-auth-stall-watchdog.js --dry-run    scan and report only, no rename/state write
  node scripts/cmux-auth-stall-watchdog.js --help       show this message, do nothing else

Never closes or restarts a workspace — marking only. See scripts/lib/cmux-auth-stall.js
for what it detects and why (BRO-4056).
`;

// Same glyph set/priority as workspace-mark-done.js's MANAGED_GLYPHS: ❓
// (needs you) always wins and replaces whichever of ✅/🧭 already
// led the title, so a logged-out tab that happened to be ✅-marked before
// it died doesn't keep reading as done.
const MANAGED_GLYPH_RE = /^([^\p{L}\p{N}[]*?)[✅❓🧭]\s*/u;

// Delegates to isNeedsYouTitle (imported above from needs-you-snapshot.js —
// the SAME glyph-zone check the sidebar/digest actually read) instead of
// reimplementing the ❓-detection independently (code-review finding: an
// independent copy risks silently drifting from what those consumers read).
function leadingGlyph(title) {
  return isNeedsYouTitle(title) ? '❓' : null;
}

function stripManagedGlyph(title) {
  return String(title || '').replace(MANAGED_GLYPH_RE, '$1').trim();
}

function needsYouFile(ref, dir = NEEDS_YOU_DIR) {
  // diacritic-guard-ok: sanitizing a cmux workspace ref (workspace:N) into a filename, not a title/name matcher
  return path.join(dir, `${String(ref).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

const QUESTIONS = {
  'logged-out': 'Tab shows "Not logged in · Please run /login" — do NOT just run /login in it (BRO-4056: a manual /login gets auto-purged by the keychain sentinel within minutes and can mask whether the underlying token-propagation bug recurred). Relaunch/restore it through a launch path that carries CLAUDE_CODE_OAUTH_TOKEN instead.',
  'stalled-resume': 'Tab was resumed with no real prompt and only replied "No response requested." — give it a real prompt or restart the session; it has been sitting idle since the last scan found it this way.',
};

function stateFileExists(ref) {
  try { return fs.existsSync(needsYouFile(ref)); } catch { return false; }
}

function scanOnce({
  dryRun = false, log = console.error,
  cmuxAvailableFn = cmuxAvailable, listWorkspacesFn = listWorkspaces, runFn = run,
  writeStateFn = null, stateExistsFn = stateFileExists,
} = {}) {
  if (!cmuxAvailableFn()) { log('[cmux-auth-stall-watchdog] cmux not found — nothing to check.'); return { scanned: 0, marked: [] }; }
  let workspaces;
  try { workspaces = listWorkspacesFn(); } catch (e) { log(`[cmux-auth-stall-watchdog] listWorkspaces failed: ${e.message}`); return { scanned: 0, marked: [] }; }

  const marked = [];
  for (const w of workspaces) {
    if (!w || !w.ref) continue;
    // Already flagged — don't stomp an existing captured question/timestamp,
    // matches workspace-mark-done.js's own 'already-needs-you' noop.
    if (leadingGlyph(w.title) === '❓') continue;

    let screen;
    try { screen = runFn(['read-screen', '--workspace', w.ref]); }
    catch (e) {
      // Fail-safe like every other liveness probe in cmux-workspaces.js:
      // a transient read error is uncertainty, never a mark.
      log(`[cmux-auth-stall-watchdog] read-screen failed for ${w.ref} (${e.message}) — skipping`);
      continue;
    }

    const hit = detectAuthStall(screen);
    if (!hit) continue;

    log(`[cmux-auth-stall-watchdog] ${dryRun ? 'WOULD MARK' : 'MARKING'} ${w.ref} (${hit.kind}): ${hit.reason}`);
    marked.push({ ref: w.ref, title: w.title, ...hit });
    if (dryRun) continue;

    // Re-list and re-check IDENTITY right before the write — same TOCTOU
    // guard as pruneDone() in cmux-workspaces.js (card #971 adversarial
    // review): read-screen above can take a while (cmux's own auth-retry
    // ladder), and building newTitle from the now-stale `w.title` captured
    // at the top of this loop risks clobbering an owner edit, another
    // marking pass, or a since-recycled ref made during that window.
    let fresh;
    try { fresh = listWorkspacesFn().find(x => x && x.ref === w.ref); }
    catch (e) { log(`[cmux-auth-stall-watchdog] re-list failed for ${w.ref}: ${e.message} — skipping rename`); continue; }
    if (!fresh) { log(`[cmux-auth-stall-watchdog] ${w.ref}: gone by the time of the write — skipping rename`); continue; }
    if (leadingGlyph(fresh.title) === '❓') { log(`[cmux-auth-stall-watchdog] ${w.ref}: already ❓-marked since the scan — skipping rename`); continue; }

    // Re-check the CONDITION too, not just identity (adversarial review
    // finding): the pane could have logged back in or produced real output
    // during that same read-screen window. Writing off the FIRST read alone
    // would mark a tab that already recovered by the time of the write.
    let freshScreen, freshHit;
    try { freshScreen = runFn(['read-screen', '--workspace', w.ref]); }
    catch (e) { log(`[cmux-auth-stall-watchdog] re-read-screen failed for ${w.ref}: ${e.message} — skipping rename`); continue; }
    freshHit = detectAuthStall(freshScreen);
    if (!freshHit) { log(`[cmux-auth-stall-watchdog] ${w.ref}: recovered since the scan — skipping rename`); continue; }
    // Use the FRESH hit's kind/reason from here on (code-review finding): the
    // condition can change shape, not just resolve, between the two reads
    // (e.g. logged-out -> stalled-resume after a relaunch mid-scan) — writing
    // the STALE first-read kind/question would persist the wrong recovery
    // guidance even though the code went out of its way to re-verify first.

    const newTitle = `❓ ${stripManagedGlyph(fresh.title)}`.trim();
    if (newTitle === '❓') { log(`[cmux-auth-stall-watchdog] ${w.ref}: mark would empty the title — skipping rename`); continue; }

    try { runFn(['workspace-action', '--action', 'rename', '--workspace', w.ref, '--title', newTitle]); }
    catch (e) { log(`[cmux-auth-stall-watchdog] rename failed for ${w.ref}: ${e.message}`); continue; }

    // Never clobber an EXISTING needs-you state file (adversarial review
    // finding): the Stop hook writes into this exact directory for a real
    // DECISION NEEDED, uncoordinated with this watchdog. If something has
    // already claimed this ref, leave its captured question alone — the
    // rename above is still correct (❓ is a fine mark either way), only the
    // state-file WRITE is skipped so a real question is never overwritten
    // with this watchdog's generic recovery text.
    if (stateExistsFn(w.ref)) { log(`[cmux-auth-stall-watchdog] ${w.ref}: needs-you state already exists — leaving it, renamed only`); continue; }

    const state = {
      ref: w.ref,
      question: QUESTIONS[freshHit.kind],
      ts: new Date().toISOString(),
      source: 'cmux-auth-stall-watchdog',
      kind: freshHit.kind,
    };
    try {
      if (writeStateFn) writeStateFn(w.ref, state);
      else {
        fs.mkdirSync(NEEDS_YOU_DIR, { recursive: true });
        fs.writeFileSync(needsYouFile(w.ref), JSON.stringify(state, null, 2));
      }
    } catch (e) {
      log(`[cmux-auth-stall-watchdog] state write failed for ${w.ref}: ${e.message} (title was still renamed)`);
    }
  }
  return { scanned: workspaces.length, marked };
}

function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const dryRun = argv.includes('--dry-run');
  const { scanned, marked } = scanOnce({ dryRun });
  console.error(`[cmux-auth-stall-watchdog] scanned ${scanned} workspace(s), ${marked.length} flagged${dryRun ? ' (dry-run, nothing written)' : ''}`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { main, USAGE, scanOnce, leadingGlyph, stripManagedGlyph, needsYouFile, QUESTIONS, NEEDS_YOU_DIR };
