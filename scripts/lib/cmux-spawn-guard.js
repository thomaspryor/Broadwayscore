#!/usr/bin/env node
// scripts/lib/cmux-spawn-guard.js — pure detection for "who is allowed to
// spawn the cmux binary" (BRO-3001).
//
// WHY THIS EXISTS
// ---------------
// BRO-2959 fixed a cmux socket auth outage by putting the credential at the
// spawn boundary: cmux-socket-auth.js's cmuxSpawnEnv() was wired into eight
// direct spawn sites plus cmux-workspaces.run(). Its header states the rule
// in prose — "the credential belongs at the socket boundary, not in 25
// LaunchAgent plists ... buildCmuxEnv() is the one place to fix."
//
// Prose is not a check. Nine review rounds went by and TWO spawn sites were
// still uncovered, for the same reason each time: neither one looked like the
// others to a human grepping for the absolute cmux path.
//
//   scripts/dispatch-watchdog.js:381   spawnSync(cmuxws.CMUX, ['new-workspace', ...])
//       — used the RE-EXPORTED constant, so a /Applications/cmux.app/ grep
//         never saw it. Reached from launchd every 900s via health() ->
//         ensureTab() -> createTab(), i.e. exactly when the crowned tab is
//         already dead. It worked only because three LaunchAgent plists still
//         set CMUX_SOCKET_PASSWORD by hand — the band-aid BRO-2959 itself
//         calls "REDUNDANT with the code fix", i.e. invites removing.
//   scripts/audit-dispatch-outcomes.js:66  execFileSync('cmux', [...])
//       — invoked a BARE `cmux` off PATH. Same grep miss; also silently
//         unavailable under launchd, where PATH has no cmux at all.
//
// So the invariant this guard enforces is deliberately NOT "every spawn call
// carries cmuxSpawnEnv". That rule is satisfiable by copy-paste at each new
// site and gets you attempt 1 only — a ROTATED password still kills the call,
// because the 3-rung auth-denied retry ladder lives in cmux-workspaces.run().
// The stronger, simpler rule is:
//
//   Nothing outside scripts/lib/cmux-workspaces.js may spawn the cmux binary
//   without cmuxSpawnEnv() on the same call.
//
// Detection is pure and unit-tested here per project rule §15; the filesystem
// walk and report formatting live in scripts/audit-cmux-spawn-credential.js.
//
// WAIVER: a reviewed false positive takes an inline `cmux-spawn-ok: <reason>`
// comment on the offending line or the line above it — same shape as
// unbounded-fetch-ok, and deliberately NOT a central allowlist, which rots
// out of sight of the code it exempts.

'use strict';

// The one module allowed to spawn cmux directly. Everything else goes through
// its run()/listWorkspaces()/sendToWorkspace() wrappers, which carry the
// credential AND the retry ladder AND the 30s timeout.
const SPAWN_OWNER = 'scripts/lib/cmux-workspaces.js';

// Node child_process entry points. `exec`/`execSync` take a shell STRING
// rather than a file+argv, so a bare `cmux ...` inside one is caught by the
// command-text test below rather than by the first-argument test.
const SPAWN_FNS = ['execFileSync', 'execFile', 'spawnSync', 'spawn', 'execSync', 'exec'];

