/**
 * Regression test for the original 404-as-review contamination (BRO-38).
 *
 * Bug: detectErrorPage (content-quality.js) only scanned the first 300 chars
 * of the body. A long nav-chrome/mega-menu prefix (Variety, AndyGram) pushed
 * the "404 Page Not Found" marker past that window, so the page was scored as
 * a real review (5 Variety T1 reviews + 1 AndyGram, 2026-06-01).
 *
 * Fix: STRONG_ERROR_PAGE_PATTERNS + detectStrongErrorPageAnywhere scan the
 * WHOLE body for unambiguous, position-independent error-page phrases ("page
 * not found", "404 error", "the page you're looking for") that never appear
 * in real review prose or footers, so no gating is needed (unlike the
 * cookie/legal/paywall STRONG_CHROME_DUMP_PATTERNS, which DO appear as
 * legitimate footer chrome and must be gated on no-substantial-content +
 * not-trailing-junk).
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
const { isGarbageContent, detectErrorPage, detectStrongErrorPageAnywhere } =
  require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'content-quality.js'));

// ~700 chars of mega-menu nav chrome — mimics the Variety/AndyGram prefix that
// pushed "404 Page Not Found" past detectErrorPage's original 300-char window.
const MEGA_MENU_PREFIX = 'Plus Icon Film TV Music Theater Awards Circuit Video Podcasts Newsletters Shop '.repeat(9);

test('404 marker buried past the 300-char window is flagged (original contamination case)', () => {
  const text = MEGA_MENU_PREFIX + '404 Page Not Found The page you were looking for cannot be found.';
  assert.ok(text.length > 300, 'fixture must exceed the original 300-char scan window');

  // The narrow, position-limited detector misses it — this is the original bug.
  const collapsed = text.replace(/\s+/g, ' ');
  const narrow = detectErrorPage(collapsed.length > 500 ? collapsed.substring(0, 300) : collapsed);
  assert.equal(narrow.detected, false, 'sanity check: narrow 300-char scan should miss the buried marker');

  // The whole-body strong scan catches it.
  const strong = detectStrongErrorPageAnywhere(collapsed);
  assert.equal(strong.detected, true, 'detectStrongErrorPageAnywhere should catch the buried 404 marker');

  // And the public entry point flags the page as garbage.
  const r = isGarbageContent(text);
  assert.equal(r.isGarbage, true, `expected garbage, got: ${r.reason}`);
});

test('FP guard: a real review is never flagged by the strong error-page scan', () => {
  const text = 'The revival is a triumph. The performance by the lead actor anchors a production whose staging, lighting and ensemble work all land. '.repeat(6);
  const r = isGarbageContent(text);
  assert.equal(r.isGarbage, false, `expected clean review to pass, got: ${r.reason}`);
});
