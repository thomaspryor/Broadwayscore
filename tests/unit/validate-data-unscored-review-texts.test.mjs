// BRO-2451: validateUnscoredReviewTexts() in scripts/validate-data.js used to
// hand-maintain its own copy of rebuild-all-reviews.js's skip-flag logic,
// with a docstring dated 2026-04-11 warning "if rebuild adds a new skip flag,
// mirror it here or this validator will start surfacing files that rebuild
// correctly excludes." That mirror was already replaced by a direct call to
// the canonical isIncludableForRebuild/hasValidScore predicates in
// scripts/lib/review-guards.js on 2026-07-21 (commit d377c35faaf), but
// nothing locks that in — a future edit could reintroduce a hand-copied
// flag list without anyone noticing until false-positive gaps reappear.
//
// This test does NOT hand-copy either file's import list — it parses the
// actual `require('.../review-guards')` destructuring lines from both
// scripts/validate-data.js and scripts/rebuild-all-reviews.js (CLAUDE.md
// rule 15: require() the real thing, never restate it in the test), and
// asserts validateUnscoredReviewTexts's body calls the canonical predicates
// rather than re-implementing the skip checks inline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const VALIDATE_DATA_PATH = path.join(REPO_ROOT, 'scripts', 'validate-data.js');
const REBUILD_PATH = path.join(REPO_ROOT, 'scripts', 'rebuild-all-reviews.js');

function readSource(p) {
  return fs.readFileSync(p, 'utf8');
}

// Pulls the names destructured out of `require('./lib/review-guards')` (or
// '../lib/review-guards') calls in a source file, across as many call sites
// as it has — rebuild-all-reviews.js has one big import line; validate-data.js
// has historically had more than one.
function importedReviewGuardNames(source) {
  const names = new Set();
  const re = /const\s*\{([^}]+)\}\s*=\s*require\(['"][^'"]*lib\/review-guards['"]\)/g;
  let m;
  while ((m = re.exec(source))) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

// Extracts a top-level `function <name>() { ... }` body by brace-matching so
// we can inspect just that function's implementation, not the whole file.
function extractFunctionBody(source, fnName) {
  const marker = `function ${fnName}(`;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `expected to find function ${fnName} in source`);
  const braceStart = source.indexOf('{', start);
  assert.ok(braceStart !== -1, `expected an opening brace after ${fnName}(`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${fnName}`);
}

test('validate-data.js imports isIncludableForRebuild/hasValidScore from the same review-guards module rebuild-all-reviews.js uses', () => {
  const validateDataSource = readSource(VALIDATE_DATA_PATH);
  const rebuildSource = readSource(REBUILD_PATH);

  const validateDataImports = importedReviewGuardNames(validateDataSource);
  const rebuildImports = importedReviewGuardNames(rebuildSource);

  assert.ok(
    validateDataImports.has('isIncludableForRebuild'),
    'validate-data.js must import isIncludableForRebuild from scripts/lib/review-guards.js'
  );
  assert.ok(
    validateDataImports.has('hasValidScore'),
    'validate-data.js must import hasValidScore from scripts/lib/review-guards.js'
  );
  assert.ok(
    rebuildImports.has('isIncludableForRebuild'),
    'sanity check: rebuild-all-reviews.js is expected to import isIncludableForRebuild itself'
  );
});

test('validateUnscoredReviewTexts delegates to the canonical predicates instead of a hand-copied skip-flag mirror', () => {
  const source = readSource(VALIDATE_DATA_PATH);
  const body = extractFunctionBody(source, 'validateUnscoredReviewTexts');

  assert.match(
    body,
    /isIncludableForRebuild\s*\(/,
    'validateUnscoredReviewTexts must call the canonical isIncludableForRebuild predicate'
  );
  assert.match(
    body,
    /hasValidScore\s*\(/,
    'validateUnscoredReviewTexts must call the canonical hasValidScore predicate'
  );

  // Guards against regressing back to a hand-copied mirror: none of these
  // per-flag field reads (the shape a re-implemented skip-flag list would
  // take) should appear directly in this function body. They belong inside
  // isIncludableForRebuild, not restated here.
  const mirrorSmellFields = [
    'wrongProduction',
    'wrongShow',
    'rejectionReason',
    'isRoundupUrl',
    'notAReview',
  ];
  for (const field of mirrorSmellFields) {
    assert.ok(
      !body.includes(`.${field}`),
      `validateUnscoredReviewTexts appears to re-implement a "${field}" skip check ` +
        `inline instead of delegating to isIncludableForRebuild — this is the exact ` +
        `stale-mirror pattern BRO-2451 fixed. If a new check is genuinely needed here ` +
        `(not covered by the canonical predicate), add it to isIncludableForRebuild ` +
        `in scripts/lib/review-guards.js instead of this function.`
    );
  }
});

test('BRO-2451: the stale "mirrors rebuild-all-reviews.js skip logic as of 2026-04-11" docstring claim is gone', () => {
  const source = readSource(VALIDATE_DATA_PATH);
  assert.ok(
    !source.includes('The filter mirrors rebuild-all-reviews.js skip logic as of 2026-04-11'),
    'the stale mirror-maintenance docstring should have been corrected once the ' +
      'function started delegating to isIncludableForRebuild directly'
  );
});
