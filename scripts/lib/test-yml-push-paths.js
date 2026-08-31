#!/usr/bin/env node
/**
 * The push-path allow-list reader shared by every audit that asks "would a solo
 * push touching only this file trigger CI at all?"
 *
 * Extracted from scripts/audit-test-yml-lib-deps.js (task #1745), which had the
 * only correct copy of this parsing. A second audit needed it
 * (scripts/audit-test-yml-manifest-paths.js), and a second COPY of a rule is
 * exactly how CLAUDE.md §15's most expensive mistake happens: fix one, and the
 * other silently keeps the old behaviour. One definition, two callers.
 *
 * The list is read with an indentation-aware line scan of `on.push.paths`, NOT
 * a substring search of the whole file — a substring search false-negatives the
 * moment any comment anywhere in test.yml happens to mention a filename, and
 * test.yml is ~90% explanatory comments naming exactly these paths.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PATH_ENTRY_RE = /^\s*-\s*'([^']+)'/;

/**
 * Extract the literal `- '...'` entries under `on.push.paths:` only. Comments
 * and blank lines are skipped; the first other non-entry line ends the list, so
 * nothing from a later block (jobs, other triggers) can leak in.
 */
function readPushPaths(yml) {
  const lines = yml.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === 'paths:');
  if (startIdx === -1) throw new Error("could not find 'paths:' in test.yml");
  const entries = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const m = line.match(PATH_ENTRY_RE);
    if (m) { entries.push(m[1]); continue; }
    break;
  }
  return entries;
}

/**
 * Convert a GitHub Actions push-path glob entry to a RegExp. `**` matches across
 * path segments (including none); a bare `*` matches within one segment only —
 * the semantics `next.config.*` and `tsconfig.*` in the real allow-list rely on,
 * not just the `dir/**` entries.
 */
function globToRegExp(entry) {
  const escaped = entry.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '.*');
  return new RegExp(`^${pattern}$`);
}

/** Would a push touching only `repoRel` match any entry in the allow-list? */
function isCovered(repoRel, pathEntries) {
  const posixRel = repoRel.split(path.sep).join('/');
  return pathEntries.some((entry) => globToRegExp(entry).test(posixRel));
}

/** Convenience: read the allow-list straight off disk. */
function readPushPathsFrom(workflowPath) {
  return readPushPaths(fs.readFileSync(workflowPath, 'utf8'));
}

module.exports = { readPushPaths, readPushPathsFrom, globToRegExp, isCovered, PATH_ENTRY_RE };
