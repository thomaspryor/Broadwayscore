// BRO-2560: test.yml's Data Validation job runs validate-show-venue.js with
// no Playwright browsers installed — every fetch logged "browserType.launch:
// Executable doesn't exist..." and the resulting fetch-error was
// indistinguishable from a real venue/date mismatch in the step's output.
// isPlaywrightMissingBrowserError() is the pure predicate validate-show-venue.js
// uses to tell "no browser in this environment" apart from a real scrape
// failure — locking in the regex here per CLAUDE.md §15 (extract pure
// decision functions, require() the real one, never re-copy the logic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isPlaywrightMissingBrowserError } = require('./scraper.js');

test('isPlaywrightMissingBrowserError: matches the real missing-executable launch error', () => {
  const msg = "browserType.launch: Executable doesn't exist at /home/runner/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell";
  assert.equal(isPlaywrightMissingBrowserError(msg), true);
});

test('isPlaywrightMissingBrowserError: matches the package-not-installed error (tells the operator to run playwright install)', () => {
  const msg = "Playwright fallback unavailable — playwright package not installed. Run `npm ci` (includes devDeps) or add `npx playwright install chromium`. Underlying: Cannot find module 'playwright'";
  assert.equal(isPlaywrightMissingBrowserError(msg), true);
});

test('isPlaywrightMissingBrowserError: does NOT match an unrelated browserType.launch failure (timeout/OOM/permission)', () => {
  // A bare `browserType\.launch` match previously false-positived on these —
  // a real environment problem, but not "no browser installed", and running
  // `npx playwright install` would not fix it (ship-check review finding).
  assert.equal(isPlaywrightMissingBrowserError('browserType.launch: Timeout 30000ms exceeded'), false);
  assert.equal(isPlaywrightMissingBrowserError('browserType.launch: spawn ENOMEM'), false);
  assert.equal(isPlaywrightMissingBrowserError('browserType.launch: Operation not permitted (sandbox)'), false);
});

test('isPlaywrightMissingBrowserError: does NOT match a real navigation/scrape failure', () => {
  assert.equal(isPlaywrightMissingBrowserError('net::ERR_CONNECTION_REFUSED at https://playbill.com/production/x'), false);
  assert.equal(isPlaywrightMissingBrowserError(''), false);
  assert.equal(isPlaywrightMissingBrowserError(undefined), false);
});
