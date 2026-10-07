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

function parseArgs(argv) {
  const args = { _positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const raw = argv[i].slice(2);
      const eq = raw.indexOf('=');
      if (eq !== -1) {
        args[raw.slice(0, eq)] = raw.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[raw] = next;
        i++;
      } else {
        args[raw] = true;
      }
    } else {
      args._positional.push(argv[i]);
    }
  }
  return args;
}

module.exports = { parseArgs };
