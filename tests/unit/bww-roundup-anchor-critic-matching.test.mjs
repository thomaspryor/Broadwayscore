/**
 * BRO-3504: BWW roundup anchor URLs are matched to critics by the name written
 * right before each anchor ("<p>Critic Name, <a href>Outlet:</a> ..."), not by
 * plain document order.
 *
 * Failure this guards: a multi-critic outlet (NYSR, NYT, TimeOut) has anchors
 * in the order [Critic B's link, Critic A's link] while Critic A is discovered
 * first (JSON-LD). Positional FIFO handed A B's link and B A's link (or null),
 * a silently wrong critic-to-URL pairing.
 *
 * Synthetic HTML only; no data dependency.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  criticNameBeforeAnchor,
  scanRoundupOutletAnchors,
  criticNamesMatch,
  orderAnchorCandidates,
} = require('../../scripts/lib/bww-roundup-parser.js');
const { normalizeOutlet } = require('../../scripts/lib/review-normalization.js');
const { extractBWWRoundupReviews } = require('../../scripts/gather-reviews.js');

const BWW_URL = 'https://www.broadwayworld.com/article/Review-Roundup-Test-Show-2026';
const SCHECK_URL = 'https://nystagereview.com/2026/04/15/test-show-a-long-stretch/';
const FINKLE_URL = 'https://nystagereview.com/2026/04/15/test-show-brody-acquits-himself/';

// Two NYSR critics, both discovered from JSON-LD in the order [Scheck, Finkle],
// while the page's anchors (and prose mentions) are in the REVERSED order
// [Finkle, Scheck].
function reversedAnchorPage() {
  const ld = {
    '@type': 'LiveBlogPosting',
    articleBody: "Let's see what the critics had to say...",
    liveBlogUpdate: [
      { '@type': 'BlogPosting', author: { name: 'New York Stage Review - Frank Scheck' }, articleBody: 'Scheck says it feels like a long stretch.' },
      { '@type': 'BlogPosting', author: { name: 'New York Stage Review - David Finkle' }, articleBody: 'Finkle praises the daring commitment.' },
    ],
  };
  return `<html><body>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<p>David Finkle, <a href="${FINKLE_URL}">New York Stage Review:</a> Finkle praises the daring commitment.</p>
<p>Frank Scheck, <a href="${SCHECK_URL}">New York Stage Review:</a> Scheck says it feels like a long stretch.</p>
</body></html>`;
}

describe('BRO-3504: criticNameBeforeAnchor', () => {
  test('reads the "Name," lead-in of the anchor\'s own entry', () => {
    const html = reversedAnchorPage();
    assert.strictEqual(criticNameBeforeAnchor(html, html.indexOf(`<a href="${FINKLE_URL}"`)), 'David Finkle');
    assert.strictEqual(criticNameBeforeAnchor(html, html.indexOf(`<a href="${SCHECK_URL}"`)), 'Frank Scheck');
  });

  test('handles inline markup and &nbsp; around the name', () => {
    const html2 = '<p><strong>Naveen Kumar</strong>,&nbsp;<a href="https://variety.com/r">Variety:</a> q</p>';
    assert.strictEqual(criticNameBeforeAnchor(html2, html2.indexOf('<a ')), 'Naveen Kumar');
  });

  test('returns null when the entry text before the anchor is not a bare name', () => {
    const html = '<p>As the show went on, <a href="https://variety.com/r">Variety</a> said</p>';
    assert.strictEqual(criticNameBeforeAnchor(html, html.indexOf('<a ')), null);
    const html2 = '<p><a href="https://variety.com/r">Variety review</a></p>';
    assert.strictEqual(criticNameBeforeAnchor(html2, html2.indexOf('<a ')), null);
  });

  test('reads a critic name that is itself a /people/ link (real BWW markup)', () => {
    const html = '<p><a href="/people/Jesse-Oxfeld/">Jesse Oxfeld</a>, <a href="http://nystagereview.com/2019/x/">New York Stage Review:</a> q</p>';
    assert.strictEqual(criticNameBeforeAnchor(html, html.lastIndexOf('<a ')), 'Jesse Oxfeld');
  });

  test('does not borrow a name from the previous entry', () => {
    const html = '<p>Frank Scheck, <a href="https://a.com/1">NYSR:</a> q</p><p><a href="https://a.com/2">NYSR:</a> q</p>';
    assert.strictEqual(criticNameBeforeAnchor(html, html.lastIndexOf('<a ')), null);
  });
});

describe('BRO-3504: scanRoundupOutletAnchors', () => {
  test('keeps document order and attaches each anchor\'s lead-in name', () => {
    const byOutlet = scanRoundupOutletAnchors(reversedAnchorPage(), normalizeOutlet);
    const oid = normalizeOutlet('New York Stage Review');
    assert.ok(oid, 'NYSR must normalize to an outlet id');
    assert.deepStrictEqual(byOutlet[oid], [
      { href: FINKLE_URL, criticName: 'David Finkle' },
      { href: SCHECK_URL, criticName: 'Frank Scheck' },
    ]);
  });
});

describe('BRO-3504: orderAnchorCandidates', () => {
  const entries = [
    { href: FINKLE_URL, criticName: 'David Finkle' },
    { href: SCHECK_URL, criticName: 'Frank Scheck' },
  ];

  test('name match beats document order', () => {
    assert.deepStrictEqual(orderAnchorCandidates(entries, new Set(), 'Frank Scheck', ['David Finkle']), [1]);
    assert.deepStrictEqual(orderAnchorCandidates(entries, new Set(), 'David Finkle', ['Frank Scheck']), [0]);
  });

  test('a critic whose own anchor exists never falls back to another critic\'s anchor', () => {
    // Scheck's own anchor (index 1) was rejected and consumed; the remaining
    // anchor is named for roster critic Finkle, so Scheck gets no candidates.
    assert.deepStrictEqual(orderAnchorCandidates(entries, new Set([1]), 'Frank Scheck', ['David Finkle']), []);
  });

  test('no name signal → positional FIFO (pre-BRO-3504 behaviour)', () => {
    const unnamed = [{ href: 'https://a.com/1', criticName: null }, { href: 'https://a.com/2', criticName: null }];
    assert.deepStrictEqual(orderAnchorCandidates(unnamed, new Set(), 'Frank Scheck', []), [0, 1]);
    assert.deepStrictEqual(orderAnchorCandidates(unnamed, new Set([0]), null, []), [1]);
  });

  test('unknown critic prefers unnamed anchors, then names outside the roster', () => {
    const mixed = [
      { href: 'https://a.com/stranger', criticName: 'Roma Torre' },
      { href: 'https://a.com/finkle', criticName: 'David Finkle' },
      { href: 'https://a.com/unnamed', criticName: null },
    ];
    assert.deepStrictEqual(orderAnchorCandidates(mixed, new Set(), null, ['David Finkle']), [2, 0]);
  });

  test('criticNamesMatch: case/diacritics fold, initial+surname, rejects different people', () => {
    assert.ok(criticNamesMatch('José Solís', 'Jose Solis'));
    assert.ok(criticNamesMatch('FRANK SCHECK', 'Frank Scheck'));
    assert.ok(criticNamesMatch('Frank Scheck', 'F. Scheck'));
    assert.ok(!criticNamesMatch('Frank Scheck', 'David Finkle'));
    assert.ok(!criticNamesMatch('Scheck', 'Frank Scheck'));
    assert.ok(!criticNamesMatch(null, 'Frank Scheck'));
  });
});

describe('BRO-3504: extractBWWRoundupReviews pairs URLs by critic name', () => {
  test('anchors in REVERSED order from discovery: each critic gets their own link', () => {
    const reviews = extractBWWRoundupReviews(reversedAnchorPage(), 'test-show-2026', BWW_URL, 'Test Show');
    const scheck = reviews.find((r) => r.criticName === 'Frank Scheck');
    const finkle = reviews.find((r) => r.criticName === 'David Finkle');
    assert.ok(scheck, 'expected a Frank Scheck review');
    assert.ok(finkle, 'expected a David Finkle review');
    // Scheck was discovered first; positional FIFO would hand him FINKLE_URL.
    assert.strictEqual(scheck.url, SCHECK_URL);
    assert.strictEqual(finkle.url, FINKLE_URL);
  });

  test('JSON-LD critic + articleBody critic, anchors reversed: no swap across passes', () => {
    const greenUrl = 'https://www.nytimes.com/2026/04/15/theater/test-show-review-green.html';
    const vinesUrl = 'https://www.nytimes.com/2026/04/15/theater/test-show-review-vines.html';
    const ld = {
      '@type': 'LiveBlogPosting',
      articleBody: "Let's see what the critics had to say... Elisabeth Vincentelli, The New York Times: A lively evening.",
      liveBlogUpdate: [
        { '@type': 'BlogPosting', author: { name: 'The New York Times - Jesse Green' }, articleBody: 'Green finds it thin.' },
      ],
    };
    const html = `<html><body>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<p>Elisabeth Vincentelli, <a href="${vinesUrl}">The New York Times:</a> A lively evening.</p>
<p>Jesse Green, <a href="${greenUrl}">The New York Times:</a> Green finds it thin.</p>
</body></html>`;
    const reviews = extractBWWRoundupReviews(html, 'test-show-2026', BWW_URL, 'Test Show');
    const green = reviews.find((r) => r.criticName === 'Jesse Green');
    const vines = reviews.find((r) => r.criticName === 'Elisabeth Vincentelli');
    assert.ok(green, 'expected a Jesse Green review');
    assert.ok(vines, 'expected an Elisabeth Vincentelli review');
    assert.strictEqual(green.url, greenUrl);
    assert.strictEqual(vines.url, vinesUrl);
  });

  test('no name signal near anchors: positional FIFO still distributes distinct URLs', () => {
    const ld = {
      '@type': 'LiveBlogPosting',
      articleBody: "Let's see what the critics had to say...",
      liveBlogUpdate: [
        { '@type': 'BlogPosting', author: { name: 'New York Stage Review - Frank Scheck' }, articleBody: 'a' },
        { '@type': 'BlogPosting', author: { name: 'New York Stage Review - David Finkle' }, articleBody: 'b' },
      ],
    };
    const html = `<html><body><script type="application/ld+json">${JSON.stringify(ld)}</script>
<p><a href="${SCHECK_URL}">New York Stage Review:</a> a</p>
<p><a href="${FINKLE_URL}">New York Stage Review:</a> b</p></body></html>`;
    const reviews = extractBWWRoundupReviews(html, 'test-show-2026', BWW_URL, 'Test Show');
    const scheck = reviews.find((r) => r.criticName === 'Frank Scheck');
    const finkle = reviews.find((r) => r.criticName === 'David Finkle');
    assert.strictEqual(scheck.url, SCHECK_URL);
    assert.strictEqual(finkle.url, FINKLE_URL);
  });
});
