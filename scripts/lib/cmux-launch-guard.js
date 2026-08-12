#!/usr/bin/env node
// scripts/lib/cmux-launch-guard.js — pure decision function for the
// PreToolUse(Bash) hook at ~/.claude/hooks/cmux-launch-guard.sh.
//
// Incident (task #1306, 2026-08-12): a session ran
//   cmux new-workspace --command "claude --model claude-fable-5 <seed>"
// by hand instead of using the canonical launcher (scripts/bsc-next.js:1007 /
// scripts/lib/cmux-launch.js:491, which always appends
// --dangerously-skip-permissions). Without the flag the launched session
// permission-pinged on nearly every tool call, and inbound cross-session
// messages queued to it EXPIRED UNDELIVERED (2 lost in one hour) because
// nothing was there to approve them. Owner: "fix it so no other sessions can
// be thoughtless like that" — must be mechanically impossible, not a CLAUDE.md
// prose rule.
//
// DETECTION SHAPE (deliberately narrower than a bare `\bclaude\b` regex,
// which would false-positive on "claude-teams"/"claude-code-guide" — see
// findUnsafeClaudeInvocation below):
//   1. Must contain a bare `new-workspace` token (cmux's create-workspace
//      subcommand).
//   2. Must have a `--command` flag; no --command → nothing to check (a
//      plain `cmux ~/repo` terminal, or `cmux workspace-action ...`).
//   3. Within that --command value, split into shell segments (;/&&/||/|)
//      and look for one whose first token's basename is EXACTLY "claude"
//      AND that includes --model (the shape both bsc-next.js and
//      cmux-launch.js always use for a real interactive launch — this also
//      excludes non-interactive subcommands like `claude doctor`,
//      `claude mcp serve`, `claude --version`, `claude --print "x"`, none of
//      which are the launch class that caused the incident).
//   4. If that segment lacks a bare --dangerously-skip-permissions token →
//      BLOCK.
//   5. One level of recursion into `bash <file>` / `sh <file>` wrapper
//      indirection: cmux-launch.js:508-511 itself types a short
//      ` bash <tmpfile>` as --command and puts the real `claude ...` line
//      inside that file (shell-init race workaround). A hand-rolled launch
//      that copies this shape must not be able to hide the same violation
//      inside the wrapper file — so if a segment's first token is a shell
//      (bash/sh/zsh/dash) and its second token is a readable file, that
//      file's content is scanned the same way, one level deep.
//
// Escape hatch: prefix the command with CMUX_LAUNCH_UNSAFE_OK=1 for a
// deliberate attended launch where permission prompts are WANTED (e.g.
// testing permission-prompt behavior). This is a conscious, spelled-out act
// naming the exact hazard — unlike the incident, which was an omission
// (the launching session never thought about permission mode at all) — so it
// does not reopen the "thoughtless" failure mode this guard exists to close.
// Mirrors the CMUX_CLOSE_OK=1 pattern in ~/.claude/hooks/cmux-destructive-guard.sh.
//
// Pure function — no fs access except through the injectable `readFile` used
// for the one-level wrapper-file recursion (defaults to a real, bounded,
// try/catch-wrapped fs read so callers never need to handle exceptions).
// Tested by tests/unit/cmux-launch-guard.test.mjs (CLAUDE.md rule 15).

'use strict';

const BYPASS_TOKEN = 'CMUX_LAUNCH_UNSAFE_OK=1';
const SAFE_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const MAX_WRAPPER_READ_BYTES = 16 * 1024;
const MAX_WRAPPER_DEPTH = 2;

const CANONICAL_HINT =
  'scripts/bsc-next.js:1007 (interactive --exec) and scripts/lib/cmux-launch.js:491 (cmux tab) ' +
  'already build this command correctly with the flag included — use `node scripts/bsc-next.js --id <task>` ' +
  'instead of hand-rolling a cmux new-workspace call.';

function extractFlagValue(cmd, flag) {
  const re = new RegExp(`${flag}(?:=|\\s+)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\\S+)`);
  const m = cmd.match(re);
  if (!m) return null;
  let val = m[1];
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  return val;
}

// Splits a shell command string into top-level statement segments on
// ; / && / || / | / newline. Not a real shell parser (doesn't track nested
// quotes across separators) — good enough for the narrow claude-invocation
// scan below, which only needs each segment's leading tokens.
function splitSegments(str) {
  return str.split(/&&|\|\||[;\n|]/);
}

