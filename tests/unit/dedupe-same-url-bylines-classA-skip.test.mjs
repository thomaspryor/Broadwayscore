/**
 * Regression test (Codex adversarial review, card #1907): dedupe-same-url-
 * bylines.js's cohesive-group canonical-choice fold ignored
 * chooseCanonicalForRebuild's `skip: true` signal.
 *
 * chooseCanonicalForRebuild returns `skip: true` when BOTH members of a pair
 * are class-A cross-market contaminated (publishDate clusters with a
 * same-title SIBLING production's opening, far from this show's own opening)
 * — the explicit, safe verdict is "leave this pair suppressed, canonicalize
 * neither side" (fix-circular-duplicate-pairs.js's own audit() honors this by
 * `continue`-ing past the pair). dedupe-same-url-bylines.js's fold loop used
 * to take `c.canonical` regardless of `c.skip`, which — combined with card
 * #1907's forceResolve bypass making MORE groups reach this fold — could
 * unsuppress a known wrong-production review. Now the whole group is aborted
 * (left untouched) on any skip.
 *
 * Uses the real CLI via execFileSync (not an in-process require) because
 * fix-circular-duplicate-pairs.js's shows.json lookup is a module-level
 * singleton cache keyed off SHOWS_JSON at first use — only a fresh process
 * per test can control it (same pattern as circular-duplicate-pair.test.mjs's
 * cross-market tests).
 *
 * Run: node --test tests/unit/dedupe-same-url-bylines-classA-skip.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = fileURLToPath(new URL('../../scripts/dedupe-same-url-bylines.js', import.meta.url));
const longReview = 'A substantive critic review with a clear verdict and analysis. '.repeat(40);

function runFix(root, showsJsonPath) {
  execFileSync('node', [SCRIPT, '--fix'], {
    env: { ...process.env, REVIEW_TEXTS_DIR: root, SHOWS_JSON: showsJsonPath },
    stdio: 'pipe',
  });
}

test('dedupe-same-url-bylines --fix: a class-A contaminated placeholder-vs-real pair (both skip:true) is left untouched, not canonicalized', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-classA-'));
  const showsJson = path.join(root, 'shows.json');
  fs.writeFileSync(showsJson, JSON.stringify([
    { id: 'operation-mincemeat-west-end-2024', title: 'Operation Mincemeat', openingDate: '2024-05-01', category: 'west-end' },
    { id: 'operation-mincemeat-2025', title: 'Operation Mincemeat', openingDate: '2025-03-20', category: 'broadway' },
  ]));

  // Same-URL pair under the WE folder, NO duplicateOf link between them (so
  // audit() doesn't skip via the "already collapsed" check), both dated on
  // the Broadway sibling's opening (~323d from the WE show's own opening) ->
  // class-A on BOTH sides -> chooseCanonicalForRebuild returns skip:true.
  // One member is a placeholder byline (outlet name) so hasPlaceholderVsRealSplit
  // forces this group past the rebuildAlreadyCollapses bypass into the fold.
  const dir = path.join(root, 'operation-mincemeat-west-end-2024');
  fs.mkdirSync(dir, { recursive: true });
  const url = 'https://www.timeout.com/london/theatre/operation-mincemeat-review';
  fs.writeFileSync(path.join(dir, 'timeout--time-out-london.json'), JSON.stringify({
    showId: 'operation-mincemeat-west-end-2024', outletId: 'timeout', outlet: 'Time Out London',
    criticName: 'Time Out London', url, publishDate: 'March 20, 2025',
    contentTier: 'complete', isFullReview: true, fullText: longReview, assignedScore: 80,
  }));
  fs.writeFileSync(path.join(dir, 'timeout--paul-raven.json'), JSON.stringify({
    showId: 'operation-mincemeat-west-end-2024', outletId: 'timeout', outlet: 'Time Out London',
    criticName: 'Paul Raven', url, publishDate: 'March 20, 2025',
    contentTier: 'complete', isFullReview: true, fullText: longReview, assignedScore: 80,
  }));

  runFix(root, showsJson);

  const a = JSON.parse(fs.readFileSync(path.join(dir, 'timeout--time-out-london.json'), 'utf-8'));
  const b = JSON.parse(fs.readFileSync(path.join(dir, 'timeout--paul-raven.json'), 'utf-8'));
  assert.equal(a.duplicateOf ?? null, null, 'class-A group must be left untouched — neither member gets a NEW duplicateOf pointer');
  assert.equal(b.duplicateOf ?? null, null, 'class-A group must be left untouched — neither member gets a NEW duplicateOf pointer');
});
