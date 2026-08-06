#!/usr/bin/env node

/**
 * Task #1075 — mechanical scanner for the "verification that cannot observe
 * its subject" class.
 *
 * The catchable, zero-guesswork instance: source that reads a LITERAL path out
 * of a git ref (`git show <ref>:<path>`, `git cat-file -e <ref>:<path>`) where
 * that path is gitignored in this repo. Core data (data/shows.json,
 * data/reviews.json, data/review-texts/) lives in a private repo and is never
 * committed here, so such a read ALWAYS fails — and every caller so far
 * swallowed the failure and let "found nothing" mean "clean" (2026-08-05
 * ticket-link watcher).
 *
 * Deliberately narrow: literal paths only, no heuristics about loop shapes or
 * catch blocks. Same design choice as gate-corpus-guard-coverage.js (#1069) —
 * a mechanical grep can be blocking; a guess cannot.
 *
 * Pure by construction (CLAUDE.md §15): no fs, no child_process. The caller
 * supplies file sources and an isIgnored() predicate.
 */

'use strict';

// `git show <ref>:<path>` / `git cat-file -e <ref>:<path>`, ref and path both
// literal. Anything with a shell/JS interpolation marker ($ or `) in the path
// is skipped by isLiteralPath below — we can't know what it resolves to.
const GIT_REF_READ = /\bgit\s+(?:show|cat-file\s+-e)\s+(?:--?\S+\s+)*([A-Za-z0-9_./^~{}@$-]+):([A-Za-z0-9_./$-]+)/g;

const EXEMPT_MARKER = /observability-ok:/;

// A comment describing the pattern (this file's own header, an incident note)
// is not a read. Only whole-line comments are skipped — a trailing `// why`
// after real code still counts.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#)/;

function isLiteralPath(p) {
  return !!p && !p.includes('$') && !p.includes('`') && !p.includes('{');
}

/**
 * Extract literal `<ref>:<path>` git reads from one file's source.
 * @returns {Array<{line:number, ref:string, filePath:string, raw:string}>}
 */
function findGitRefReads(source) {
  const out = [];
  if (!source) return out;
  const lines = String(source).split('\n');
  lines.forEach((text, i) => {
    // Marker may sit on the line itself or the line directly above it
    // (eslint-disable-next-line ergonomics — these calls are long).
    if (EXEMPT_MARKER.test(text)) return;
    if (i > 0 && EXEMPT_MARKER.test(lines[i - 1])) return;
    if (COMMENT_LINE.test(text)) return;
    GIT_REF_READ.lastIndex = 0;
    let m;
    while ((m = GIT_REF_READ.exec(text)) !== null) {
      const [raw, ref, filePath] = m;
      if (!isLiteralPath(filePath)) continue;
      // `git show :path` (staged blob) and `git show <sha>:path` are fine
      // shapes; the ref side may interpolate — only the path must be literal.
      out.push({ line: i + 1, ref, filePath, raw: text.trim() });
    }
  });
  return out;
}

/**
 * Flag every literal git-ref read of a path that is gitignored in the repo
 * doing the reading — a read that can only ever fail.
 *
 * @param {object} opts
 * @param {Array<{path:string, source:string}>} opts.files
 * @param {(path:string)=>boolean} opts.isIgnored
 * @returns {{violations:Array, scanned:number, readsFound:number}}
 */
function findInvisibleVerifications({ files = [], isIgnored } = {}) {
  if (typeof isIgnored !== 'function') {
    throw new TypeError('findInvisibleVerifications requires an isIgnored(path) predicate');
  }
  const violations = [];
  let readsFound = 0;
  for (const file of files) {
    for (const read of findGitRefReads(file.source)) {
      readsFound++;
      if (!isIgnored(read.filePath)) continue;
      violations.push({ file: file.path, ...read });
    }
  }
  return { violations, scanned: files.length, readsFound };
}

module.exports = { findGitRefReads, findInvisibleVerifications, isLiteralPath };