// How a call's command argument can name cmux. Ordered widest-first only for
// readability; all are tried.
//   - the absolute app path (the form a naive grep finds)
//   - a CMUX / CMUX_BIN / cmuxws.CMUX style identifier
//   - a bare quoted 'cmux' command
// Deliberately NOT "the line mentions cmux": cmux-launch.js spawns `sleep`,
// `open` and `ps` from inside a cmux-named module and must not fire.
const CMUX_PATH_RE = /\/Applications\/cmux\.app\/Contents\/Resources\/bin\/cmux/;
const CMUX_IDENT_RE = /(?:^|[^A-Za-z0-9_.])(?:[A-Za-z_$][A-Za-z0-9_$]*\.)?CMUX(?:_BIN|_PATH)?(?![A-Za-z0-9_])/;
const CMUX_BARE_RE = /(['"`])cmux\1/;
// For exec/execSync, whose single argument is a shell command string.
//
// cmux must be the COMMAND, not an argument: the boundary class is the opening
// quote or a shell separator (; && || | $( ), NOT bare whitespace. With
// whitespace in the class, `execSync('pgrep -f cmux')` — searching the process
// table FOR cmux, which spawns nothing — was reported as a blocking violation
// (ship-check finding). Matching the opening quote is still required, because
// `execSync('cmux …')` puts the command flush against it.
const CMUX_IN_SHELL_RE = /(['"`])\s*cmux[\s'"`]|[;&|(]\s*cmux[\s'"`]/s;

const WAIVER_RE = /cmux-spawn-ok:\s*\S/;
const CREDENTIAL_RE = /cmuxSpawnEnv\s*\(/;

/**
 * Blank out comments, preserving every byte offset and line break.
 *
 * Required, not cosmetic: this guard's OWN header quotes the two offending
 * call sites verbatim as the motivating example, and a scanner that reads
 * comments reports itself as a violation. So does any file that documents a
 * spawn in prose — and a doc comment is exactly where a fixed call site gets
 * described. Replacing comment bytes with spaces (newlines kept) means the
 * caller's line numbers and the waiver lookup still line up.
 *
 * Waiver comments are read from the RAW text by isWaived(), so blanking here
 * does not hide them.
 *
 * @param {string} text
 * @returns {string} same length, comments replaced by spaces
 */
function stripComments(text) {
  // Deliberately LINE-LOCAL and stateless, not a whole-file lexer.
  //
  // The lexer version of this was written first and was wrong on this very
  // file: `const CMUX_BARE_RE = /(['"`])cmux\1/;` contains a quote character
  // inside a REGEX literal, so a scanner that tracks string state across lines
  // opened a string at that quote and stayed "inside" it for the next several
  // lines, desynchronising everything after — which surfaced as this guard
  // reporting its own header comment as a violation. Distinguishing a regex
  // literal from a division needs real parsing.
  //
  // Resetting at every newline makes that class of desync impossible: the
  // worst a confusing line can do is mis-handle itself. What is left is
  // sufficient here because a comment holding a spawn call is always either a
  // whole comment line (a `//` header or a `*` JSDoc body — how this file
  // quotes the two BRO-3001 call sites) or a trailing `//` after code.
  // ONE piece of cross-line state: template-literal depth. Backticks are the
  // only JS string that spans lines, and this repo really does generate shell
  // scripts that way (dispatch-watchdog.js:380). Without it, a code-generating
  // template whose body contains `execFileSync('cmux', ...)` on its own line
  // was reported as a BLOCKING violation — a guard that fails CI on a string
  // (ship-check finding). Tracking backtick parity is safe where tracking
  // quotes was not: JS requires backticks to balance, and `'`/`"` spans stay
  // line-local, so a quote inside a regex literal cannot desync it.
  let inTemplate = false;
  return text.split('\n').map((line) => {
    if (inTemplate) {
      // Inside a multi-line template: blank until its closing backtick.
      let close = -1;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '\\') { i++; continue; }
        if (line[i] === '`') { close = i; break; }
      }
      if (close === -1) return ' '.repeat(line.length);
      inTemplate = false;
      return ' '.repeat(close + 1) + line.slice(close + 1);
    }
    const trimmed = line.trimStart();
    // Whole comment line: blank it, keeping width so offsets still line up.
    // `/*` is deliberately NOT in this list — a line that OPENS a block
    // comment can still carry real code after the `*/`
    // (`/* note */ execFileSync(...)`), and blanking the whole line hid it.
    // The scanner below handles `/*` wherever it appears, start of line
    // included, and only blanks through the closing `*/`.
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
      return ' '.repeat(line.length);
    }
    // Trailing `//` or a mid-line `/*`, but only when not inside a quoted
    // string on this line (a URL like "https://x" must survive).
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '`') {
        // Find this template's close on the SAME line; if there is none it
        // spans lines and the next iteration takes the branch above.
        let j = i + 1;
        for (; j < line.length; j++) {
          if (line[j] === '\\') { j++; continue; }
          if (line[j] === '`') break;
        }
        if (j >= line.length) { inTemplate = true; return line.slice(0, i + 1) + ' '.repeat(line.length - i - 1); }
        i = j;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '/' && line[i + 1] === '/') {
        return line.slice(0, i) + ' '.repeat(line.length - i);
      }
      // Mid-line block comment (ship-check finding, Codex):
      // `const x = 1; /* spawnSync(CMUX, []) */` was scanned as code, because
      // only a block comment that STARTS the line was handled. Blank to the
      // closing `*/` on this line, or to end-of-line when it opens a
      // multi-line block (whose body lines start with `*` or `/*` and are
      // already handled above).
      if (ch === '/' && line[i + 1] === '*') {
        const close = line.indexOf('*/', i + 2);
        if (close === -1) return line.slice(0, i) + ' '.repeat(line.length - i);
        return line.slice(0, i) + ' '.repeat(close + 2 - i) + line.slice(close + 2);
      }
    }
    return line;
  }).join('\n');
}

/**
 * Slice the source text of one call expression, starting at the index of the
 * spawn function's name and running to its matching close paren.
 *
 * Why not a line-based read: every real site in this repo spans two to four
 * lines, with the `env:` option on a later line than the command argument. A
 * per-line check would report a false positive on all of them.
 *
 * @param {string} text  full file source
 * @param {number} from  index of the first character of the function name
 * @returns {{call: string, endLine: number}|null} null when unbalanced.
 */
function sliceCall(text, from) {
  const open = text.indexOf('(', from);
  if (open === -1) return null;
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { call: text.slice(from, i + 1), end: i };
    }
  }
  return null;
}

