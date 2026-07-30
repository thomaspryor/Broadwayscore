#!/usr/bin/env node
/**
 * check-validation-setdiff.js — compares two validate-data.js output
 * captures and reports whether the second run introduced any NEW error over
 * the first. Used by update-show-status.yml's discovery commit gate (task
 * #649) so a pre-existing, unrelated validation error stops discarding
 * discovery's good work.
 *
 * Usage:
 *   node scripts/check-validation-setdiff.js --pre=<file> --post=<file>
 *   node scripts/check-validation-setdiff.js --help, -h    print this usage and exit
 *
 * Emits GITHUB_OUTPUT-format lines to stdout:
 *   should_commit=true|false
 *   new_error_count=<N>
 *   pre_error_count=<N>
 *   post_error_count=<N>
 *   new_errors_preview=<first few new errors, pipe-separated, truncated>
 */

const fs = require('fs');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { parseErrorLines, evaluateCommitDecision } = require('./lib/validation-setdiff');

const USAGE = `check-validation-setdiff.js — set-diff two validate-data.js output captures.

Usage:
  node scripts/check-validation-setdiff.js --pre=<file> --post=<file> [--post-exit-code=<N>]
  node scripts/check-validation-setdiff.js --help, -h    print this usage and exit

--post-exit-code is optional but recommended: without it, a validate-data.js
crash/format-change that prints no "❌ ERROR:" lines reads as should_commit=true.
With it, a non-zero post exit code paired with zero parsed error lines blocks
the commit instead of silently passing (task #649 crash-safety net).
`;

if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

function argValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

const preFile = argValue('pre');
const postFile = argValue('post');
if (!preFile || !postFile) {
  console.error(USAGE);
  process.exit(1);
}
const postExitCodeArg = argValue('post-exit-code');
const postExitCode = postExitCodeArg !== null && postExitCodeArg !== '' ? Number(postExitCodeArg) : undefined;

const readSafe = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const preErrors = parseErrorLines(readSafe(preFile));
const postErrors = parseErrorLines(readSafe(postFile));
const { shouldCommit, newErrors, reason } = evaluateCommitDecision({ preErrors, postErrors, postExitCode });

console.log(`should_commit=${shouldCommit}`);
console.log(`new_error_count=${newErrors.length}`);
console.log(`pre_error_count=${preErrors.length}`);
console.log(`post_error_count=${postErrors.length}`);
console.log(`decision_reason=${reason}`);
// Single-line, truncated preview — GITHUB_OUTPUT needs a heredoc delimiter
// for real multiline values, which isn't worth the ceremony for a preview.
const preview = newErrors.slice(0, 5).join(' | ').slice(0, 500);
console.log(`new_errors_preview=${preview}`);
