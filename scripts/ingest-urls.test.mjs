// Guards the review-texts PUSH path in scripts/ingest-urls.js.
//
// BRO-5874 (2026-10-22): the push step hardcoded
// path.join(__dirname, '..', 'data', 'review-texts') as the git checkout. That
// holds on CI and in most worktrees, but on the owner's Mac data/review-texts
// is a plain gitignored COPY and the clone lives at ~/broadway-review-texts, so
// `git add` ran inside the Broadwayscore repo where the path is gitignored.
// Every Mac-local ingest then failed its push with "paths are ignored by one of
// your .gitignore files" — and because landIngestedReviews() skips the dispatch
// when the push fails, seven recovered Bachtrack reviews sat local-only and
// unscored with no louder signal than one warning line.
//
// scripts/lib/review-texts-dir.js::resolveReviewTextsDir() is the canonical
// resolver and already handles this shape. This test fails if the push dir ever
// goes back to a hardcoded join.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, 'ingest-urls.js');
const src = fs.readFileSync(SRC, 'utf8');

test('ingest-urls imports the canonical review-texts resolver', () => {
  assert.match(
    src,
    /require\(['"]\.\/lib\/review-texts-dir['"]\)/,
    'ingest-urls.js must require scripts/lib/review-texts-dir (resolveReviewTextsDir)',
  );
});

test('the push dir comes from resolveReviewTextsDir(), not a hardcoded join', () => {
  const m = src.match(/const\s+reviewTextsDir\s*=\s*([^;\n]+)/);
  assert.ok(m, 'expected a `const reviewTextsDir = ...` assignment feeding pushReviewTexts');
  assert.match(
    m[1],
    /resolveReviewTextsDir\(\)/,
    `push dir must be resolveReviewTextsDir(); found: ${m[1].trim()}`,
  );
  assert.doesNotMatch(
    m[1],
    /path\.join\(/,
    'push dir must not be a hardcoded path.join — that is the BRO-5874 regression',
  );
});

test('touched files are mirrored into the checkout when it differs from the write dir', () => {
  // The files are written under data/review-texts; when the checkout is
  // elsewhere they must be copied there before staging, or the push stages
  // nothing and CI never sees them.
  assert.match(
    src,
    /path\.resolve\(reviewTextsDir\)\s*!==\s*path\.resolve\(writeDir\)/,
    'expected an explicit writeDir-vs-checkout comparison before pushing',
  );
  assert.match(src, /copyFileSync/, 'expected touched files to be copied into the checkout');
});

test('a failed push still warns that CI will not see the files', () => {
  assert.match(src, /will not see the new files/, 'the failed-push warning must stay');
});