/** 1-indexed line number of a character offset. */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * Is this call spawning the cmux binary?
 *
 * Only the command ARGUMENT is examined for the file+argv shaped entry points
 * — not the whole call — so `spawnSync(CMUX, ['top', '--workspace', ref])`
 * fires while `spawnSync('ps', [...])` inside cmux-launch.js does not, even
 * though both live in a file whose every line mentions cmux.
 */
function callSpawnsCmux(call, fnName) {
  const open = call.indexOf('(');
  if (open === -1) return false;
  const args = call.slice(open + 1);
  if (fnName === 'exec' || fnName === 'execSync') {
    // Single shell-string argument: look for a `cmux` command token anywhere
    // in the first string literal.
    return CMUX_IN_SHELL_RE.test(args) || CMUX_PATH_RE.test(args);
  }
  // file+argv shape: the command is everything up to the first top-level comma.
  let depth = 0;
  let quote = null;
  let cut = args.length;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) { cut = i; break; }
  }
  const cmd = args.slice(0, cut);
  return CMUX_PATH_RE.test(cmd) || CMUX_IDENT_RE.test(cmd) || CMUX_BARE_RE.test(cmd);
}

/**
 * Was this call waived? An inline `cmux-spawn-ok: <reason>` on the call's own
 * first line, or on the line directly above it.
 */
function isWaived(lines, lineNumber) {
  const here = lines[lineNumber - 1] || '';
  const above = lines[lineNumber - 2] || '';
  return WAIVER_RE.test(here) || WAIVER_RE.test(above);
}

/**
 * Find every unguarded cmux spawn in one file's source.
 *
 * @param {string} text     file contents
 * @param {string} relPath  repo-relative path, used to exempt the owner module
 * @returns {{line:number, fn:string, reason:string, snippet:string}[]}
 */
function findUnguardedCmuxSpawns(rawText, relPath) {
  if (typeof rawText !== 'string' || !rawText) return [];
  // The owner module is where the credential and the ladder live; it must
  // spawn directly or there is nothing to delegate to.
  if (String(relPath).replace(/^\.\//, '') === SPAWN_OWNER) return [];

  // Scan code only; waivers are still read from the raw source below.
  const text = stripComments(rawText);
  const lines = rawText.split('\n');
  const findings = [];
  const seen = new Set();

  for (const fn of SPAWN_FNS) {
    // Word-boundary before, so `execFileSync` is not also matched as `exec`
    // and a method named `respawn` is not matched as `spawn`.
    //
    // A leading `.` IS allowed (ship-check finding, Codex): the boundary class
    // used to exclude it, which made the idiomatic member-call form
    //   const childProcess = require('child_process');
    //   childProcess.spawnSync('cmux', args)
    // invisible to the guard — a one-line refactor away from the exact bug
    // this exists to catch. `[^A-Za-z0-9_$]` still rejects `respawnSync`,
    // while `\.?` lets `cp.spawnSync(...)` through to the argument test.
    const re = new RegExp(`(?:^|[^A-Za-z0-9_$])\\.?(${fn})\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const at = m.index + m[0].length - fn.length - 1;
      const start = text.indexOf(fn, at >= 0 ? at : m.index);
      const sliced = sliceCall(text, start);
      if (!sliced) continue;
      if (!callSpawnsCmux(sliced.call, fn)) continue;
      const line = lineOf(text, start);
      // Keyed on the call's START OFFSET, not its line. Keying on the line
      // dropped a second violation sharing it — and SPAWN_FNS ordering could
      // make the SURVIVOR the advisory one, so
      //   try { spawnSync(CMUX,a,{env:cmuxSpawnEnv(p)}) } catch { spawnSync(CMUX,a,{}) }
      // reported 'ladder' only and exited 0, silently dropping the
      // credential-less call (ship-check finding, reproduced).
      if (seen.has(start)) continue;
      seen.add(start);
      if (isWaived(lines, line)) continue;
      if (CREDENTIAL_RE.test(sliced.call)) {
        // Carries the credential but still bypasses the retry ladder. Reported
        // so a rotated password cannot silently kill the call, but named
        // distinctly from the no-credential case.
        findings.push({
          line, fn, severity: 'ladder',
          reason: `spawns cmux directly with cmuxSpawnEnv but bypasses ${SPAWN_OWNER}'s auth-denied retry ladder — a ROTATED password still fails this call`,
          snippet: (lines[line - 1] || '').trim().slice(0, 120),
        });
        continue;
      }
      findings.push({
        line, fn, severity: 'credential',
        reason: `spawns the cmux binary with no socket credential — denied outright whenever automation.socketControlMode is not ancestry-based (the BRO-2959 outage)`,
        snippet: (lines[line - 1] || '').trim().slice(0, 120),
      });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

module.exports = {
  SPAWN_OWNER,
  SPAWN_FNS,
  findUnguardedCmuxSpawns,
  // exported for tests
  stripComments,
  sliceCall,
  callSpawnsCmux,
  isWaived,
};
