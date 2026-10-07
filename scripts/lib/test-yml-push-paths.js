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
  // A leading '!' is GitHub's NEGATION marker, not part of the path — strip it
  // here and let isCovered() apply the negation. See isCovered's note.
  const body = entry.startsWith('!') ? entry.slice(1) : entry;
  // '?' MUST be escaped: unescaped, 'foo?.js' compiles to the quantifier
  // /^foo?\.js$/ (which matches 'fo.js'), and a leading '?' throws
  // "Nothing to repeat". Found in pre-merge review — latent today, but this
  // parser now backs a BLOCKING gate, so a crash or an over-match is a CI
  // outage rather than a warning.
  const escaped = body.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  // NUL as the '**' placeholder, NOT a space. A space is a legal character in a
  // path, so the old space placeholder turned any real space in an entry into
  // '.*' and silently over-matched. NUL cannot occur in a path.
  const SENTINEL = '\u0000';
  const pattern = escaped
    .split('**').join(SENTINEL)
    .split('*').join('[^/]*')
    .split(SENTINEL).join('.*');
  return new RegExp(`^${pattern}$`);
}

/**
 * Would a push touching only `repoRel` be matched by the allow-list?
 *
 * GitHub evaluates `paths` in order and LAST MATCH WINS, so a later `!foo/**`
 * exclusion can take back coverage an earlier positive entry granted. Treating a
 * `!` entry as a positive literal (the pre-review behaviour) reported a file as
 * reachable when the filter actually excludes it — a false GREEN on a blocking
 * gate. There are no negation entries in test.yml today; this keeps it correct
 * if one is ever added.
 */
function isCovered(repoRel, pathEntries) {
  const posixRel = repoRel.split(path.sep).join('/');
  let covered = false;
  for (const entry of pathEntries) {
    if (globToRegExp(entry).test(posixRel)) covered = !entry.startsWith('!');
  }
  return covered;
}

/** Convenience: read the allow-list straight off disk. */
function readPushPathsFrom(workflowPath) {
  return readPushPaths(fs.readFileSync(workflowPath, 'utf8'));
}

module.exports = { readPushPaths, readPushPathsFrom, globToRegExp, isCovered, PATH_ENTRY_RE };
