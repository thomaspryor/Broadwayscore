/**
 * cmux-auth-stall — pure detector for two "session looks fine, isn't" screen
 * shapes that BRO-4056 found invisible to every existing liveness/needs-you
 * signal:
 *
 *  - LOGGED OUT: a cmux pane's rendered screen shows the CLI's own auth
 *    rejection ("Not logged in · Please run /login", or a raw API auth
 *    error) AND draws none of the "ctx NN%" chrome a real live authenticated
 *    session always renders (hasClaudeChrome's contract in
 *    cmux-workspaces.js) — that second condition is load-bearing, not just
 *    heuristic: without it, a HEALTHY session merely displaying either
 *    phrase (quoting this exact bug, or showing an old error in scrollback
 *    it already recovered from) would false-positive (adversarial review
 *    finding). This is exactly the shape claude-cli.js's preflightAuth() was
 *    built to catch BEFORE a headless spawn (task #713) — but a pane
 *    restored/relaunched outside any of this repo's launch primitives (e.g.
 *    a raw `cmux restore-session` from an agent's own Bash tool, which does
 *    not carry CLAUDE_CODE_OAUTH_TOKEN — see BRO-4056) never goes through
 *    that gate, so nothing upstream ever refuses the launch. The pane just
 *    sits on a login prompt forever, chromeless, so every other liveness
 *    probe reads it as healthy.
 *
 *  - STALLED RESUME: a session resumed with no real prompt answers with the
 *    CLI's literal placeholder "No response requested." and then does
 *    nothing further — observed live in the BRO-4056 incident (7 sessions
 *    restored 2026-09-21 01:43-01:47 UTC sat this way for ~2 days). Checked
 *    against the session's LAST REAL CONTENT LINE (see lastRealContentLine
 *    below — not simply the last rendered line, which is usually persistent
 *    chrome, not assistant output), AND only while NOT busy (isBusy() below)
 *    — a session actively waiting on background agents right after that
 *    placeholder is working, not stalled (adversarial review finding). A
 *    session that produced real output after the placeholder is not stalled
 *    either way.
 *
 * Neither shape ever completes a normal Claude turn, so neither the Stop
 * hook (workspace-mark-done.js, DECISION NEEDED / SAFE-NOT-SAFE) nor the
 * cmux tag/process registry (claudeAliveIn) ever sees them — the whole
 * reason BRO-4056 calls the needs-you sidebar "brittle": it only reads a
 * leading ❓ title glyph that nothing was writing for these two cases.
 * scripts/cmux-auth-stall-watchdog.js polls read-screen for every live
 * workspace and calls detectAuthStall() on the result; a hit gets the same
 * ❓ glyph via `workspace-action --action rename` plus a needs-you state
 * file, reusing the exact mechanism bsc-needs-you.js / the digest / the
 * sidebar already read for a DECISION NEEDED tab, so no consumer needs to
 * learn a new signal.
 *
 * Pure (no fs/process/child_process) so it's testable against fixture screen
 * text with no cmux socket required (CLAUDE.md rule 15).
 */
'use strict';

