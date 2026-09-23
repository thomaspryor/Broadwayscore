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
 * AUTO-HEAL (BRO-4065): a LOGGED-OUT tab is repaired, not just marked. The
 * dead claude is stopped and the same session resumed inside that tab's own
 * shell via scripts/lib/claude-tab-relaunch.js (types
 * scripts/lib/relaunch-claude-tab.sh, which carries the login token), then
 * the tab must show its normal prompt again. Only if that fails does the tab
 * get ❓ plus a plain-English line. Limits: at most one attempt per tab per
 * 30 min, never a busy tab, never a tab whose claude isn't sitting directly
 * in an interactive shell. A ❓ this watchdog put on a logged-out tab is
 * retried on later cycles and cleared once the tab is healed. Stalled-resume
 * tabs are still only marked (they are logged in; restarting would not help).
 *
 * Never closes anything. Otherwise the only writes are a cosmetic rename
 * (❓-prefix) plus a needs-you state JSON — the exact mechanism
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
const { healTab } = require('./lib/claude-tab-relaunch.js');

const HEAL_STATE_DIR = path.join(path.dirname(NEEDS_YOU_DIR), 'auth-stall-heal');
const HEAL_MIN_INTERVAL_MS = 30 * 60 * 1000;
const SOURCE = 'cmux-auth-stall-watchdog';

