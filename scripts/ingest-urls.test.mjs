// Guards the review-texts dir scripts/ingest-urls.js reads, writes and pushes.
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
// resolver; it returns data/review-texts when that IS the checkout, so CI
// behaviour is unchanged. The cross-caller version of these checks lives in
// scripts/lib/review-texts-push-dir.test.mjs.
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

test('the review-texts dir comes from resolveReviewTextsDir(), not a hardcoded join', () => {
  const m = src.match(/const\s+reviewTextsDir\s*=\s*([^;\n]+)/);
  assert.ok(m, 'expected a `const reviewTextsDir = ...` assignment');
  assert.match(
    m[1],
    /resolveReviewTextsDir\(\)/,
    `review-texts dir must be resolveReviewTextsDir(); found: ${m[1].trim()}`,
  );
  assert.doesNotMatch(
    m[1],
    /path\.join\(/,
    'the dir must not be a hardcoded path.join — that is the BRO-5874 regression',
  );
});

test('the writer and the pre-existing-file lookup use that same resolved dir', () => {
  // Writing to one dir and pushing from another means copying files between
  // them, and the copy direction that fixes the push (stale copy -> fresh
  // checkout) rolls back llmScore/assignedScore/wrongProduction and
  // resurrects upstream-deleted reviews. One resolved dir for read, write and
  // push removes the hazard, so nothing here may reintroduce a second dir.
  assert.match(
    src,
    /createOrMergeReviewFile\(showId,\s*input,\s*\{[\s\S]{0,160}?reviewTextsDir/,
    'createOrMergeReviewFile must be given the resolved reviewTextsDir',
  );
  assert.match(
    src,
    /findExistingReviewFile\(path\.join\(reviewTextsDir,/,
    'the pre-existing-file lookup must read the same resolved dir the writer writes to',
  );
  assert.match(
    src,
    /pushReviewTexts\(\{\s*\n?\s*reviewTextsDir,/,
    'pushReviewTexts must be handed that same dir',
  );
  assert.doesNotMatch(
    src,
    /copyFileSync|mirrorIntoCheckout/,
    'review-text files must be written straight into the checkout, never copied between dirs',
  );
});

test('the non-default dir keeps the unknown-show guard alive', () => {
  // unknownShowFolderRefused() (review-file-writer.js:299) stands its guard
  // down for any reviewTextsDir that is not the writer's hardcoded default, so
  // moving off that default without passing knownShowIds would silently allow
  // a review folder for a show id that is not in shows.json.
  assert.match(
    src,
    /knownShowIds:\s*showsData\.shows\.map/,
    'createOrMergeReviewFile must get knownShowIds from shows.json',
  );
});

test('a failed push still warns that CI will not see the files', () => {
  assert.match(src, /will not see the new files/, 'the failed-push warning must stay');
});
