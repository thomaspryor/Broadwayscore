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

/**
 * Split a conflicted file into its two whole-file readings: every conflict
 * block resolved to the "ours" side, and every block resolved to "theirs"
 * (diff3 `|||||||` base sections are dropped). Lets a READER keep a record
 * whose file a bad rebase committed with markers, instead of dropping the
 * review from the site until someone hand-fixes it (deep-heat-rivalry
 * thestage--unknown.json, 2026-09-25: both sides were valid JSON and differed
 * only in retry metadata). Never used to rewrite the file.
 *
 * @param {string} text
 * @returns {{ours: string, theirs: string} | null} null when the text has no
 *   markers or the blocks are malformed (unclosed / out of order)
 */
function conflictSides(text) {
  if (!hasConflictMarkers(text)) return null;
  const ours = [];
  const theirs = [];
  let state = 'both'; // both | ours | base | theirs
  for (const line of text.split('\n')) {
    if (/^<{7}(?:\s|$)/.test(line)) {
      if (state !== 'both') return null;
      state = 'ours';
    } else if (/^\|{7}(?:\s|$)/.test(line) && state === 'ours') {
      state = 'base';
    } else if (/^={7}$/.test(line) && (state === 'ours' || state === 'base')) {
      state = 'theirs';
    } else if (/^>{7}(?:\s|$)/.test(line)) {
      if (state !== 'theirs') return null;
      state = 'both';
    } else if (state === 'both') {
      ours.push(line); theirs.push(line);
    } else if (state === 'ours') {
      ours.push(line);
    } else if (state === 'theirs') {
      theirs.push(line);
    }
  }
  if (state !== 'both') return null;
  return { ours: ours.join('\n'), theirs: theirs.join('\n') };
}

/**
 * Best-effort parse of a conflict-marked JSON file: the "ours" reading if it
 * parses, else "theirs". Returns null when neither side is valid JSON.
 * @param {string} text
 * @returns {{data: object, side: 'ours'|'theirs'} | null}
 */
function parseConflictedJson(text) {
  const sides = conflictSides(text);
  if (!sides) return null;
  for (const side of ['ours', 'theirs']) {
    try { return { data: JSON.parse(sides[side]), side }; } catch { /* try next */ }
  }
  return null;
}

// Keys that are fetch/retry bookkeeping, never editorial truth. Two sides that
// differ ONLY in these describe the same review.
const OPERATIONAL_KEY_RE = /retry|recovery|attempt|fetch|incompleteDetail|checkedAt|lastChecked/i;

/**
 * Conflict-marked REVIEW record the rebuild may safely publish: both sides
 * must parse and agree on every non-operational field (score, flags, url,
 * critic, human overrides). Otherwise null, and the rebuild skips the file as
 * before: picking a side by git order could resurrect a rejected review or
 * publish the wrong score (Codex ship-check 2026-09-25).
 * @param {string} text
 * @returns {{data: object, side: 'ours'} | null}
 */
function parseAgreeingConflictedReview(text) {
  const sides = conflictSides(text);
  if (!sides) return null;
  let ours; let theirs;
  try { ours = JSON.parse(sides.ours); theirs = JSON.parse(sides.theirs); } catch { return null; }
  if (!ours || !theirs || typeof ours !== 'object' || typeof theirs !== 'object') return null;
  for (const k of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    if (OPERATIONAL_KEY_RE.test(k)) continue;
    if (JSON.stringify(ours[k]) !== JSON.stringify(theirs[k])) return null;
  }
  return { data: ours, side: 'ours' };
}

module.exports = { findConflictMarkers, hasConflictMarkers, conflictSides, parseConflictedJson, parseAgreeingConflictedReview, CONFLICT_MARKER_RE };

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
