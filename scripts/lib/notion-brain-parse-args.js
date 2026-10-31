/**
 * notion-brain-parse-args.js — CLI flag parser for notion-brain.js.
 *
 * Extracted (BRO-344) so it's unit-testable without NOTION_API_KEY —
 * notion-brain.js exits at require-time without it (CLAUDE.md §15).
 *
 * Bug fixed here: the next-token check used a truthy test (`if (next && ...)`),
 * so an explicit empty-string value passed space-separated (`--outcome ''`)
 * was treated as "no value" — the flag became boolean `true` and the empty
 * string leaked into `_positional` instead of being consumed. `--flag=`
 * (equals form) was never affected, only the space-separated form.
 */

// Same semantics as the Linear CLIs' shared parser; only the positional key
// differs. One implementation (BRO-2628).
const { parseArgs: parseCliArgs } = require('./cli-args.js');

function parseArgs(argv) {
  return parseCliArgs(argv, { positionalKey: '_positional' });
}

module.exports = { parseArgs };
