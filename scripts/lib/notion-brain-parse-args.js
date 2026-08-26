/**
 * notion-brain-parse-args.js — argv parsing for notion-brain.js's CLI.
 *
 * Extracted so it can be require()'d directly in tests (CLAUDE.md §15).
 * notion-brain.js exits at require-time without NOTION_API_KEY (see its
 * top-of-file comment), so nothing could require() it to test this in
 * isolation — this file has no such dependency.
 */
'use strict';

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
      // Check `!== undefined` rather than truthiness — an explicit empty
      // string (--flag '') is a real value the caller passed and must be
      // consumed here, or it falls through to be misparsed as a stray
      // positional on the next loop iteration (BRO-344).
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
