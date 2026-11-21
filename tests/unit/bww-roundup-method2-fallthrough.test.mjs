/**
 * BWW Review Roundup — Method 2 fall-through regression test.
 *
 * Bucket B (discovery misses, 12 incidents): BWW's JSON-LD BlogPosting entries
 * omit ~45% of roundup reviews — typically outlets whose entry lacks a hyperlink
 * (Guardian, NYTG, etc.). Method 2 scans `articleBody` text as a supplementary
 * pass to recover them.
 *
 * Historic bug: Method 1 had `return reviews;` immediately after JSON-LD
 * extraction, short-circuiting Method 2 whenever JSON-LD succeeded. Fix:
 * fall through unconditionally and let Method 2 dedup against Method 1's
 * results. See scripts/gather-reviews.js:2267 — the "Fall through to
 * supplementary text scan" comment marks the invariant.
 *
 * This test locks that invariant in two ways:
 *   1. STRUCTURAL — source of gather-reviews.js must still carry the
 *      fall-through comment marker AND must not introduce a `return reviews;`
 *      inside the Method 1 success branch.
 *   2. FUNCTIONAL — construct a minimal fixture where Method 1 extracts one
 *      outlet and Method 2's articleBody contains a DIFFERENT outlet; both
 *      must appear in the final result.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const ROOT = join(import.meta.dirname, '..', '..');
const GATHER_PATH = join(ROOT, 'scripts/gather-reviews.js');
const { extractBWWRoundupReviews } = require(GATHER_PATH);

// Minimal synthetic BWW roundup HTML.
// - Method 1 path: parses JSON-LD BlogPosting with author="Variety - Frank Rich".
// - Method 2 path: reads articleBody text, finds "Frank Rich, Variety:"
//   (duplicate, should be skipped via dedup) AND
//   "Adam Feldman, TimeOut New York:" (new, must be added via supplement).
// If fall-through is removed, Method 2 never runs and Adam Feldman is missing.
const FIXTURE = `<html><body>
<script type="application/ld+json">
{
  "@type": "BlogPosting",
  "author": { "name": "Variety - Frank Rich" },
  "url": "https://variety.com/test-review",
  "headline": "Variety Review - Test Show",
  "datePublished": "2026-04-20",
  "articleBody": "Let's see what the critics had to say... Frank Rich, Variety: A dazzling triumph that reinvents the form. Adam Feldman, TimeOut New York: Razor-sharp and emotionally devastating in equal measure."
}
</script>
<p>Body text</p>
</body></html>`;

const FIXTURE_URL =
  'https://www.broadwayworld.com/article/Review-Roundup-TEST-SHOW-Opens-on-Broadway-20260420';

test('Method 2 fall-through (functional): articleBody supplement adds outlets not in JSON-LD', () => {
  const reviews = extractBWWRoundupReviews(
    FIXTURE,
    'test-show-2026',
    FIXTURE_URL,
    'Test Show'
  );

  // Method 1 alone would yield 1 entry (Frank Rich / Variety). Method 2's
  // supplement must add Adam Feldman — the regression signal.
  const critics = reviews.map(r => r.criticName).filter(Boolean);
  assert.ok(
    critics.includes('Adam Feldman'),
    `Method 2 fall-through regressed: expected supplement to add Adam Feldman. ` +
      `Got critics: ${JSON.stringify(critics)}. If Method 1 added a 'return reviews;' ` +
      `after JSON-LD extraction, this assertion fails.`
  );

  // Frank Rich appears in both Method 1 JSON-LD and Method 2 articleBody.
  // Dedup must keep exactly one entry, not two.
  const frankRichCount = critics.filter(n => n === 'Frank Rich').length;
  assert.strictEqual(
    frankRichCount,
    1,
    `Dedup regressed: Method 2 should skip duplicates already in Method 1. ` +
      `Got ${frankRichCount} Frank Rich entries.`
  );
});

test('Method 2 fall-through (structural): fall-through comment marker still present', () => {
  // If a refactor deletes the comment, the test still passes iff fall-through
  // works. But the comment IS the intent marker — deleting it is the step
  // that precedes "oh, and let's add a return here for efficiency" regression.
  // Keeping it documented in the test file means a PR that removes the
  // comment requires editing THIS test too, which forces the author to
  // confront the invariant.
  const source = readFileSync(GATHER_PATH, 'utf8');
  assert.ok(
    source.includes('Fall through to supplementary text scan'),
    'Fall-through comment marker missing from gather-reviews.js. If you removed ' +
      'it intentionally, also update this test. But first: did you also add ' +
      '`return reviews;` to the Method 1 success branch? That silently drops ~45% ' +
      'of BWW roundup reviews (Guardian, NYTG, and any outlet whose JSON-LD ' +
      'BlogPosting lacks a hyperlink). Bucket B, 12 documented incidents.'
  );
});

test('Method 2 fall-through (structural): no `return reviews;` before supplement loop', () => {
  // Surgically check that no `return reviews;` appears between
  // `Extracted ${reviews.length} reviews from BWW roundup (BlogPosting)`
  // and the `// Method 2 / Supplement:` marker. This is the slice where
  // the historic regression lived.
  const source = readFileSync(GATHER_PATH, 'utf8');
  const startMarker = 'Extracted ${reviews.length} reviews from BWW roundup (BlogPosting)';
  const endMarker = '// Method 2 / Supplement:';
  const startIdx = source.indexOf(startMarker);
  const endIdx = source.indexOf(endMarker);
  assert.ok(startIdx > 0, `Start marker not found: ${startMarker}`);
  assert.ok(endIdx > startIdx, `End marker not found after start: ${endMarker}`);
  const slice = source.substring(startIdx, endIdx);
  assert.ok(
    !/\breturn\s+reviews\s*;/.test(slice),
    'Found `return reviews;` between Method 1 success log and Method 2 marker. ' +
      'This short-circuits the supplementary text scan and drops ~45% of BWW ' +
      'roundup reviews. Remove the return — let dedup handle overlap.'
  );
});
