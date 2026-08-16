/**
 * Regression test for #1650: same-title Broadway transfer contaminating a
 * regional predecessor's aggregator scrape. Playbill's own "What Do Critics
 * Think of The Outsiders on Broadway?" roundup was accepted as a match for
 * the-outsiders-world-premiere-regional-2023 (La Jolla Playhouse, 2023) on
 * title-word match alone — the heading never mentions a year, so the
 * existing year-mismatch layers never fire. Per CLAUDE.md rule 15 this
 * require()s the real function — no logic is copied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validatePageMatchesShow } = require('./page-validator.js');

const BROADWAY_ROUNDUP_HTML =
  '<html><head><title>Reviews: What Do Critics Think of The Outsiders on Broadway? | Playbill</title></head>' +
  '<body><h1 style="display:none;"></h1></body></html>';

test('rejects a Broadway roundup for a regional target show (production-category mismatch)', async () => {
  const result = await validatePageMatchesShow(BROADWAY_ROUNDUP_HTML, 'The Outsiders', {
    openingYear: 2023,
    category: 'regional',
    skipLlm: true,
  });
  assert.equal(result.valid, false);
  assert.match(result.reason, /production-category mismatch/);
});

test('still accepts the same roundup for the actual Broadway show', async () => {
  const result = await validatePageMatchesShow(BROADWAY_ROUNDUP_HTML, 'The Outsiders', {
    openingYear: 2024,
    category: 'broadway',
    skipLlm: true,
  });
  assert.equal(result.valid, true);
});

test('does not reject on "on Broadway" phrasing when category is unspecified (back-compat)', async () => {
  const result = await validatePageMatchesShow(BROADWAY_ROUNDUP_HTML, 'The Outsiders', {
    openingYear: 2023,
    skipLlm: true,
  });
  assert.equal(result.valid, true);
});

test('production-category mismatch check is case-insensitive on "on Broadway"', async () => {
  const html =
    '<html><head><title>THE OUTSIDERS Opens ON BROADWAY — Review Roundup</title></head><body></body></html>';
  const result = await validatePageMatchesShow(html, 'The Outsiders', {
    openingYear: 2023,
    category: 'off-broadway',
    skipLlm: true,
  });
  assert.equal(result.valid, false);
  assert.match(result.reason, /production-category mismatch/);
});
