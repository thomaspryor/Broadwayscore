'use strict';
/**
 * dispatch-timeout-match.js — pure predicate: does this shell command wrap a
 * NON-detached headless dispatcher in a wall-clock killer?
 *
 * BRO-3053. `linear-next.js --headless` / `bsc-next.js --headless` await the
 * job for its entire life, so the dispatching process IS the job's parent.
 * `timeout N node scripts/linear-next.js --id BRO-X --headless` SIGTERMs that
 * parent; node exits on the default disposition, claude-cli.js's close handler
 * never runs, and the job dies with no exit marker and no terminal ledger row.
 * Six jobs were lost that way on 2026-09-08 and the failure was misdiagnosed
 * as memory starvation across five sessions. `--detach` makes the wrapper
 * harmless, so a command carrying --detach is NOT flagged.
 *
 * Lives in scripts/lib/ (not inline in the hook) on purpose: CLAUDE.md rule 15
 * — the hook shells out to this, the test require()s it, so the hook and the
 * test can never drift. Same shape as
 * ~/.claude/hooks/block-resend-broadcasts.sh:70-84 -> its strip lib.
 *
 * DELIBERATELY NOT a general "does this command push/dispatch" inference. The
 * v49 push-gate rewrite established that deciding what a program DOES from its
 * command line is the halting problem wearing a regex. This asks a much
 * narrower, decidable question: do the literal tokens `timeout`/`gtimeout` and
 * a known dispatcher script path appear in the same command segment.
 */

// Wrapper words that may sit between `timeout` and the real command, matching
// the prefix group ~/.claude/hooks/gh-poll-block.sh:154 already uses.
const TIMEOUT_RE = /(^|[;&|(]|\$\()\s*(?:env(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S+)*\s+|nohup\s+|nice\s+(?:-n\s*\S+\s+)?|command\s+)*(?:g?timeout)\b/;

// The dispatchers whose --headless path awaits the job. bsc-runner.js is
// included because a direct `node scripts/lib/bsc-runner.js` invocation has
// the identical shape.
const DISPATCHER_RE = /\b(?:scripts\/)?(?:linear-next|bsc-next)\.js\b|\bscripts\/lib\/bsc-runner\.js\b/;

// A switch is ON if it appears bare, or with a value linear-next.js's
// coerceFlagValue (scripts/linear-next.js:206) does NOT read as false.
// `''`, `0` and `false` (any case) mean OFF there, so they must mean OFF here
// too or the two disagree about what the command actually does.
//
// The value is terminated by whitespace, a quote, or end of string — NOT by
// end of string alone. Anchoring the "is it off?" lookahead to `$` was a real
// false negative: `--detach=0 --headless` (flag not last) read as detached and
// sailed through, while coerceFlagValue read it as attached and the job died.
// Both reviewers found this independently.
const VALUE_END = '(?=$|[\\s\'"])';
function switchOnRe(name) {
  // bare `--name`, or `--name=<something that is not 0/false/empty>`
  return new RegExp(`(^|[\\s'"])--${name}(${VALUE_END}|=(?!(?:0|false|FALSE|False)?${VALUE_END}))`);
}

// Case matters: parseArgs (scripts/linear-next.js:212) is case-SENSITIVE, so
// `--DETACH` does NOT set args.detach — the job would run attached and die.
// A case-insensitive DETACH_RE would have whitelisted exactly that command.
const HEADLESS_RE = switchOnRe('headless');
const DETACH_RE = switchOnRe('detach');

/**
 * Split on the shell operators that start a new command. `&&`, `||`, `;`,
 * newline, and a single `&` (backgrounding) all begin a new command; a single
 * `|` deliberately does NOT, because the six real killers piped the dispatch
 * itself into `tail` and must stay in one segment.
 * @param {string} cmd
 * @returns {string[]}
 */
function segments(cmd) {
  return String(cmd || '').split(/&&|\|\||(?<!&)&(?!&)|[;\n]/);
}

/**
 * @param {string} cmd raw command string from the PreToolUse payload
 * @returns {{match: boolean, segment: string|null, reason: string|null}}
 */
function matchesTimeoutWrappedDispatch(cmd) {
  const text = String(cmd || '');
  if (!text) return { match: false, segment: null, reason: null };
  for (const seg of segments(text)) {
    if (!DISPATCHER_RE.test(seg)) continue;
    if (!HEADLESS_RE.test(seg)) continue;
    // --detach means the dispatcher hands the job its own session, so the
    // wrapper can only ever kill the (already-returned) launcher.
    if (DETACH_RE.test(seg)) continue;
    if (!TIMEOUT_RE.test(seg)) continue;
    return {
      match: true,
      segment: seg.trim(),
      reason: 'timeout wrapper on a non-detached headless dispatch',
    };
  }
  return { match: false, segment: null, reason: null };
}

module.exports = { matchesTimeoutWrappedDispatch, segments, TIMEOUT_RE, DISPATCHER_RE, HEADLESS_RE, DETACH_RE };
