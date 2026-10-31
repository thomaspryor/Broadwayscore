/**
 * Talkin' Broadway byline extractor regression test.
 *
 * Balusters opening 2026-04-21: TB discovered the review at
 * https://www.talkinbroadway.com/page/world/TheBalusters.html but stored
 * criticName='Unknown'. The page byline is:
 *
 *   <p>Theatre Review by <a href="mailto:hmiller@talkinbroadway.com">Howard Miller</a> - April 21, 2026</p>
 *
 * None of the existing meta/JSON-LD/byline-class patterns in extractAuthorFromHtml
 * recognize this shape, so the extractor fell through to Unknown.
 *
 * Fix: add a TB-specific pattern to the bylinePatterns array that matches
 * "Theatre Review by [<a>]Name[</a>]".
 *
 * See memory/feedback_tb_mailto_byline.md.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');
const { extractAuthorFromHtml } = require(join(ROOT, 'scripts/lib/content-quality.js'));

describe("Talkin' Broadway byline extractor", () => {
  test('real Balusters fixture returns Howard Miller', () => {
    const html = readFileSync(
      join(ROOT, 'tests/fixtures/tb-balusters-byline.html'),
      'utf8'
    );
    assert.strictEqual(extractAuthorFromHtml(html, null), 'Howard Miller');
  });

  test('mailto anchor byline — two-word name', () => {
    const html = '<p>Theatre Review by <a href="mailto:foo@talkinbroadway.com">Matthew Murray</a> - April 1, 2025</p>';
    assert.strictEqual(extractAuthorFromHtml(html, null), 'Matthew Murray');
  });

  test('bio-link anchor byline (no mailto)', () => {
    const html = '<p>Theatre Review by <a href="/critics/kimberly-ramirez/">Kimberly Ramirez</a> - May 10, 2025</p>';
    assert.strictEqual(extractAuthorFromHtml(html, null), 'Kimberly Ramirez');
  });

  test('no-anchor fallback — plain text byline', () => {
    const html = '<p>Theatre Review by Howard Miller - April 21, 2026</p>';
    assert.strictEqual(extractAuthorFromHtml(html, null), 'Howard Miller');
  });

  test('three-part name captured', () => {
    const html = '<p>Theatre Review by <a href="mailto:x@y.com">Mary Jane Watson</a> - Date</p>';
    assert.strictEqual(extractAuthorFromHtml(html, null), 'Mary Jane Watson');
  });

  test('standard meta[name=author] still wins over TB pattern when present', () => {
    // Regression guard: the new pattern must not override higher-priority signals.
    const html = '<html><head><meta name="author" content="Allison Considine"></head>' +
      '<body><p>Theatre Review by <a href="mailto:x@y.com">Howard Miller</a> - Date</p></body></html>';
    assert.strictEqual(extractAuthorFromHtml(html, null), 'Allison Considine');
  });

  test('hyphenated surname (Mary-Louise Parker)', () => {
    const html = '<p>Theatre Review by <a href="mailto:x@y.com">Mary-Louise Parker</a> - Date</p>';
    assert.strictEqual(extractAuthorFromHtml(html, null), 'Mary-Louise Parker');
  });

  test("apostrophe surname ASCII (Sean O'Connor)", () => {
    const html = '<p>Theatre Review by <a href="mailto:x@y.com">Sean O\'Connor</a> - Date</p>';
    assert.strictEqual(extractAuthorFromHtml(html, null), "Sean O'Connor");
  });

  test('apostrophe surname curly (Sean O’Connor)', () => {
    const html = '<p>Theatre Review by <a href="mailto:x@y.com">Sean O’Connor</a> - Date</p>';
    assert.strictEqual(extractAuthorFromHtml(html, null), 'Sean O’Connor');
  });

  test('accented letters (Zoë Anderson)', () => {
    const html = '<p>Theatre Review by <a href="mailto:x@y.com">Zoë Anderson</a> - Date</p>';
    assert.strictEqual(extractAuthorFromHtml(html, null), 'Zoë Anderson');
  });

  test('lowercase "theatre review by" in body prose does NOT match (case-sensitive)', () => {
    // False-positive guard: a non-TB outlet quoting TB with lowercase "theatre
    // review by Ben Brantley" in prose should not leak a byline. Without the
    // case-sensitive anchor, /i would capture "Ben Brantley" here.
    const html = '<p>This is a theatre review by Ben Brantley of The New York Times.</p>';
    assert.strictEqual(extractAuthorFromHtml(html, null), null);
  });

  test('NEGATIVE REGRESSION: removing "Theatre Review by" prefix returns null', () => {
    // Motivation guard: proves the TB pattern is what catches the fixture. If
    // someone later deletes the TB pattern from bylinePatterns, the positive
    // tests might still pass via a different pattern. This strips the prefix
    // that only the TB pattern recognizes — any match means something else is
    // matching (and the Balusters fix isn't actually load-bearing).
    const html = '<p><a href="mailto:hmiller@talkinbroadway.com">Howard Miller</a> - April 21, 2026</p>';
    assert.strictEqual(extractAuthorFromHtml(html, null), null);
  });
});
