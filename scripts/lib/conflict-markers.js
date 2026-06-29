#!/usr/bin/env node
'use strict';

/**
 * conflict-markers.js — detect committed git merge-conflict markers.
 *
 * Root-cause guard for the corruption class that broke validate-review-texts.js:
 * a bad enrich-reviews rebase (commit 09e78a7a) committed unresolved conflict
 * markers into a review-text JSON file, making it invalid JSON. The file was then
 * silently dropped from reviews.json. push-with-retry.sh calls this to reject a
 * push whose staged/outgoing files still carry markers, BEFORE they reach main.
 *
 * Detection matches the START-OF-LINE conflict opener (`<<<<<<<`) and closer
 * (`>>>>>>>`), allowing the 7-or-more-char variants git emits for nested conflicts
 * (the corrupt file carried `<<<<<<<< HEAD:_pending/...`). The middle separator
 * (`=======`) is intentionally NOT matched on its own: a bare run of `=` at line
 * start is a legitimate Markdown setext-heading underline, so matching it would
 * false-positive on docs. Git always emits the opener+closer with the separator,
 * so checking the opener/closer is both sufficient and FP-safe.
 *
 * Usage (CLI, as called from push-with-retry.sh):
 *   node scripts/lib/conflict-markers.js <file> [<file> ...]
 *   exit 0 — no markers in any file
 *   exit 1 — markers found (prints `path:lineNo: <line>` for each, to stderr)
 *   exit 2 — usage error (no files given)
 */

const CONFLICT_MARKER_RE = /^(?:<{7,}|>{7,})/;

/**
 * @param {string} text file contents
 * @returns {{line:number, text:string}[]} marker hits (empty if clean)
 */
function findConflictMarkers(text) {
  if (typeof text !== 'string' || !text) return [];
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (CONFLICT_MARKER_RE.test(lines[i])) {
      hits.push({ line: i + 1, text: lines[i].slice(0, 120) });
    }
  }
  return hits;
}

/** @param {string} text @returns {boolean} */
function hasConflictMarkers(text) {
  return findConflictMarkers(text).length > 0;
}

module.exports = { findConflictMarkers, hasConflictMarkers, CONFLICT_MARKER_RE };

if (require.main === module) {
  const fs = require('fs');
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: node scripts/lib/conflict-markers.js <file> [<file> ...]');
    process.exit(2);
  }
  let bad = 0;
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue; // deleted/unreadable — not our concern here
    }
    const hits = findConflictMarkers(text);
    for (const h of hits) {
      console.error(`${f}:${h.line}: ${h.text}`);
      bad++;
    }
  }
  process.exit(bad > 0 ? 1 : 0);
}
