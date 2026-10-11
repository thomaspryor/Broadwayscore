/**
 * Shared --help/-h detection for bsc-* CLI entry points.
 *
 * 2026-07-14 incident: `node scripts/bsc-conductor.js --help` ran a full
 * orientation sweep + opened a real session instead of printing usage, and
 * `cmux restore-session --help` executed a real restore that killed live
 * sessions. Every bsc-* entry point must check this BEFORE any side effect
 * (LLM call, cmux dispatch, workspace launch) — checked against raw argv, not
 * the parsed flag object, so it works even for scripts whose parseArgs would
 * otherwise swallow a bare `-h` into the positional list.
 */
function hasHelpFlag(argv) {
  // '--help=1'-style tokens (ship-check finding, task #260): a parser that
  // splits on '=' would still treat this as help, so the raw-argv check must
  // match the prefix too, not just the exact '--help' token.
  return argv.some(a => a === '--help' || a === '-h' || a.startsWith('--help='));
}

/**
 * Print the calling script's leading doc comment and exit 0 when it was run
 * directly with --help/-h. Call as the first statement of a CLI script, before
 * any read, write or network call: `require('./lib/cli-help').exitOnHelp(module);`
 * A no-op when the script is require()d (tests, other scripts).
 */
function exitOnHelp(mod, argv = process.argv.slice(2)) {
  if (require.main !== mod || !hasHelpFlag(argv)) return;
  const fs = require('fs');
  const path = require('path');
  let usage = '';
  try {
    const m = fs.readFileSync(mod.filename, 'utf8').match(/\/\*\*?([\s\S]*?)\*\//);
    if (m) usage = m[1].split('\n').map((l) => l.replace(/^\s*\* ?/, '')).join('\n').trim();
  } catch { /* fall through to the bare usage line */ }
  console.log(usage || `Usage: node scripts/${path.basename(mod.filename)}`);
  process.exit(0);
}

module.exports = { hasHelpFlag, exitOnHelp };
