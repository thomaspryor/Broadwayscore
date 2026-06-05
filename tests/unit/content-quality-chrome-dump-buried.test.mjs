/**
 * Regression test for buried chrome-dump detection (content-quality.js).
 *
 * Bug class: detectCookieConsent scans only the first 500 chars (content-quality.js
 * ~line 271) and the legal no-review branch (~line 845) re-checks only the first
 * 500 chars of long texts. A long nav-chrome prefix can push a cookie/legal/paywall
 * marker PAST that window on a page that is ENTIRELY chrome (no review prose), so the
 * dump reaches scoring. This is the same failure mode the 404 STRONG_ERROR_PAGE scan
 * fixed for error pages.
 *
 * Fix: detectStrongChromeDumpAnywhere scans the whole body for unambiguous full-page
 * chrome markers, but is consulted ONLY when there is no substantial review content
 * AND the marker is not trailing junk — so a footer banner on a real review is never
 * flagged (those phrases legitimately appear as footers on hundreds of real reviews).
 *
 * Per CLAUDE.md §15: require() the real function; never duplicate logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { isGarbageContent, detectStrongChromeDumpAnywhere, STRONG_CHROME_DUMP_PATTERNS } =
  require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'content-quality.js'));

// ~720 chars of nav chrome with ZERO theater keywords — mimics a real mega-menu
// prefix that pushes the distinctive marker past the 500-char detection windows.
const NAV_PREFIX = 'Latest News Reviews Interviews Features Galleries Subscribe Account Sign In Region UK US AU '.repeat(8);
const NAV_SUFFIX = 'Follow us Facebook Twitter Instagram YouTube Newsletter App Store Google Play '.repeat(6);

test('buried cookie-consent marker past the 500-char window is flagged', () => {
  const text = NAV_PREFIX + ' We use cookies. Your consent will be valid across the group. ' + NAV_SUFFIX;
  const r = isGarbageContent(text);
  assert.equal(r.isGarbage, true, `expected garbage, got: ${r.reason}`);
});

test('buried consent-management-platform marker is flagged', () => {
  const text = NAV_PREFIX + ' This site uses a consent management platform to store choices. ' + NAV_SUFFIX;
  const r = isGarbageContent(text);
  assert.equal(r.isGarbage, true, `expected garbage, got: ${r.reason}`);
});

test('buried dedicated-legal-page title (Copyright Notice) is flagged', () => {
  const text = NAV_PREFIX + '\nCopyright Notice\nAll material is owned by the publisher. ' + NAV_SUFFIX;
  const r = isGarbageContent(text);
  assert.equal(r.isGarbage, true, `expected garbage, got: ${r.reason}`);
});

test('FP guard: a real review with a trailing cookie footer is NOT flagged', () => {
  // Real review prose (>=3 theater keywords) with the cookie marker as trailing
  // footer chrome — must pass, mirroring hundreds of real WSJ/TimeOut/The Stage scrapes.
  const text = 'A dazzling Broadway musical. The cast, director and orchestra shine; the audience gave a standing ovation at curtain. '.repeat(6)
    + ' Manage your cookie preferences. ' + NAV_SUFFIX;
  const r = isGarbageContent(text);
  assert.equal(r.isGarbage, false, `expected real review to pass, got flagged: ${r.reason}`);
});

test('FP guard: real review with no chrome marker is unaffected', () => {
  const text = 'The revival is a triumph. The performance by the lead actor anchors a production whose staging, lighting and ensemble work all land. '.repeat(6);
  const r = isGarbageContent(text);
  assert.equal(r.isGarbage, false, `expected clean review to pass, got: ${r.reason}`);
});

test('detectStrongChromeDumpAnywhere matches unambiguous markers position-independently', () => {
  const longPrefix = 'x'.repeat(2000);
  assert.equal(detectStrongChromeDumpAnywhere(longPrefix + ' your consent will be valid').detected, true);
  assert.equal(detectStrongChromeDumpAnywhere(longPrefix + ' subscribe to continue').detected, true);
  // Plain review prose must not match any strong marker.
  assert.equal(detectStrongChromeDumpAnywhere('The musical was a delight from curtain to curtain.').detected, false);
});

test('STRONG_CHROME_DUMP_PATTERNS is a non-empty exported RegExp array', () => {
  assert.ok(Array.isArray(STRONG_CHROME_DUMP_PATTERNS) && STRONG_CHROME_DUMP_PATTERNS.length > 0);
  assert.ok(STRONG_CHROME_DUMP_PATTERNS.every(p => p instanceof RegExp));
});
