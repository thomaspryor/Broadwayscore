/**
 * BWW homepage scan + Cloudflare challenge detection tests.
 *
 * Regression coverage for the two Rocky Horror 2026-04-23 opening-night bugs:
 *
 *   Bug #2 — poller logged "No matching roundup link found on BWW homepage" even
 *   though a literal href to /article/Review-Roundup-THE-ROCKY-HORROR-SHOW-... was
 *   present in the homepage HTML. The old inline matcher in gather-reviews.js did
 *   work for canonical anchors but had no short-title fallback for subtitled shows
 *   and reported a generic "no match" message that hid what the homepage offered.
 *   Fix: extract to scripts/lib/bww-homepage-scan.js and reuse the shared
 *   validateBWWRoundupUrlMatchesShow (which owns short-title + tryout logic).
 *
 *   Bug #4 — BWW SERP fallback iterated 25+ URLs during a Cloudflare-gated window,
 *   burning ScrapingBee credits on pages that were all the same challenge HTML.
 *   Fix: expose isCloudflareChallenge() so the 3 BWW fetch loops in gather-reviews
 *   can short-circuit on the first challenge.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findBWWRoundupLinkOnHomepage, extractRoundupAnchors } = require('../../scripts/lib/bww-homepage-scan.js');
const { isCloudflareChallenge } = require('../../scripts/lib/bww-roundup-validator.js');

const silentLogger = { log: () => {} };

describe('extractRoundupAnchors', () => {
  test('pulls absolute https URLs with double quotes', () => {
    const html = `<a href="https://www.broadwayworld.com/article/Review-Roundup-TEST-20260101">x</a>`;
    assert.deepStrictEqual(
      extractRoundupAnchors(html),
      ['https://www.broadwayworld.com/article/Review-Roundup-TEST-20260101']
    );
  });

  test('pulls single-quoted hrefs', () => {
    const html = `<a href='https://www.broadwayworld.com/article/Review-Roundup-TEST-20260101'>x</a>`;
    assert.deepStrictEqual(
      extractRoundupAnchors(html),
      ['https://www.broadwayworld.com/article/Review-Roundup-TEST-20260101']
    );
  });

  test('upgrades root-relative hrefs to absolute www.broadwayworld.com URLs', () => {
    const html = `<a href="/article/Review-Roundup-TEST-20260101">x</a>`;
    assert.deepStrictEqual(
      extractRoundupAnchors(html),
      ['https://www.broadwayworld.com/article/Review-Roundup-TEST-20260101']
    );
  });

  test('handles london/ subpath', () => {
    const html = `<a href="https://www.broadwayworld.com/london/article/Review-Roundup-TEST-20260101">x</a>`;
    assert.deepStrictEqual(
      extractRoundupAnchors(html),
      ['https://www.broadwayworld.com/london/article/Review-Roundup-TEST-20260101']
    );
  });

  test('decodes &amp; in URLs', () => {
    const html = `<a href="https://www.broadwayworld.com/article/Review-Roundup-TEST-2025?x=1&amp;y=2">x</a>`;
    assert.deepStrictEqual(
      extractRoundupAnchors(html),
      ['https://www.broadwayworld.com/article/Review-Roundup-TEST-2025?x=1&y=2']
    );
  });

  test('returns [] for empty HTML', () => {
    assert.deepStrictEqual(extractRoundupAnchors(''), []);
    assert.deepStrictEqual(extractRoundupAnchors(null), []);
    assert.deepStrictEqual(extractRoundupAnchors(undefined), []);
  });

  test('dedupes identical URLs', () => {
    const html = `<a href="https://www.broadwayworld.com/article/Review-Roundup-A-20260101">1</a><a href="https://www.broadwayworld.com/article/Review-Roundup-A-20260101">2</a>`;
    assert.strictEqual(extractRoundupAnchors(html).length, 1);
  });
});

describe('findBWWRoundupLinkOnHomepage — Rocky Horror regression', () => {
  test('returns the Rocky Horror URL when the canonical anchor is present', () => {
    // Exact bug: poller said "No matching roundup link found on BWW homepage"
    // while this href was present in plain HTML.
    const html = `
      <div>
        <a href="https://www.broadwayworld.com/article/Review-Roundup-THE-ROCKY-HORROR-SHOW-Returns-to-Broadway-20260423">
          Review Roundup: THE ROCKY HORROR SHOW Returns to Broadway
        </a>
      </div>`;
    assert.strictEqual(
      findBWWRoundupLinkOnHomepage(html, 'The Rocky Horror Show', { logger: silentLogger }),
      'https://www.broadwayworld.com/article/Review-Roundup-THE-ROCKY-HORROR-SHOW-Returns-to-Broadway-20260423'
    );
  });

  test('matches a root-relative href to the Rocky Horror roundup', () => {
    const html = `<a href="/article/Review-Roundup-THE-ROCKY-HORROR-SHOW-Returns-to-Broadway-20260423">x</a>`;
    assert.strictEqual(
      findBWWRoundupLinkOnHomepage(html, 'The Rocky Horror Show', { logger: silentLogger }),
      'https://www.broadwayworld.com/article/Review-Roundup-THE-ROCKY-HORROR-SHOW-Returns-to-Broadway-20260423'
    );
  });
});

describe('findBWWRoundupLinkOnHomepage — Beaches (subtitled) regression', () => {
  test('accepts Beaches short-title slug when show title has subtitle', () => {
    // The old inline matcher rejected this because "new" and "musical" (from
    // "Beaches, A New Musical") are absent from the slug. The shared validator
    // now falls back to the comma-short-title. Prior to this ship: 0 of 22
    // Beaches opening-night poller runs auto-matched the BWW RR homepage anchor.
    const html = `<a href="https://www.broadwayworld.com/article/Review-Roundup-BEACHES-Opens-on-Broadway-20260422">x</a>`;
    assert.strictEqual(
      findBWWRoundupLinkOnHomepage(html, 'Beaches, A New Musical', { logger: silentLogger }),
      'https://www.broadwayworld.com/article/Review-Roundup-BEACHES-Opens-on-Broadway-20260422'
    );
  });
});

describe('findBWWRoundupLinkOnHomepage — no-match behavior', () => {
  test('returns null when no Review-Roundup anchors exist', () => {
    assert.strictEqual(
      findBWWRoundupLinkOnHomepage('<div>homepage has no roundups today</div>', 'Test Show', { logger: silentLogger }),
      null
    );
  });

  test('returns null and logs diagnostic when anchors exist but none match', () => {
    const logs = [];
    const logger = { log: (msg) => logs.push(msg) };
    const html = `
      <a href="https://www.broadwayworld.com/article/Review-Roundup-HAMILTON-Returns-20260501">1</a>
      <a href="https://www.broadwayworld.com/article/Review-Roundup-WICKED-Returns-20260501">2</a>
    `;
    const result = findBWWRoundupLinkOnHomepage(html, 'Beaches, A New Musical', { logger });
    assert.strictEqual(result, null);
    assert.strictEqual(logs.length, 1);
    assert.match(logs[0], /2 Review-Roundup anchor/);
    assert.match(logs[0], /"Beaches, A New Musical"/);
    // Sample should show the slugs so opening-night sessions can see what BWW offered.
    assert.match(logs[0], /HAMILTON-Returns-20260501/);
  });

  test('rejects tryout URLs via shared validator (Kennedy Center pre-Broadway markers)', () => {
    const html = `<a href="https://www.broadwayworld.com/washington-dc/article/Review-Roundup-TEST-Kennedy-Center-20260101">x</a>`;
    assert.strictEqual(
      findBWWRoundupLinkOnHomepage(html, 'Test', { logger: silentLogger }),
      null
    );
  });

  test('returns null when showTitle is missing', () => {
    const html = `<a href="https://www.broadwayworld.com/article/Review-Roundup-X-20260101">x</a>`;
    assert.strictEqual(findBWWRoundupLinkOnHomepage(html, null, { logger: silentLogger }), null);
    assert.strictEqual(findBWWRoundupLinkOnHomepage(html, '', { logger: silentLogger }), null);
  });
});

describe('isCloudflareChallenge', () => {
  test('detects "Just a moment..." title (weak marker, size-gated)', () => {
    const html = '<html><head><title>Just a moment...</title></head><body>cf_chl_opt</body></html>';
    assert.strictEqual(isCloudflareChallenge(html), true);
  });

  test('detects cf_chl_opt marker at small size', () => {
    const html = '<html><body><script>window.cf_chl_opt = { something: 1 }</script></body></html>';
    assert.strictEqual(isCloudflareChallenge(html), true);
  });

  test('detects challenge-platform marker at small size', () => {
    const html = '<html><body><div id="challenge-platform"></div></body></html>';
    assert.strictEqual(isCloudflareChallenge(html), true);
  });

  test('detects "Enable JavaScript and cookies" banner', () => {
    const html = '<html><body>Enable JavaScript and cookies to continue</body></html>';
    assert.strictEqual(isCloudflareChallenge(html), true);
  });

  test('detects JS-heavy managed-challenge variant (50KB with BOTH strong markers)', () => {
    // Cloudflare's Turnstile managed-challenge can reach 40-60KB with telemetry payload.
    // Both strong markers together — trusted regardless of size.
    const html = '<html><body>' + 'x'.repeat(50000) + 'cf_chl_opt challenge-platform</body></html>';
    assert.strictEqual(html.length > 25000, true, 'precondition: html is >25KB');
    assert.strictEqual(isCloudflareChallenge(html), true);
  });

  test('detects legacy meta-refresh challenge variant (no cf_chl_opt)', () => {
    const html = '<html><head><meta http-equiv="refresh" content="5; url=https://example.com/cf-chl-bypass"></head><body></body></html>';
    assert.strictEqual(isCloudflareChallenge(html), true);
  });

  test('returns false for a normal full-length BWW roundup with no challenge markers', () => {
    // Real roundup articles are 100KB+ with NO Cloudflare markers.
    const html = '<html><head><title>Review Roundup: TEST</title></head><body>' +
      'articleBody '.repeat(10000) + 'Just a moment appearing in quoted text is fine.' +
      '</body></html>';
    assert.strictEqual(html.length > 100000, true, 'precondition: html is >100KB');
    assert.strictEqual(isCloudflareChallenge(html), false);
  });

  test('returns false when a large page contains weak marker but no strong marker', () => {
    // 30KB page (above weak-marker 25KB gate) with only "Just a moment" in body.
    const html = '<html><head><title>Some Real Article</title></head><body>' +
      'x'.repeat(30000) + ' the phrase Just a moment is in the body text' +
      '</body></html>';
    assert.strictEqual(isCloudflareChallenge(html), false);
  });

  test('returns true for a tiny page where a weak marker appears in the title', () => {
    // 2KB page with "Just a moment" in title — this IS a challenge.
    const html = '<html><head><title>Just a moment...</title></head><body>' +
      'Please wait while we check your browser.</body></html>';
    assert.strictEqual(isCloudflareChallenge(html), true);
  });

  test('returns false for empty / non-string input', () => {
    assert.strictEqual(isCloudflareChallenge(''), false);
    assert.strictEqual(isCloudflareChallenge(null), false);
    assert.strictEqual(isCloudflareChallenge(undefined), false);
    assert.strictEqual(isCloudflareChallenge(12345), false);
  });

  test('returns false for a short non-challenge page', () => {
    const html = '<html><head><title>404 Not Found</title></head><body>Sorry</body></html>';
    assert.strictEqual(isCloudflareChallenge(html), false);
  });
});
