/**
 * cmux-workspaces — shared Cmux workspace helpers for bsc-next / bsc-prune.
 *
 * Conventions (owner, 2026-07-12; closing rules tightened 2026-07-15):
 *  - A finished session retitles its own workspace with a leading ✅ (wrap-up
 *    skill / workspace-mark-done hook). The mark is visual ONLY. Closing is
 *    owner-triggered exclusively: bsc-prune (run by the owner) closes ✅-marked
 *    workspaces. Nothing closes automatically — wrap-up self-close and the
 *    bsc-next dispatch-time sweep were both removed after three same-day
 *    incidents of tabs closing while the owner was typing in them.
 *  - "Idle" = no running claude_code process in the workspace (cmux top tag).
 *    Idle but un-marked workspaces are listed, never auto-closed.
 *
 * Pure parsers are exported for tests; only the run/close/list wrappers touch
 * the cmux socket.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');
const { isCloseable, hasAutoDispatchMarker } = require('./prune-closeable.js');
const dispatchLedger = require('./dispatch-ledger.js');

const CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux';

function cmuxAvailable() {
  return fs.existsSync(CMUX);
}

function run(args) {
  return execFileSync(CMUX, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// ── pure logic (exported for tests) ────────────────────────────────────────

// Parse `cmux list-workspaces` lines:
//   "* workspace:31  Build: Autonomous nightly loop (v4)  [selected]"
//   "  workspace:2  ⠂ Box office card improvements"
function parseWorkspaces(text) {
  return String(text).split('\n').map(line => {
    const m = /^\s*(\*)?\s*(workspace:\d+)\s+(.*)$/.exec(line);
    if (!m) return null;
    const selected = Boolean(m[1]) || /\[selected\]\s*$/.test(m[3]);
    const title = m[3].replace(/\s*\[selected\]\s*$/, '').trim();
    return { ref: m[2], title, selected };
  }).filter(Boolean);
}

// The done marker must LEAD the title. cmux prepends activity glyphs
// (braille spinners ⠂/⠐, ✳) before the title in list output, so tolerate a
// few non-word prefix chars — but a ✅ later in a real title must not count.
function isDoneTitle(title) {
  return String(title).trim().slice(0, 4).includes('✅');
}

// `cmux top --workspace X --processes --format tsv` emits one row per node;
// a live Claude Code session appears as a tag row whose columns are
// cpu\trss\tproc\ttype\tid\tparent\tstatus. Column-exact match — a substring
// test would false-positive on statuses like "NotRunning" or a title
// containing "Running" (ship-check reviewer finding, 2026-07-12).
function hasRunningClaude(tsvText) {
  return String(tsvText).split('\n').some(l => {
    const c = l.split('\t');
    return c[3] === 'tag' && /:tag:claude_code$/.test(c[4] || '')
      && (c[6] || '').trim() === 'Running';
  });
}

// A claude_code PROCESS row (a `process` row parented to a claude_code tag),
// regardless of tag status. A claude waiting at the prompt has the tag row
// with NO status but its process rows are present — it is a live session.
// 2026-07-21 incident: pruneDone used the Running-only check, so a
// conductor's sweep closed 10 ✅-marked tabs whose claude was alive and
// waiting on the owner (✅ auto-marks land when the task completes, even with
// user review pending). Prune's charter is sweeping sessions that DIED —
// process presence, not activity, is the closability test. Requiring the
// process row (not just the tag) also keeps a hypothetical stale tag row
// left behind by a crashed claude prunable (codex ship-check finding).
function hasLiveClaude(tsvText) {
  return String(tsvText).split('\n').some(l => {
    const c = l.split('\t');
    return c[3] === 'process' && /:tag:claude_code$/.test(c[5] || '');
  });
}

// ── socket wrappers ─────────────────────────────────────────────────────────

function listWorkspaces() {
  return parseWorkspaces(run(['list-workspaces']));
}

function closeWorkspace(ref) {
  run(['close-workspace', '--workspace', ref]);
}

// Type text into a live workspace's prompt and submit it (card #1009). The two
// calls are the same pair a human-driven session ran by hand on 2026-08-04 to
// get a corrected card into workspace:156 — `cmux send <text>` fills the
// prompt, `send-key Enter` submits it. Text MUST already be a single line:
// cmux treats a newline (and the literal two-character sequence "\n") as
// Enter, so an unflattened message submits itself half-typed. Callers use
// dispatch-card-drift.formatAmendMessage, which flattens.
function sendToWorkspace(ref, text) {
  run(['send', '--workspace', ref, '--', String(text)]);
  run(['send-key', '--workspace', ref, 'Enter']);
}

// SAFE variant for the close-decision path (card #709 ship-check catch).
// An earlier version of this reused a legacy helper that failed OPEN to
// "not running" on any I/O error — the same unsafe direction the #559 fix
// (claudeAliveIn) eliminated from the close path. That legacy helper is
// deleted (what-else, card #709 follow-up) rather than kept around unused —
// its name was an attractive nuisance for a future session to grab instead
// of this one and reintroduce the exact false-negative it caused: a
// transient cmux error silently reading as "idle," pruneDone treating that
// as "safe to close," and a live ✅🤖 tab getting closed mid-turn on pure
// uncertainty. Fails safe to TRUE (mid-turn/busy) instead — uncertainty
// must never look like idle.
function claudeMidTurnIn(ref) {
  try {
    return hasRunningClaude(run(['top', '--workspace', ref, '--processes', '--format', 'tsv']));
  } catch {
    return true; // uncertain → treat as mid-turn → do not close
  }
}

function claudeAliveIn(ref) {
  try {
    return hasLiveClaude(run(['top', '--workspace', ref, '--processes', '--format', 'tsv']));
  } catch {
    // FAIL-SAFE for the close path: a transient cmux error (busy socket,
    // timeout) is indistinguishable from "vanished" here, and guessing
    // "dead" closes a live tab (both ship-check reviewers, 2026-07-21).
    // Treat errors as alive — a truly vanished workspace needs no closing.
    return true;
  }
}

// SECOND, INDEPENDENT liveness signal for the close path (card #559).
// claudeAliveIn only ever queries cmux's tag/process registry (`cmux top
// --processes`). Card #548 proved that registry can desync from cmux's
// separate terminal-surface registry (capture-pane/read-screen/list-panes) —
// there, the tag registry falsely said Running while the surface registry
// said the surface was gone (a false POSITIVE for the launch-verify path).
// Nothing rules out the same desync in the opposite direction here: the tag
// registry falsely saying dead while a real terminal surface — and possibly
// a human typing in it — is still there. pruneDone would then CLOSE a live
// tab (#559, the opposite direction of #548, same root cause).
//
// A bare "does the workspace still have a pane/surface" check (an earlier
// draft of this fix) turns out to be USELESS here: every ref pruneDone ever
// tests comes straight out of `listWorkspaces()`, so by construction it
// still exists and still has panes — that check would report "alive" for
// every workspace pruneDone considers and make it a permanent no-op
// (adversarial review caught this, 2026-07-26, verified live: 0/18
// workspaces on this machine were closable under that version of the check).
//
// What actually discriminates "dead" from "human still typing" is the
// RENDERED SCREEN CONTENT, not surface existence. A live Claude Code session
// draws a persistent status bar — model glyph + "ctx NN%" (or "ctx ?" before
// the first response) — for its entire lifetime, regardless of permission
// mode, git branch, or theme. This is real content-level evidence from a
// code path (the terminal renderer) completely independent of the
// tag/process bookkeeping claudeAliveIn reads. Verified LIVE on this
// machine, 2026-07-26: workspace:24 had claudeAliveIn() === false (no
// process row in the tag/process registry) while `read-screen` still showed
// "🔮 OPUS │ ctx 54% │ main │ Broadwayscore" — the exact #559 false-negative
// shape, reproduced in production, not hypothetical.
//
// Anchored on the SEPARATOR BEFORE "ctx", not what follows it — what
// follows varies (a "⚠" high-context warning glyph, more "│ segment" fields,
// or end-of-line when ctx is the last field), but the model-glyph section
// immediately preceding "ctx" is stable across every sample captured live.
// A second-pass adversarial review (2026-07-26) caught an earlier version of
// this regex that required "│" to immediately FOLLOW the percentage —
// verified live to false-negative on any workspace over ~75% context, where
// cmux inserts "ctx 77%⚠ │ ..." (the ⚠ breaks the old `\s*│` adjacency). 3 of
// 18 real workspaces on this machine hit that shape at the moment of
// testing, including one (workspace:118) that had been misdiagnosed as
// harmless "render-timing noise" before the actual cause was found.
//
// Known limitation, accepted: this check only runs from pruneDone when
// claudeAliveIn ALREADY said dead, so it never blocks a close that the
// primary registry alone would have skipped anyway. Requiring BOTH signals
// to independently misreport at the same moment (rather than trusting
// either alone) is the actual safety margin this fix buys, not a guarantee
// of zero false negatives from either check individually.
//
// Pure parser (exported for tests, per this file's convention above).
function hasClaudeChrome(screenText) {
  return /│\s*ctx\s+(?:\?|\d+%)/.test(String(screenText));
}

// A ref that was real and is now genuinely closed returns
// `Error: not_found: Workspace not found` from read-screen (verified live,
// 2026-07-26, against workspace:1 — a real, previously-issued, now-closed
// ID). That "not_found" is what confirms real death. This holds for real
// IDs; a NEVER-issued, out-of-range ref number (e.g. workspace:999999) falls
// back to the currently-selected workspace instead of erroring — a separate
// cmux quirk that doesn't affect pruneDone, since every ref it ever queries
// here comes straight out of a `listWorkspaces()` call that just ran, so it
// is always a real (until-a-moment-ago-valid) ID, never a fabricated one.
// Any error OTHER than not_found (busy socket, timeout) is uncertainty, not
// confirmation, and must NOT contribute to a close verdict — same fail-safe
// rule as claudeAliveIn. Pure parser (exported).
//
// Card #1829: cmux now also throws `Error: internal_error: ERROR: Terminal
// surface not found` for a workspace whose pane was never rendered (the
// #1199 deferred-render case) — a DIFFERENT error-type prefix
// (`internal_error`, not `not_found`) with the confirmation in the message
// text instead. The original regex only matched the `not_found:` prefix, so
// this shape fell through to "any other error = uncertainty" and
// terminalSurfaceAliveIn reported these workspaces ALIVE — the exact
// misclassification that let 7/7 dead cmux-tab dispatches on 2026-08-19
// report launch success with no agent running. Matching the message text
// directly (not just the error-type prefix) catches both shapes.
function isNotFoundError(message) {
  return /not_found|(?:surface|workspace|pane)\s+not\s+found/i.test(String(message || ''));
}

function terminalSurfaceAliveIn(ref) {
  try {
    return hasClaudeChrome(run(['read-screen', '--workspace', ref]));
  } catch (e) {
    return !isNotFoundError(e.message);
  }
}

// Card #1829, correctness fix from adversarial review: terminalSurfaceAliveIn
// requires hasClaudeChrome — the persistent "ctx NN%" status bar — which is
// the RIGHT bar for its existing callers (they already suspect the workspace
// might be dead on other grounds, so "chrome not painted yet" siding with
// "not proven alive" is the safe direction). It is the WRONG signal for a
// caller deciding whether to REPORT SUCCESS on a workspace that just this
// instant registered a live wrapper + cmux tag: claude can legitimately have
// a real, rendered pane for a moment before its own UI paints that status
// bar, and conflating "chrome not visible yet" with "surface confirmed gone"
// would make a brand-new, healthy launch fail this check by pure timing —
// the opposite failure mode from the one this card fixes (false success),
// but just as damaging to real dispatch throughput.
//
// This function answers only the narrower, purely negative question a
// success-path caller actually needs: is the surface CONFIRMED missing? A
// successful read-screen call proves the surface exists regardless of what
// is drawn on it yet, so only the isNotFoundError-classified exception case
// counts as confirmed-missing; every other outcome (a successful read with
// no chrome yet, or a different/transient error) is "not confirmed missing"
// — the correct fail-open direction for gating a success report.
function terminalSurfaceConfirmedMissing(ref) {
  try {
    run(['read-screen', '--workspace', ref]);
    return false;
  } catch (e) {
    return isNotFoundError(e.message);
  }
}

// Shared two-signal liveness check (cards #559/#564). claudeAliveIn alone
// queries only cmux's tag/process registry, which can desync from the truth
// in EITHER direction (#548: false positive; #559: false negative, verified
// live in production). Every call site that treats a workspace as
// confirmed-dead — closing it, or writing a 'dead' ledger breadcrumb that
// feeds the duplicate-dispatch guard — must require the independent
// terminal-surface registry (surfaceAliveFn) to ALSO report it gone before
// trusting that verdict. Any error deciding either signal = treat as alive
// (fail-safe): every caller of this function treats "dead" as license to do
// something consequential (close a tab, count a dispatch as failed), so
// uncertainty must never resolve to "dead".
//
// Returns { dead, disagreement }. disagreement is true when the primary
// registry said dead but the surface registry said alive — direct evidence
// the underlying cmux registry desync is happening in production right now,
// not just a theoretical risk this function guards against.
function checkLiveness(ref, aliveFn, surfaceAliveFn) {
  let primaryAlive = true;
  try { primaryAlive = aliveFn(ref); } catch { primaryAlive = true; }
  if (primaryAlive) return { dead: false, disagreement: false };
  let surfaceAlive = true;
  try { surfaceAlive = surfaceAliveFn(ref); } catch { surfaceAlive = true; }
  return { dead: !surfaceAlive, disagreement: surfaceAlive };
}

// Shared claudeAlive computation for launch-decision call sites (card #567,
// same class as #559/#564). A bare `claudeAliveIn(ref)` trusts cmux's
// tag/process registry alone, which can desync (see checkLiveness's header
// comment above) — here a false-negative ("dead" when the workspace is
// actually still running a long tool call) would make launchDecision return
// 'reclaim-and-launch' and open a duplicate babysitter session on top of a
// live one. Requires BOTH signals to agree "dead" before reporting not-alive.
// Test-only seams mirror pruneDone's pattern.
function computeClaudeAlive(meta, opts = {}) {
  if (!meta || !meta.workspaceRef) return false;
  const aliveFn = opts.claudeAliveIn || claudeAliveIn;
  const surfaceAliveFn = opts.terminalSurfaceAliveIn || terminalSurfaceAliveIn;
  return !checkLiveness(meta.workspaceRef, aliveFn, surfaceAliveFn).dead;
}

// Close ✅-marked 🤖 auto-dispatched workspaces that are dead or idle at the
// prompt (owner rule #3, 2026-08-02: auto-close is limited to sessions that
// were automatically spun up by other sessions — owner-opened ✅ tabs are
// never closed autonomously, even with a fully dead claude; they are
// reported as skipped and the owner closes them by hand). Mid-turn tabs are
// never closed (card #709: idle-at-prompt vs mid-turn distinction). The
// 2026-07-21 incident (10 tabs lost mid-review) is why uncertainty always
// resolves to skip. See scripts/lib/prune-closeable.js for the pure
// predicate + idle-vs-mid-turn signal (hasLiveClaude && !hasRunningClaude).
//
// "🤖 auto-dispatched" is detected two ways as of card #971: the title glyph
// (hasAutoDispatchMarker) OR an unreconciled dispatch-ledger launch record
// whose subject still matches the LIVE title (dispatchLedger.
// isLedgerAutoDispatched — two independent signals, ledger + title, so a
// recycled ref's unrelated owner-opened tab can't inherit a stale launch's
// auto-dispatch status) — a session that renames its tab mid-work drops the
// glyph but the ledger still remembers bsc-next.js launched it.
//
// A "not alive" verdict from claudeAliveIn alone is not enough to close
// (card #559) — see checkLiveness's header comment. Returns
// { closed, skipped, disagreements }; failures to close one workspace don't
// abort.
function pruneDone(opts = {}) {
  // Seams are test-only (prove the skip/throw paths without a cmux socket).
  const aliveFn = opts.claudeAliveIn || claudeAliveIn;
  const surfaceAliveFn = opts.terminalSurfaceAliveIn || terminalSurfaceAliveIn;
  const runningFn = opts.claudeMidTurnIn || claudeMidTurnIn;
  const listFn = opts.listWorkspaces || listWorkspaces;
  const closeFn = opts.closeWorkspace || closeWorkspace;
  const readLedgerEntriesFn = opts.readLedgerEntries || dispatchLedger.readEntries;
  const done = listFn().filter(w => isDoneTitle(w.title));
  const closed = [];
  const skipped = [];
  const disagreements = [];
  // Card #971: a 🤖 auto-dispatched session that renames its tab mid-work
  // (common — status-reflecting renames) drops the title glyph, so
  // hasAutoDispatchMarker alone misreads it as owner-opened and it never
  // auto-closes even after it ✅-marks and goes idle/dead. Read once per
  // sweep (not per workspace) — a ledger read failure fails closed to []
  // (isLedgerAutoDispatched then finds no launch for any ref, same as
  // before this fix: only the title glyph counts).
  let ledgerEntries = [];
  if (done.length) {
    try { ledgerEntries = readLedgerEntriesFn(); } catch { ledgerEntries = []; }
  }
  for (const w of done) {
    // Never close the workspace the owner is currently LOOKING AT (owner
    // escalation 2026-08-02, enables the scheduled auto-prune tick). A ✅🤖
    // tab is often selected precisely because the owner is reading its final
    // summary; yanking it mid-read is the 2026-07-15 "closed while typing"
    // incident class. A later tick closes it once focus moves elsewhere.
    if (w.selected) { skipped.push(w); continue; }
    const { dead, disagreement } = checkLiveness(w.ref, aliveFn, surfaceAliveFn);
    if (disagreement) disagreements.push(w);
    // Query mid-turn status for EVERY live ✅ tab (owner rule #3,
    // 2026-08-02: only 🤖 auto-dispatched tabs are closeable at all — see
    // prune-closeable.js — but the probe still runs for observability). Any
    // error defaults isRunning to true — fail-safe: never treat uncertainty
    // as "idle, close it."
    const isAutoDispatched = hasAutoDispatchMarker(w.title) || dispatchLedger.isLedgerAutoDispatched(w.ref, w.title, ledgerEntries);
    let isRunning = true;
    if (!dead) {
      try { isRunning = runningFn(w.ref); } catch { isRunning = true; }
    }
    // title is threaded through so isCloseable can veto crown (owner-loop) tabs
    // outright — see prune-closeable.js's CROWN_TAB_RE comment (task #1751).
    if (!isCloseable({ hasLiveClaude: !dead, isAutoDispatched, isRunning, title: w.title })) { skipped.push(w); continue; }
    if (opts.dryRun) { closed.push(w); continue; }
    // TOCTOU guard (adversarial review, 2026-08-02): the selected flag above
    // is a snapshot from the top-of-sweep listing — the liveness probes take
    // seconds per workspace, and the owner can click INTO this tab in that
    // window. Re-list immediately before the destructive close and skip if
    // it is selected NOW. Any error re-listing = uncertainty = don't close.
    //
    // Card #971 extension (Codex adversarial review P0, 2026-08-03): the
    // original guard only re-checked `selected`, not workspace IDENTITY — if
    // this exact ref were closed and immediately recycled to an unrelated
    // tab within the probe window, that new tab's title was never
    // re-verified before the close below. Re-run the SAME auto-dispatch test
    // against the FRESH title (not the stale `w.title` this loop iteration
    // captured) so a same-tick identity change also aborts the close, not
    // just a same-tick selection change.
    try {
      const fresh = listFn().find(x => x.ref === w.ref);
      if (!fresh || fresh.selected) { skipped.push(w); continue; }
      const stillAutoDispatched = hasAutoDispatchMarker(fresh.title) || dispatchLedger.isLedgerAutoDispatched(fresh.ref, fresh.title, ledgerEntries);
      if (!stillAutoDispatched) { skipped.push(w); continue; }
    } catch { skipped.push(w); continue; }
    try { closeFn(w.ref); closed.push(w); }
    catch (e) { console.error(`[cmux-workspaces] failed to close ${w.ref}: ${e.message}`); }
  }
  return { closed, skipped, disagreements };
}

module.exports = {
  CMUX, cmuxAvailable, run,
  parseWorkspaces, isDoneTitle, hasRunningClaude, hasLiveClaude,
  hasClaudeChrome, isNotFoundError,
  listWorkspaces, closeWorkspace, sendToWorkspace, claudeMidTurnIn, claudeAliveIn,
  terminalSurfaceAliveIn, terminalSurfaceConfirmedMissing, checkLiveness, computeClaudeAlive, pruneDone,
};