const USAGE = `cmux-auth-stall-watchdog — repair logged-out cmux tabs; mark the rest ❓ NEEDS YOU.

Usage:
  node scripts/cmux-auth-stall-watchdog.js             scan every live workspace, heal logged-out tabs, mark the rest
  node scripts/cmux-auth-stall-watchdog.js --dry-run    scan and report only, no relaunch/rename/state write
  node scripts/cmux-auth-stall-watchdog.js --help       show this message, do nothing else

Logged-out tabs are relaunched in place with the saved login (max 1 try per tab per 30 min,
never a busy tab); only a failed repair is marked ❓. Never closes a workspace.
Detection: scripts/lib/cmux-auth-stall.js (BRO-4056). Repair: scripts/lib/claude-tab-relaunch.js (BRO-4065).
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

// Owner-facing, so plain English only (BRO-4065): never tell the owner to
// /login — the keychain sentinel wipes a manual login within 5 minutes.
const QUESTIONS = {
  'logged-out': 'This tab lost its login and couldn\'t be restarted automatically. You don\'t need to log in. The system retries every 30 minutes; if it still shows this, close the tab or ask any other session to "relaunch the logged-out tab".',
  'stalled-resume': 'This tab was reopened but never picked its work back up, so it has been sitting idle. Type what you want it to do, or close it if you no longer need it.',
};
// For an agent session reading the state file, not for the owner.
function agentRemedy(ref) {
  return `node scripts/relaunch-claude-tab.js --workspace ${ref}`;
}

function stateFileExists(ref) {
  try { return fs.existsSync(needsYouFile(ref)); } catch { return false; }
}

function readState(ref) {
  try { return JSON.parse(fs.readFileSync(needsYouFile(ref), 'utf8')); } catch { return null; }
}

// Only ever removes a state file THIS watchdog wrote (re-read + source check)
// — a DECISION NEEDED captured by the Stop hook is never touched.
function clearOwnState(ref) {
  const st = readState(ref);
  if (st && st.source === SOURCE) fs.unlinkSync(needsYouFile(ref));
}

function lastHealAttempt(ref) {
  try { return JSON.parse(fs.readFileSync(needsYouFile(ref, HEAL_STATE_DIR), 'utf8')).ts || null; } catch { return null; }
}

function recordHealAttempt(ref, result) {
  fs.mkdirSync(HEAL_STATE_DIR, { recursive: true });
  fs.writeFileSync(needsYouFile(ref, HEAL_STATE_DIR), JSON.stringify({ ref, ts: Date.now(), healed: !!result.healed, reason: result.reason, command: result.command || null }, null, 2));
}

function scanOnce({
  dryRun = false, log = console.error,
  cmuxAvailableFn = cmuxAvailable, listWorkspacesFn = listWorkspaces, runFn = run,
  writeStateFn = null, stateExistsFn = stateFileExists,
  readStateFn = readState, clearStateFn = clearOwnState,
  healFn = null, lastHealAttemptFn = lastHealAttempt, recordHealAttemptFn = recordHealAttempt,
  now = Date.now,
} = {}) {
  const empty = { scanned: 0, marked: [], healed: [] };
  if (!cmuxAvailableFn()) { log('[cmux-auth-stall-watchdog] cmux not found — nothing to check.'); return empty; }
  let workspaces;
  try { workspaces = listWorkspacesFn(); } catch (e) { log(`[cmux-auth-stall-watchdog] listWorkspaces failed: ${e.message}`); return empty; }

  const heal = healFn || ((ref) => healTab(ref, { deps: { runFn } }));
  // One repair attempt per tab per HEAL_MIN_INTERVAL_MS, recorded BEFORE the
  // attempt's outcome is known so a crash mid-attempt still counts. Returns
  // null when rate-limited.
  function tryHeal(ref) {
    let last = null;
    try { last = lastHealAttemptFn(ref); } catch { /* unreadable → treat as never tried */ }
    if (last && now() - last < HEAL_MIN_INTERVAL_MS) {
      log(`[cmux-auth-stall-watchdog] ${ref}: repair already tried ${Math.round((now() - last) / 60000)} min ago — waiting before the next try`);
      return null;
    }
    try { recordHealAttemptFn(ref, { healed: false, reason: 'attempt started' }); } catch (e) { log(`[cmux-auth-stall-watchdog] ${ref}: could not record repair attempt (${e.message}) — skipping repair`); return null; }
    let result;
    try { result = heal(ref); } catch (e) { result = { healed: false, reason: `repair threw: ${e.message}` }; }
    if (!result || typeof result !== 'object') result = { healed: false, reason: 'repair returned nothing' };
    try { recordHealAttemptFn(ref, result); } catch { /* the 'attempt started' row already rate-limits */ }
    log(`[cmux-auth-stall-watchdog] ${ref}: repair ${result.healed ? 'SUCCEEDED' : 'failed'} — ${result.reason}${result.command ? ` (typed: ${result.command})` : ''}`);
    return result;
  }

  const marked = [];
  const healed = [];
  for (const w of workspaces) {
    if (!w || !w.ref) continue;
    // Already flagged — don't stomp an existing captured question/timestamp,
    // matches workspace-mark-done.js's own 'already-needs-you' noop. The one
    // exception: a logged-out ❓ THIS watchdog wrote is retried (rate-limited)
    // and cleared once the tab is healed.
    if (leadingGlyph(w.title) === '❓') {
      const st = readStateFn(w.ref);
      if (!st || st.source !== SOURCE || st.kind !== 'logged-out') continue;
      if (dryRun) { log(`[cmux-auth-stall-watchdog] WOULD RETRY REPAIR of ${w.ref} (marked logged-out earlier)`); continue; }
      const r = tryHeal(w.ref);
      if (!r || !r.healed) continue;
      healed.push({ ref: w.ref, title: w.title, reason: r.reason });
      try {
        const fresh = listWorkspacesFn().find(x => x && x.ref === w.ref);
        if (fresh && leadingGlyph(fresh.title) === '❓') {
          const cleared = stripManagedGlyph(fresh.title);
          if (cleared) runFn(['workspace-action', '--action', 'rename', '--workspace', w.ref, '--title', cleared]);
        }
        clearStateFn(w.ref);
      } catch (e) { log(`[cmux-auth-stall-watchdog] ${w.ref}: healed, but clearing the ❓ failed: ${e.message}`); }
      continue;
    }

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

    if (hit.kind === 'logged-out' && !dryRun) {
      const r = tryHeal(w.ref);
      if (r && r.healed) { healed.push({ ref: w.ref, title: w.title, reason: r.reason }); continue; }
    }

    log(`[cmux-auth-stall-watchdog] ${dryRun ? `WOULD ${hit.kind === 'logged-out' ? 'REPAIR (or mark if that fails)' : 'MARK'}` : 'MARKING'} ${w.ref} (${hit.kind}): ${hit.reason}`);
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
      source: SOURCE,
      kind: freshHit.kind,
      ...(freshHit.kind === 'logged-out' ? { agentRemedy: agentRemedy(w.ref) } : {}),
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
  return { scanned: workspaces.length, marked, healed };
}

function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const dryRun = argv.includes('--dry-run');
  const { scanned, marked, healed } = scanOnce({ dryRun });
  console.error(`[cmux-auth-stall-watchdog] scanned ${scanned} workspace(s), ${healed.length} repaired, ${marked.length} flagged${dryRun ? ' (dry-run, nothing written)' : ''}`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { main, USAGE, scanOnce, leadingGlyph, stripManagedGlyph, needsYouFile, agentRemedy, QUESTIONS, NEEDS_YOU_DIR, HEAL_STATE_DIR, HEAL_MIN_INTERVAL_MS };