function stripEnvPrefix(segment) {
  let rest = segment.trim();
  const envRe = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;
  while (envRe.test(rest)) rest = rest.replace(envRe, '');
  return rest;
}

function segmentTokens(segment) {
  const rest = stripEnvPrefix(segment);
  return rest.split(/\s+/).filter(Boolean);
}

function firstTokenBasename(segment) {
  const tokens = segmentTokens(segment);
  const tok = tokens[0];
  if (!tok) return null;
  const parts = tok.split('/');
  return parts[parts.length - 1] || null;
}

function defaultReadFile(filePath) {
  try {
    const fs = require('fs');
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_WRAPPER_READ_BYTES) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

// Returns the offending segment text if `str` contains an interactive-shaped
// `claude` invocation (bin === "claude", has --model) missing
// --dangerously-skip-permissions; null otherwise. Recurses one level into
// bash/sh/zsh/dash <file> wrapper indirection.
function findUnsafeClaudeInvocation(str, depth, readFile) {
  if (depth > MAX_WRAPPER_DEPTH) return null;
  const segments = splitSegments(str);
  for (const seg of segments) {
    const bin = firstTokenBasename(seg);
    if (!bin) continue;
    if (bin === 'claude') {
      const tokens = segmentTokens(seg);
      const hasModelFlag = tokens.includes('--model');
      const hasBypassFlag = tokens.includes('--dangerously-skip-permissions');
      if (hasModelFlag && !hasBypassFlag) return seg.trim();
      continue;
    }
    if (SAFE_SHELLS.has(bin) && readFile) {
      const tokens = segmentTokens(seg);
      const fileArg = tokens.slice(1).find((t) => !t.startsWith('-'));
      if (fileArg) {
        const content = readFile(fileArg);
        if (content) {
          const nested = findUnsafeClaudeInvocation(content, depth + 1, readFile);
          if (nested) return nested;
        }
      }
    }
  }
  return null;
}

/**
 * @param {string} bashCommand - the raw Bash tool_input.command string.
 * @param {{readFile?: (path: string) => (string|null)}} [opts]
 * @returns {{block: boolean, reason: string|null, bypassed?: boolean}}
 */
function evaluateCmuxLaunch(bashCommand, opts = {}) {
  const cmd = bashCommand || '';
  if (cmd.includes(BYPASS_TOKEN)) return { block: false, reason: null, bypassed: true };
  if (!/(^|[^a-z0-9-])new-workspace([^a-z0-9-]|$)/i.test(cmd)) return { block: false, reason: null };

  const commandValue = extractFlagValue(cmd, '--command');
  if (commandValue == null) return { block: false, reason: null };

  const readFile = 'readFile' in opts ? opts.readFile : defaultReadFile;
  const unsafe = findUnsafeClaudeInvocation(commandValue, 0, readFile);
  if (!unsafe) return { block: false, reason: null };

  return {
    block: true,
    reason:
      `cmux new-workspace launches "claude" (with --model) without --dangerously-skip-permissions: \`${unsafe}\`. ` +
      `Every other session in the fleet runs bypass (peers arrive tagged from-mode="bypass"); without it the ` +
      `launched session stalls on a permission prompt every few tool calls and inbound cross-session messages ` +
      `queued to it EXPIRE UNDELIVERED (2 lost in one hour, 2026-08-12). ` +
      `Use the canonical launcher instead: ${CANONICAL_HINT} ` +
      `Deliberately want an attended launch WITH permission prompts (e.g. testing permission-prompt behavior)? ` +
      `Prefix the command with ${BYPASS_TOKEN}.`,
  };
}

module.exports = {
  evaluateCmuxLaunch,
  BYPASS_TOKEN,
  extractFlagValue,
  splitSegments,
  segmentTokens,
  firstTokenBasename,
  findUnsafeClaudeInvocation,
};

if (require.main === module) {
  let input = process.argv[2];
  if (input === undefined) {
    input = require('fs').readFileSync(0, 'utf8');
  }
  const result = evaluateCmuxLaunch(input);
  if (result.block) {
    process.stderr.write(result.reason + '\n');
    process.exit(2);
  }
  if (result.bypassed) {
    process.stderr.write(`[cmux-launch-guard] ${BYPASS_TOKEN} present — skipping check.\n`);
  }
  process.exit(0);
}
