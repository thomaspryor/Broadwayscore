/**
 * LLM fallback on PARTIAL extraction (not just zero).
 *
 * The pre-fix behavior: `llmFallbackExtract()` only fired when regex returned 0.
 * Partial misses — e.g. BWW ships a new review-card variant and we catch 5 of 8
 * — shipped silently for days. This test locks the new partial-detection path
 * and the merge logic that folds LLM reviews into the regex baseline.
 *
 * Tests exercise the real helpers from scripts/lib/llm-extractor.js per the
 * CLAUDE.md §15 "require the real function" rule. Wiring into gather-reviews.js
 * is locked structurally so a silent removal fails CI.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');

const {
  countExpectedReviews,
  isPartialExtraction,
  mergeAggregatorReviews,
  hasStructuralMarkers,
} = require(join(ROOT, 'scripts/lib/llm-extractor.js'));

test('countExpectedReviews DTLI: sums thumb-summary numbers', () => {
  // DTLI renders: `<img src=".../thumbs-up/thumb-5.png">` + meh-2 + down-1 → 8
  const html = `
    <img src="https://didtheylikeit.com/thumbs-up/thumb-5.png">
    <img src="https://didtheylikeit.com/thumbs-meh/thumb-2.png">
    <img src="https://didtheylikeit.com/thumbs-down/thumb-1.png">
  `;
  assert.strictEqual(countExpectedReviews(html, 'dtli'), 8);
});

test('countExpectedReviews DTLI: handles zero-count thumbs', () => {
  const html = `<img src="/thumbs-up/thumb-0.png"><img src="/thumbs-meh/thumb-0.png"><img src="/thumbs-down/thumb-0.png">`;
  assert.strictEqual(countExpectedReviews(html, 'dtli'), 0);
});

test('countExpectedReviews DTLI: falls back to review-item blocks when summary missing', () => {
  // Some DTLI variants render without thumb-summary imagery; counting blocks is the fallback.
  const html = `
    <div class="review-item">...</div>
    <div class="poster-review-item">...</div>
    <div class="review-item">...</div>
  `;
  assert.strictEqual(countExpectedReviews(html, 'dtli'), 3);
});

test('countExpectedReviews BWW: counts thumb images across old + new variants', () => {
  // Mix of new-format thumbs (`uptrans.png`, Fallen-Angels suffixed `uptrans2.png`,
  // `middletrans.png`, `downtrans.png`) and legacy `BigThumbs_UP.gif`.
  const html = `
    <img src="uptrans.png">
    <img src="uptrans2.png">
    <img src="middletrans.png">
    <img src="downtrans.png">
    <img src="BigThumbs_UP.gif">
    <img src="BigThumbs_MEH.gif">
  `;
  assert.strictEqual(countExpectedReviews(html, 'bww'), 6);
});

test('countExpectedReviews BWW: falls back to JSON-LD BlogPosting when thumbs missing', () => {
  const html = `
    <script type="application/ld+json">{"@type":"BlogPosting"}</script>
    <script type="application/ld+json">{"@type":"BlogPosting"}</script>
    <script type="application/ld+json">{"@type":"BlogPosting"}</script>
  `;
  assert.strictEqual(countExpectedReviews(html, 'bww'), 3);
});

test('countExpectedReviews: unknown aggregator or bad input → 0', () => {
  assert.strictEqual(countExpectedReviews('', 'dtli'), 0);
  assert.strictEqual(countExpectedReviews(null, 'dtli'), 0);
  assert.strictEqual(countExpectedReviews('<html>no signal</html>', 'dtli'), 0);
  assert.strictEqual(countExpectedReviews('<html>no signal</html>', 'bww'), 0);
  assert.strictEqual(countExpectedReviews('<html></html>', 'unknown'), 0);
});

test('isPartialExtraction: triggers when expected≥5 and gap≥3', () => {
  // Classic repro: BWW adds a new review-card variant; regex catches 5 of 8.
  assert.strictEqual(isPartialExtraction(5, 8), true);
  assert.strictEqual(isPartialExtraction(0, 8), true);
  assert.strictEqual(isPartialExtraction(3, 10), true);
});

test('isPartialExtraction: does NOT trigger on small gap (off-by-one/two)', () => {
  // Thumb images can get off-by-one due to edge cases (hero thumb, teaser img).
  // A 1-2 review gap is not worth paying an LLM call for.
  assert.strictEqual(isPartialExtraction(7, 8), false);
  assert.strictEqual(isPartialExtraction(6, 8), false);
});

test('isPartialExtraction: does NOT trigger when expected < 5', () => {
  // Small pages get false positives too easily; require at least 5 expected.
  assert.strictEqual(isPartialExtraction(0, 4), false);
  assert.strictEqual(isPartialExtraction(1, 4), false);
});

test('isPartialExtraction: does NOT trigger when extracted >= expected', () => {
  // Regex over-extracts (positional mismatch) happens too; don't retry in that direction.
  assert.strictEqual(isPartialExtraction(8, 8), false);
  assert.strictEqual(isPartialExtraction(10, 8), false);
});

test('mergeAggregatorReviews: returns baseline when LLM list empty/undefined', () => {
  const baseline = [
    { outletId: 'nytimes', criticName: 'Jesse Green', url: 'https://nytimes.com/a' },
  ];
  assert.deepStrictEqual(mergeAggregatorReviews(baseline, []), baseline);
  assert.deepStrictEqual(mergeAggregatorReviews(baseline, null), baseline);
  assert.deepStrictEqual(mergeAggregatorReviews(baseline, undefined), baseline);
});

test('mergeAggregatorReviews: adds LLM-only reviews (no dedup collision)', () => {
  const baseline = [{ outletId: 'nytimes', criticName: 'Jesse Green', url: 'https://nytimes.com/a' }];
  const llm = [
    { outletId: 'variety', criticName: 'Naveen Kumar', url: 'https://variety.com/b' },
    { outletId: 'vulture', criticName: 'Helen Shaw', url: 'https://vulture.com/c' },
  ];
  const merged = mergeAggregatorReviews(baseline, llm);
  assert.strictEqual(merged.length, 3);
});

test('mergeAggregatorReviews: dedups when LLM re-finds a URL already in regex baseline', () => {
  // Main dedup case: regex parsed the NYT block correctly; LLM sees it too.
  // We must keep the regex version (trusted source) and drop the LLM duplicate.
  const regexVersion = { outletId: 'nytimes', criticName: 'Jesse Green', url: 'https://nytimes.com/a', source: 'dtli' };
  const llmDup = { outletId: 'nytimes', criticName: 'Jesse Green', url: 'https://nytimes.com/a', source: 'dtli' };
  const llmNew = { outletId: 'variety', criticName: 'Naveen Kumar', url: 'https://variety.com/b', source: 'dtli' };
  const merged = mergeAggregatorReviews([regexVersion], [llmDup, llmNew]);
  assert.strictEqual(merged.length, 2);
  // The retained NYT entry must be the regex one, not the LLM copy.
  assert.strictEqual(merged[0], regexVersion);
});

test('mergeAggregatorReviews: normalizes URL for dedup (trailing slash, query, fragment)', () => {
  const baseline = [{ outletId: 'nytimes', criticName: 'JG', url: 'https://nytimes.com/a/' }];
  const llm = [
    { outletId: 'nytimes', criticName: 'JG', url: 'https://nytimes.com/a?ref=rss' },
    { outletId: 'nytimes', criticName: 'JG', url: 'https://nytimes.com/a#top' },
    { outletId: 'nytimes', criticName: 'JG', url: 'HTTPS://NYTIMES.COM/a' },
  ];
  const merged = mergeAggregatorReviews(baseline, llm);
  assert.strictEqual(merged.length, 1, 'trailing-slash/query/fragment/case variants should all dedup to baseline');
});

test('mergeAggregatorReviews: dedups by (outletId, criticName) when URL missing', () => {
  // BWW Method 1 often produces reviews with no URL; LLM extraction
  // sees the same review via a different markup path — don't double-count.
  const baseline = [{ outletId: 'nytimes', criticName: 'Jesse Green', url: null }];
  const llmDup = { outletId: 'nytimes', criticName: 'JESSE GREEN', url: null };
  const llmNew = { outletId: 'variety', criticName: 'Naveen Kumar', url: null };
  const merged = mergeAggregatorReviews(baseline, llmDup ? [llmDup, llmNew] : [llmNew]);
  // LLM Jesse Green should dedup against baseline; Naveen Kumar is new.
  assert.strictEqual(merged.length, 2);
  assert.ok(merged.find(r => r.criticName === 'Naveen Kumar'));
});

test('mergeAggregatorReviews: drops anchorless LLM reviews (no outletId and no URL)', () => {
  // An LLM review with neither an outletId nor a URL cannot be matched to
  // anything downstream and would only add noise — drop it.
  const baseline = [];
  const llm = [
    { outletId: '', criticName: 'Anon', url: null },
    { outletId: 'nytimes', criticName: 'Jesse Green', url: null }, // anchored by outletId
    { outletId: '', criticName: '', url: 'https://variety.com/b' }, // anchored by URL
  ];
  const merged = mergeAggregatorReviews(baseline, llm);
  assert.strictEqual(merged.length, 2);
  assert.ok(!merged.find(r => r.criticName === 'Anon'));
});

test('hasStructuralMarkers still gates the partial path so LLM is skipped on empty shells', () => {
  // Sanity check — the partial path in gather-reviews.js guards on both
  // isPartialExtraction AND hasStructuralMarkers. If the markers table is
  // broken, partial-fallback becomes a broad LLM trigger. Lock the table.
  const dtliHtml = '<div class="review-item"><img src="BigThumbs_UP"> didtheylikeit</div>';
  assert.strictEqual(hasStructuralMarkers(dtliHtml, 'dtli'), true);
  assert.strictEqual(hasStructuralMarkers('<p>nothing</p>', 'dtli'), false);
});

test('gather-reviews.js still wires the partial-extraction fallback for DTLI and BWW', () => {
  // Wiring regression — if the partial branch is deleted, silent format-change
  // misses return. Lock the integration points.
  const src = readFileSync(join(ROOT, 'scripts/gather-reviews.js'), 'utf8');
  assert.ok(
    /countExpectedReviews\s*\([\s\S]{0,60}'dtli'\s*\)/.test(src),
    'gather-reviews.js no longer counts expected DTLI reviews'
  );
  assert.ok(
    /countExpectedReviews\s*\([\s\S]{0,60}'bww'\s*\)/.test(src),
    'gather-reviews.js no longer counts expected BWW reviews'
  );
  assert.ok(
    /isPartialExtraction\s*\(\s*dtliReviews\.length/.test(src),
    'gather-reviews.js no longer invokes isPartialExtraction for DTLI — partial fallback disabled'
  );
  assert.ok(
    /isPartialExtraction\s*\(\s*bwwReviews\.length/.test(src),
    'gather-reviews.js no longer invokes isPartialExtraction for BWW — partial fallback disabled'
  );
  assert.ok(
    /mergeAggregatorReviews\s*\(\s*dtliReviews/.test(src),
    'gather-reviews.js no longer merges LLM reviews into DTLI regex baseline'
  );
  assert.ok(
    /mergeAggregatorReviews\s*\(\s*bwwReviews/.test(src),
    'gather-reviews.js no longer merges LLM reviews into BWW regex baseline'
  );
});
