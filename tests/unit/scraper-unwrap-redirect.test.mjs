/**
 * Guards scraper.js `unwrapRedirectUrl`, which strips Google redirect wrappers
 * (`https://www.google.com/url?q=<real>&sa=D&source=editors&...`) before fetch.
 *
 * Rationale: such wrappers entered the corpus when review URLs were scraped from
 * Google Docs/Sheets/editors exports or SERP links that escaped the discovery-time
 * unwrap in url-discovery.js. Fetching the wrapper returns Google chrome, not the
 * article, so the review was silently dropped as scraper_garbage (e.g.
 * grace-pervades / The Stage, 2026-06). fetchPage now unwraps at entry; this test
 * freezes that contract and the idempotent no-op behaviour for normal URLs.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { unwrapRedirectUrl } = require('../../scripts/lib/scraper.js');

describe('unwrapRedirectUrl', () => {
  test('unwraps a Google editors redirect to the real article URL', () => {
    const wrapped =
      'https://www.google.com/url?q=https://www.thestage.co.uk/reviews/grace-pervades-review-haymarket-theatre-london&sa=D&source=editors&ust=1778165044643693&usg=AOvVaw2I';
    assert.equal(
      unwrapRedirectUrl(wrapped),
      'https://www.thestage.co.uk/reviews/grace-pervades-review-haymarket-theatre-london'
    );
  });

  test('handles the ?url= variant', () => {
    const wrapped = 'https://google.com/url?url=https://example.com/review&sa=D';
    assert.equal(unwrapRedirectUrl(wrapped), 'https://example.com/review');
  });

  test('is a no-op for a normal article URL', () => {
    const url = 'https://www.thetimes.com/culture/theatre-dance/article/equus-review-j8sgls0w3';
    assert.equal(unwrapRedirectUrl(url), url);
  });

  test('is idempotent (already-unwrapped stays unwrapped)', () => {
    const url = 'https://www.theguardian.com/stage/2026/jun/18/glengarry-glen-ross-review';
    assert.equal(unwrapRedirectUrl(unwrapRedirectUrl(url)), url);
  });

  test('returns input unchanged when target is missing or malformed', () => {
    assert.equal(unwrapRedirectUrl('https://www.google.com/url?sa=D&ust=123'),
      'https://www.google.com/url?sa=D&ust=123');
    assert.equal(unwrapRedirectUrl('not a url'), 'not a url');
    assert.equal(unwrapRedirectUrl(null), null);
  });

  test('does not unwrap a real google.com article path (only /url? wrappers)', () => {
    const url = 'https://www.google.com/about/theater';
    assert.equal(unwrapRedirectUrl(url), url);
  });
});
