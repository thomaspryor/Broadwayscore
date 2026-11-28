/**
 * Regression test for the HC-author override in collect-review-texts.js.
 *
 * The bug: collect-review-texts previously only overrode a SERP-derived wrong
 * criticName inside the byline cross-check branch — which required
 * extractByline() to find a "By X" pattern in cleanedText. On outlets like
 * NYTG where the byline is formatted in HTML that doesn't survive stripping,
 * extractByline returns {found:false}, so the override never fired.
 *
 * The fix: a separate HC-priority override block that runs when the article
 * has a high-confidence per-article author (article:author meta or JSON-LD
 * Person) that differs from the stored criticName. This doesn't require
 * extractByline to succeed.
 *
 * Rather than spin up the full collect-review-texts pipeline (which reads
 * shows.json, filesystem, etc.), this test exercises the decision logic
 * directly with synthetic inputs that represent the production conditions.
 *
 * Scenarios covered:
 *   1. NYTG-shape HTML with article:author meta + extractByline fails
 *      (the exact 2026-04-19 Fallen Angels failure).
 *   2. HC author matches stored name (no override).
 *   3. criticNameManual set (no override).
 *   4. criticName='Unknown' (no override — enrichment path handles that).
 *   5. No HC signal present (no override).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { extractHighConfidenceAuthor, matchesCritic } = require('../../scripts/lib/content-quality.js');

// Direct port of the override logic from collect-review-texts.js 1A-bis.
// Kept in sync by rerunning this test whenever that block changes.
function applyHCOverride(data, html) {
  if (!html || data.criticNameManual) return { fired: false, data };
  const hcAuthor = extractHighConfidenceAuthor(html);
  const storedCritic = data.criticName || '';
  if (hcAuthor &&
      storedCritic &&
      storedCritic !== 'Unknown' &&
      !matchesCritic(hcAuthor.name, storedCritic)) {
    const out = { ...data };
    out.criticName = hcAuthor.name;
    out.criticEnrichedFrom = `html-override:${hcAuthor.source}`;
    out._priorCriticName = storedCritic;
    delete out.misattributedFullText;
    delete out.extractedByline;
    delete out.expectedCritic;
    delete out.fullTextWrongAuthor;
    delete out._authorMismatch;
    return { fired: true, data: out };
  }
  return { fired: false, data };
}

describe('HC author override (1A-bis in collect-review-texts.js)', () => {
  test('NYTG-shape article:author overrides SERP-derived masthead name', () => {
    // Real NYTG 2026-04-19 Fallen Angels case — SERP returned the site-masthead
    // editor (Gillian Russo), article:author is the real review author.
    const html = '<html><head>' +
      '<meta property="article:author" content="Allison Considine">' +
      '</head><body>...article body with no "By X" pattern...</body></html>';
    const data = {
      criticName: 'Gillian Russo',
      criticEnrichedFrom: 'serp-masthead',
    };
    const result = applyHCOverride(data, html);
    assert.strictEqual(result.fired, true);
    assert.strictEqual(result.data.criticName, 'Allison Considine');
    assert.strictEqual(result.data.criticEnrichedFrom, 'html-override:article:author');
    assert.strictEqual(result.data._priorCriticName, 'Gillian Russo');
  });

  test('JSON-LD Person override (NYTG alternate shape)', () => {
    const html = '<html><head>' +
      '<script type="application/ld+json">' + JSON.stringify({
        '@type': 'Article',
        author: { '@type': 'Person', name: 'Helen Shaw' },
      }) + '</script>' +
      '</head><body></body></html>';
    const data = { criticName: 'Editor Name' };
    const result = applyHCOverride(data, html);
    assert.strictEqual(result.fired, true);
    assert.strictEqual(result.data.criticName, 'Helen Shaw');
    assert.strictEqual(result.data.criticEnrichedFrom, 'html-override:jsonld-person');
  });

  test('stored name matches HC author → no override', () => {
    const html = '<meta property="article:author" content="Jesse Green">';
    const data = { criticName: 'Jesse Green' };
    const result = applyHCOverride(data, html);
    assert.strictEqual(result.fired, false);
    assert.strictEqual(result.data.criticName, 'Jesse Green');
  });

  test('criticNameManual set → override skipped even on mismatch', () => {
    const html = '<meta property="article:author" content="Allison Considine">';
    const data = { criticName: 'Manually Verified Name', criticNameManual: true };
    const result = applyHCOverride(data, html);
    assert.strictEqual(result.fired, false);
    assert.strictEqual(result.data.criticName, 'Manually Verified Name');
  });

  test('criticName=Unknown → override skipped (enrichment path owns Unknown)', () => {
    const html = '<meta property="article:author" content="Allison Considine">';
    const data = { criticName: 'Unknown' };
    const result = applyHCOverride(data, html);
    assert.strictEqual(result.fired, false);
  });

  test('no HC signal → override skipped (site-masthead meta not trusted)', () => {
    // Only masthead present — HC extractor ignores it.
    const html = '<meta name="author" content="Gillian Russo">';
    const data = { criticName: 'Jesse Green' };
    const result = applyHCOverride(data, html);
    assert.strictEqual(result.fired, false);
  });

  test('clears stale mismatch flags when override fires', () => {
    const html = '<meta property="article:author" content="Allison Considine">';
    const data = {
      criticName: 'Gillian Russo',
      misattributedFullText: true,
      extractedByline: 'Gillian Russo',
      expectedCritic: 'Gillian Russo',
      fullTextWrongAuthor: true,
      _authorMismatch: 'stale',
    };
    const result = applyHCOverride(data, html);
    assert.strictEqual(result.fired, true);
    assert.strictEqual(result.data.misattributedFullText, undefined);
    assert.strictEqual(result.data.extractedByline, undefined);
    assert.strictEqual(result.data.expectedCritic, undefined);
    assert.strictEqual(result.data.fullTextWrongAuthor, undefined);
    assert.strictEqual(result.data._authorMismatch, undefined);
  });
});
