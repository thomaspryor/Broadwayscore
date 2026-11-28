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

// Every blob-reading form of `<ref>:<path>`:
//   git show <ref>:<path>            git -C dir show <ref>:<path>
//   git cat-file -e <ref>:<path>     git cat-file -p <ref>:<path>
//   git cat-file blob <ref>:<path>
// Global options (-C dir, -c k=v, --git-dir=…) may precede the subcommand —
// the original pattern required the subcommand to follow `git` directly, so
// `git -C dir show …` slipped through (adversarial review, 2026-08-06).
const GIT_REF_READ =
  /\bgit\s+(?:(?:-C|-c)\s+\S+\s+|--\S+(?:=\S+)?\s+)*(?:show|cat-file\s+(?:-e|-p|blob)\b)\s+(?:--?[A-Za-z][\w-]*(?:=\S+)?\s+)*([A-Za-z0-9_./^~{}@$-]*):([A-Za-z0-9_./${}-]+)/g;

const EXEMPT_MARKER = /observability-ok:/;

// A comment describing the pattern (this file's own header, an incident note)
// is not a read. Only whole-line comments are skipped — a trailing `// why`
// after real code still counts.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#)/;

const INTERPOLATION = /[$`{]/;

function isLiteralPath(p) {
  return !!p && !INTERPOLATION.test(p);
}

/**
 * The part of a path we can actually reason about.
 *
 * A fully literal path probes itself. An interpolated one
 * (`data/review-texts/${id}.json`) still carries a literal DIRECTORY prefix,
 * and if that directory is gitignored every value the interpolation can take
 * is unreadable too — so probe the prefix rather than give up, which is what
 * the first cut did (adversarial review: `git show ${ref}:data/${name}.json`
 * sailed straight past the gate).
 *
 * Returns null when there is no literal directory prefix to judge.
 */
function probeTargetFor(filePath) {
  if (isLiteralPath(filePath)) return { probePath: filePath, literal: true };
  const head = filePath.split(INTERPOLATION)[0];
  const cut = head.lastIndexOf('/');
  if (cut <= 0) return null;
  return { probePath: head.slice(0, cut + 1), literal: false };
}

/**
 * Extract `<ref>:<path>` git blob reads from one file's source.
 *
 * Known blind spot, deliberate: a command assembled across multiple lines or
 * through intermediate variables is not seen — this scans line by line. The
 * gate is a floor, not a proof; the helper in observable-before-absence.js is
 * what makes an individual check honest.
 *
 * @returns {Array<{line:number, ref:string, filePath:string, probePath:string, literal:boolean, raw:string}>}
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
      const [, ref, filePath] = m;
      const target = probeTargetFor(filePath);
      if (!target) continue;
      // `git show :path` (staged blob) and `git show <sha>:path` are both fine
      // shapes; the ref side may interpolate — only the path side is judged.
      out.push({ line: i + 1, ref, filePath, ...target, raw: text.trim() });
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
      if (!isIgnored(read.probePath)) continue;
      violations.push({ file: file.path, ...read });
    }
  }
  return { violations, scanned: files.length, readsFound };
}

module.exports = { findGitRefReads, findInvisibleVerifications, isLiteralPath };
