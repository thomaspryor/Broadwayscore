/**
 * BRO-2023 /what-else sweep: dtli-homepage-scan.js had the same class of bug
 * as opening-night-poller.js's TB isRevival predicate —
 *   isLikelyRevival = !!(show.isRevival || (show.id && /\b(19|20)\d{2}$/.test(show.id)))
 * Every show.id ends in its opening year, so the id-regex half of that OR
 * was true for EVERY show, forcing the revival tie-break (prefer a numbered
 * slug like "giant-2" over a same-scoring alternative) unconditionally,
 * even for brand-new, non-revival shows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findDTLIShowLinkOnHomepage } = require('../../scripts/lib/dtli-homepage-scan.js');
const fs = require('fs');
const path = require('path');

function htmlWithAnchors(slugs) {
  return `<html><body>${slugs.map(s => `<a href="https://didtheylikeit.com/shows/${s}/">${s}</a>`).join('\n')}</body></html>`;
}

test('non-revival show with a tied numbered/non-numbered slug pair does NOT force the numbered one', () => {
  // "giant-broadway" and "giant-2" both score 11 (title match +1 category/digit
  // bonus each) — a genuine tie. giant-broadway is listed first.
  const html = htmlWithAnchors(['giant-broadway', 'giant-2']);
  const show = { title: 'Giant', id: 'giant-2026', isRevival: false };
  const url = findDTLIShowLinkOnHomepage(html, show);
  assert.equal(url, 'https://didtheylikeit.com/shows/giant-broadway/');
});

test('a genuine revival still prefers the numbered slug on a tie (feature still works)', () => {
  const html = htmlWithAnchors(['giant-broadway', 'giant-2']);
  const show = { title: 'Giant', id: 'giant-2026', isRevival: true };
  const url = findDTLIShowLinkOnHomepage(html, show);
  assert.equal(url, 'https://didtheylikeit.com/shows/giant-2/');
});

test('the id-ends-in-a-year regex is gone from the tie-break predicate', () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', '..', 'scripts/lib/dtli-homepage-scan.js'), 'utf8');
  assert.doesNotMatch(src, /show\.isRevival \|\| \(show\.id/,
    'the id-year OR clause regressed — it matches every show.id and forces the tie-break unconditionally');
});
