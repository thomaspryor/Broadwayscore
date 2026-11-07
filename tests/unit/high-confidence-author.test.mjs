/**
 * Regression tests for extractHighConfidenceAuthor() in scripts/lib/content-quality.js
 *
 * Bug: NYTG's SERP-derived criticName (site masthead "Gillian Russo") overwrote
 * the real review byline "Allison Considine" because the existing author-
 * enrichment only fired when criticName was already Unknown. Fix: a high-
 * confidence HTML extractor that ONLY matches per-article fields (article:author
 * meta and JSON-LD Person), never the site-masthead meta name="author" tag. The
 * collect-review-texts.js caller uses this to override criticName when the
 * start-position byline matches the HC author.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { extractHighConfidenceAuthor } = require('../../scripts/lib/content-quality.js');

describe('extractHighConfidenceAuthor', () => {
  test('returns JSON-LD Person author when present (NYTG shape)', () => {
    const html = `<html><head>
      <title>Review | NYTG</title>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Article',
        author: { '@type': 'Person', name: 'Allison Considine' },
      })}</script>
    </head><body>...</body></html>`;
    const r = extractHighConfidenceAuthor(html);
    assert.ok(r, 'expected a result');
    assert.strictEqual(r.name, 'Allison Considine');
    assert.strictEqual(r.source, 'jsonld-person');
  });

  test('returns article:author meta when present', () => {
    const html = `<html><head>
      <meta property="article:author" content="Jesse Green">
    </head><body></body></html>`;
    const r = extractHighConfidenceAuthor(html);
    assert.ok(r);
    assert.strictEqual(r.name, 'Jesse Green');
    assert.strictEqual(r.source, 'article:author');
  });

  test('article:author wins over JSON-LD Person (stronger signal)', () => {
    const html = `<html><head>
      <meta property="article:author" content="Jesse Green">
      <script type="application/ld+json">${JSON.stringify({
        author: { '@type': 'Person', name: 'Someone Else' },
      })}</script>
    </head><body></body></html>`;
    const r = extractHighConfidenceAuthor(html);
    assert.strictEqual(r.name, 'Jesse Green');
    assert.strictEqual(r.source, 'article:author');
  });

  test('ignores site-masthead meta name="author" (the NYTG failure mode)', () => {
    // This is EXACTLY the shape that caused the bug: NYTG's site chrome has
    // meta name="author" content="Gillian Russo" on every page (it's the
    // masthead editor). The HC extractor must NOT use it.
    const html = `<html><head>
      <meta name="author" content="Gillian Russo">
    </head><body></body></html>`;
    const r = extractHighConfidenceAuthor(html);
    assert.strictEqual(r, null, 'must not trust meta name="author" as high-confidence');
  });

  test('returns null when no high-confidence signal present', () => {
    const html = `<html><head><title>Review</title></head><body>
      <div class="byline">By Some Person</div>
    </body></html>`;
    const r = extractHighConfidenceAuthor(html);
    assert.strictEqual(r, null);
  });

  test('handles JSON-LD with name before @type (order-agnostic)', () => {
    // Some CMSs emit {"name": ..., "@type": "Person"} instead of type-first
    const html = `<html><head>
      <script type="application/ld+json">${JSON.stringify({
        author: { name: 'Helen Shaw', '@type': 'Person' },
      })}</script>
    </head></html>`;
    const r = extractHighConfidenceAuthor(html);
    assert.ok(r);
    assert.strictEqual(r.name, 'Helen Shaw');
    assert.strictEqual(r.source, 'jsonld-person');
  });

  test('null html input is safe', () => {
    assert.strictEqual(extractHighConfidenceAuthor(null), null);
    assert.strictEqual(extractHighConfidenceAuthor(''), null);
    assert.strictEqual(extractHighConfidenceAuthor(undefined), null);
  });
});
