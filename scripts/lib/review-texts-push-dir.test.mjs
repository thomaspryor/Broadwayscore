// Class guard for the review-texts dir the ingest scripts read, write and push
// (BRO-5874, 2026-10-22).
//
// data/review-texts IS the review-texts git checkout on CI and in most
// worktrees, but on the owner's Mac it is a plain gitignored COPY and the clone
// lives at ~/broadway-review-texts. Two scripts hardcoded
// path.join(__dirname, '..', 'data', 'review-texts'), so `git add` ran inside
// the Broadwayscore repo where that path is gitignored. Every Mac-local ingest
// then failed its push with "paths are ignored by one of your .gitignore files"
// — and because landIngestedReviews() skips the dispatch when the push fails,
// the recovered reviews sat local-only and unscored behind one warning line.
//
// resolveReviewTextsDir() (scripts/lib/review-texts-dir.js) is the canonical
// resolver: it returns data/review-texts when that IS a checkout, so on CI
// nothing changes. Rather than guard the two known offenders by name, this test
// enumerates every caller of the push helpers and requires each one to reach
// the resolver, so a THIRD caller added later cannot reintroduce the bug by
// copying the old shape.
//
// It also locks the reason the first attempt at this fix was wrong: writing to
// the copy and mirroring the files across into the checkout would copy a stale
// snapshot over fresher content (1002 of 1857 sampled shared files differ, in
// llmScore, assignedScore, fullText, wrongProduction, duplicateOf and
// humanReviewScore) and resurrect upstream-deleted reviews. The write dir and
// the push dir must be the SAME resolved dir, so there is nothing to mirror.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The helpers that run git against the review-texts dir.
// land-ingested-reviews.js is where they are DEFINED, so it is not itself a
// caller; a *.test.mjs exercises them with injected dirs and is not one either.
const PUSH_HELPERS = /\b(pushReviewTexts|landIngestedReviews)\s*[(:]/;
// A caller that renames the helper on import (`const { pushReviewTexts: publish }`)
// matches neither form above, so importing the module at all counts as calling it.
const PUSH_IMPORT = /(?:require\(|from\s*)['"][^'"]*land-ingested-reviews(?:\.js)?['"]/;
const DEFINITION_FILE = 'lib/land-ingested-reviews.js';
const SOURCE_EXT = /\.(js|mjs|cjs)$/;

// Comments in these files NAME the resolver (that is how the bug is
// documented), so matching raw source would pass on a file that only talks
// about it. Strip comments first and assert against code. Only treat `/*` as a
// block comment when it opens a line or follows whitespace, so a string
// literal such as 'data/*' does not swallow the rest of the file.
function stripComments(src) {
  return src
    .replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

function callers() {
  const found = [];
  const walk = (dir, rel = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(abs, relPath);
        continue;
      }
      if (!SOURCE_EXT.test(entry.name)) continue;
      if (entry.name.includes('.test.')) continue;
      if (relPath === DEFINITION_FILE) continue;
      const code = stripComments(fs.readFileSync(abs, 'utf8'));
      if (PUSH_HELPERS.test(code) || PUSH_IMPORT.test(code)) found.push({ relPath, code });
    }
  };
  walk(SCRIPTS);
  return found;
}

test('the push helpers have at least the two known callers (the walk is not silently empty)', () => {
  const found = callers().map((c) => c.relPath);
  for (const expected of ['ingest-urls.js', 'ingest-review-from-url.js']) {
    assert.ok(
      found.includes(expected),
      `expected ${expected} among the push-helper callers; found: ${found.join(', ') || '(none)'}`,
    );
  }
});

test('every push-helper caller resolves its review-texts dir with resolveReviewTextsDir()', () => {
  for (const { relPath, code } of callers()) {
    assert.match(
      code,
      /resolveReviewTextsDir\s*\(\s*\)/,
      `${relPath} calls pushReviewTexts/landIngestedReviews but never calls resolveReviewTextsDir() — `
      + 'the dir git runs in must be the review-texts CHECKOUT, not a copy of it. '
      + 'See scripts/lib/review-texts-dir.js (BRO-5874).',
    );
  }
});

test('no push-helper caller hardcodes a data/review-texts path', () => {
  // The whole bug was a hardcoded join standing in for the checkout. Allow it
  // nowhere in these files: the resolver returns exactly this path when it is
  // the checkout, so there is never a reason to write it out.
  // Matching only the exact join shape that caused BRO-5874 let the same path
  // back in as path.resolve(...), path.join(process.cwd(), ...) and a template
  // literal. Ban the PATH, in either of the two ways it can be written: as
  // adjacent join/resolve arguments, or as a literal containing data/review-texts.
  const bad = [
    /['"`]data['"`]\s*,\s*['"`]review-texts['"`]/,
    /['"`][^'"`\n]*data\/review-texts/,
  ];
  for (const { relPath, code } of callers()) {
    for (const re of bad) {
      assert.doesNotMatch(
        code,
        re,
        `${relPath} builds a data/review-texts path by hand (${re}) — `
        + 'use resolveReviewTextsDir(); that hardcoded path is the BRO-5874 regression',
      );
    }
  }
});

test('the write dir and the dir handed to the push helper are the same variable', () => {
  // Writing to one dir and pushing from another means copying files between
  // them, and the copy direction that fixes the push (stale copy -> fresh
  // checkout) rolls back scores and flags and resurrects deleted reviews.
  // Keeping one resolved dir for both removes the hazard entirely, so no
  // caller may grow a second dir or a mirror step.
  for (const { relPath, code } of callers()) {
    assert.doesNotMatch(
      code,
      /\b(mirrorIntoCheckout|pushDir|writeDir)\b/,
      `${relPath} has a separate push/write dir or a mirror step — read, write and push `
      + 'the one dir resolveReviewTextsDir() returns (BRO-5874)',
    );
    assert.doesNotMatch(
      code,
      /copyFileSync/,
      `${relPath} copies review-text files between dirs; it must write straight into the checkout (BRO-5874)`,
    );
    // BRO-5936: banning NAMES let a second root in under a fourth one
    // (`fanDir`, from BRO-5895's multi-show fan-out). Ban the value: every
    // reviewTextsDir option a caller passes must be the resolved variable
    // itself, shorthand `{ reviewTextsDir }` or `reviewTextsDir: reviewTextsDir`.
    // Matching an IDENTIFIER after the colon let every non-identifier shape
    // through — `(path.resolve(...))`, a template literal, `process.env.X`, a
    // call — and parentheses hid plain aliases too. Capture the whole value and
    // require it to be the resolved variable itself.
    const aliased = [...code.matchAll(/reviewTextsDir\s*:\s*([^,}\n]+)/g)]
      .map((m) => m[1].trim().replace(/^\(+|\)+$/g, '').trim())
      .filter((value) => value !== 'reviewTextsDir');
    assert.deepEqual(
      aliased,
      [],
      `${relPath} passes a reviewTextsDir option that is not the resolved variable `
      + `(${aliased.join(', ')}) — a second root is how BRO-5936 happened; pass `
      + 'the one dir resolveReviewTextsDir() returned',
    );
    // Setting the option after the fact dodges every check above.
    assert.doesNotMatch(
      code,
      /\.reviewTextsDir\s*=[^=]/,
      `${relPath} assigns a reviewTextsDir option after building it — pass the dir `
      + 'resolveReviewTextsDir() returned at the call site (BRO-5936)',
    );
  }
});

test('both callers keep the unknown-show guard alive off the default dir', () => {
  // unknownShowFolderRefused() (review-file-writer.js:299) stands its guard
  // down for any reviewTextsDir that is not the hardcoded default, so a caller
  // that moved off that default must pass knownShowIds or it silently allows a
  // review folder for a show id that is not in shows.json.
  for (const { relPath, code } of callers()) {
    if (!/createOrMergeReviewFile\s*\(/.test(code)) continue;
    assert.match(
      code,
      /knownShowIds/,
      `${relPath} passes a non-default reviewTextsDir to createOrMergeReviewFile without knownShowIds, `
      + 'which silently disables the unknown-show-folder guard (review-file-writer.js:299)',
    );
  }
});