// Matches the CLI's own worded rejection (claude-cli.js's own comment quotes
// it verbatim: "Not logged in · Please run /login") tolerant of the
// middot vs a plain separator, plus generic API-key rejections a raw
// ANTHROPIC_API_KEY spawn can hit instead.
const LOGGED_OUT_RE = /not logged in/i;
const LOGIN_HINT_RE = /\/login/i;
const API_AUTH_ERROR_RE = /invalid[\s_-]?api[\s_-]?key|authentication_error|please\s+run\s+`?\/login/i;

// The CLI's literal placeholder for a resume with nothing to answer.
// Anchored to the WHOLE line (allowing surrounding whitespace) so it never
// matches as a substring of unrelated real output that merely mentions the
// phrase.
const STALLED_RESUME_RE = /^no response requested\.?$/i;

// Same regex as hasClaudeChrome() in cmux-workspaces.js (kept as a separate
// constant, not an import, so this module stays dependency-free/pure per its
// header) — the persistent "ctx NN%" status-bar line every live session
// renders. VERIFIED LIVE against a real `cmux read-screen` capture on this
// machine (2026-09-22): the assistant's actual last spoken line sits ABOVE
// this bar, with a spinner line ("✳ Waiting for..."), an input-box
// border, and an empty "❯" prompt line in between, and MORE persistent
// chrome (permission-mode line, background-agent list) renders BELOW it. A
// naive "last non-blank line of the whole capture" (this file's first
// version) would therefore never match a real stalled session at all — it
// would hit that trailing chrome instead. lastRealContentLine() below walks
// upward from the chrome line (or the end of the text if no chrome renders
// yet — the exact shape of a fresh login-prompt pane) skipping the spinner/
// border/prompt noise, to find the last line the SESSION actually wrote.
const CHROME_LINE_RE = /│\s*ctx\s+(?:\?|\d+%)/;
const BORDER_RE = /^─{5,}$/;
// ✻ (U+273B) is cmux's IN-FLIGHT spinner ("✻ Waiting for N background agents
// to finish") — its presence means a turn is actively running, never
// "stalled" (isBusy() below). ✔ (U+2714) leads a static "Update installed ·
// Restart to update" banner — persistent chrome, not a busy signal, but
// still noise to skip when hunting for the assistant's real last line. Both
// captured from a real `read-screen` dump on this machine (2026-09-22).
const BUSY_RE = /^✻/;
const UPDATE_BANNER_RE = /^✔/;
// Any line led by the input-box prompt char, WITH OR WITHOUT a draft after
// it — an earlier version only matched a bare "❯" with nothing following,
// so a stalled pane with an unsubmitted draft in the box (adversarial review
// finding) stopped the upward scan at the draft line instead of continuing
// to the real last assistant line above it.
const PROMPT_LINE_RE = /^❯/;

function lastRealContentLine(text) {
  const lines = String(text || '').split('\n').map(l => l.trim());
  let chromeIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CHROME_LINE_RE.test(lines[i])) { chromeIdx = i; break; }
  }
  const upperBound = chromeIdx >= 0 ? chromeIdx : lines.length;
  for (let i = upperBound - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l || BORDER_RE.test(l) || BUSY_RE.test(l) || UPDATE_BANNER_RE.test(l) || PROMPT_LINE_RE.test(l)) continue;
    return l;
  }
  return '';
}

// A turn actively in flight is never "stalled", whatever its last real
// content line says (adversarial review finding: the original version
// treated the busy spinner as just more noise to skip past, which meant a
// session legitimately waiting on background agents right after a
// "No response requested." placeholder got flagged on its very first
// observation). Mirrors claudeMidTurnIn's fail-safe stance in
// cmux-workspaces.js: uncertain-or-busy must never read as idle-and-stuck.
function isBusy(text) {
  return String(text || '').split('\n').some(l => BUSY_RE.test(l.trim()));
}

function lastNonBlankLine(text) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

/**
 * @param {string} screenText raw `cmux read-screen --workspace <ref>` output.
 * @returns {{kind: 'logged-out'|'stalled-resume', reason: string}|null}
 */
function detectAuthStall(screenText) {
  const text = String(screenText || '');
  // Chrome-absence gate (adversarial review finding): without it, a HEALTHY
  // session merely displaying either phrase — quoting this bug in
  // conversation, showing an old error in scrollback it already recovered
  // from — would false-positive. A real live, authenticated session ALWAYS
  // draws the persistent "ctx NN%" bar (hasClaudeChrome's own contract in
  // cmux-workspaces.js); a truly logged-out pane never does. Requiring
  // chrome's absence is precise, not just heuristic: it directly encodes
  // "this pane genuinely has no live authenticated session on it."
  const hasChrome = CHROME_LINE_RE.test(text);
  if (!hasChrome && LOGGED_OUT_RE.test(text) && LOGIN_HINT_RE.test(text)) {
    return { kind: 'logged-out', reason: 'screen shows "Not logged in · Please run /login"' };
  }
  if (!hasChrome && API_AUTH_ERROR_RE.test(text)) {
    return { kind: 'logged-out', reason: 'screen shows an API auth rejection' };
  }
  if (!isBusy(text) && STALLED_RESUME_RE.test(lastRealContentLine(text))) {
    return { kind: 'stalled-resume', reason: 'last rendered line is the CLI\'s "No response requested." placeholder' };
  }
  return null;
}

module.exports = {
  detectAuthStall, lastRealContentLine, lastNonBlankLine, isBusy,
  LOGGED_OUT_RE, LOGIN_HINT_RE, API_AUTH_ERROR_RE, STALLED_RESUME_RE, CHROME_LINE_RE,
};
