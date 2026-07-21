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
  return argv.includes('--help') || argv.includes('-h');
}

module.exports = { hasHelpFlag };
