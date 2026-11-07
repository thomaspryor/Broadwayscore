/**
 * Unit tests for scripts/lib/paywall-detector.js.
 * Per CLAUDE.md §15: require() the real function — never duplicate its logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { detectHardPaywall } = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'paywall-detector.js'));

test('clean review body: not detected', () => {
  const text = 'Steven Spielberg directs a bold revival of West Side Story. The cast is uniformly exceptional...';
  assert.equal(detectHardPaywall(text).detected, false);
});

test('"Subscribe to continue" at start: detected', () => {
  const r = detectHardPaywall('Subscribe to continue reading this article.');
  assert.equal(r.detected, true);
  assert.equal(r.reason, 'paywall-start-marker');
});

test('"Sign in to read" at start: detected', () => {
  const r = detectHardPaywall('Sign in to read the full review.');
  assert.equal(r.detected, true);
});

test('"Already a subscriber?" at start (case-insensitive): detected', () => {
  const r = detectHardPaywall('already a subscriber? Sign In.');
  assert.equal(r.detected, true);
});

test('paywall phrase in middle of text: NOT detected', () => {
  const body = 'This was a rave reviewed play. I subscribed to the show. The Washington Post said it was great.';
  assert.equal(detectHardPaywall(body).detected, false);
});

test('outlet-specific WSJ marker in first 600 chars: detected', () => {
  const text = 'A gripping production of Glengarry Glen Ross... Already a subscriber? Sign In to read.';
  const r = detectHardPaywall(text, 'https://www.wsj.com/articles/test');
  assert.equal(r.detected, true);
  assert.match(r.reason, /paywall-outlet-marker:wsj\.com/);
});

test('outlet marker beyond 600 chars: NOT detected', () => {
  const filler = 'Body text. '.repeat(100); // ~1000 chars
  const text = filler + 'Already a subscriber? Sign In';
  const r = detectHardPaywall(text, 'wsj.com');
  assert.equal(r.detected, false);
});

test('extracts domain from full URL', () => {
  const r = detectHardPaywall('Subscribe to continue reading', 'https://www.wsj.com/articles/foo');
  assert.equal(r.detected, true);
});

test('accepts bare domain', () => {
  const r = detectHardPaywall('Create your free account', 'nytimes.com');
  assert.equal(r.detected, true);
});

test('empty / null text: not detected', () => {
  assert.equal(detectHardPaywall('').detected, false);
  assert.equal(detectHardPaywall(null).detected, false);
  assert.equal(detectHardPaywall(undefined).detected, false);
});

test('mid-paragraph "to read the full article" at start: detected', () => {
  const r = detectHardPaywall('To read the full article, please subscribe.');
  assert.equal(r.detected, true);
});

test('real WSJ short-but-legitimate review excerpt: NOT detected', () => {
  // Representative of the 300+ "truncated" WSJ files that are actually fine.
  const text = 'ShareResizeKaren Ziemba, Emily Skinner, Chuck Cooper, and Tony Yazbeck in a scene from "Follies" in "Prince of Broadway" Matthew MurphyNew York Anyone with a more than casual interest in theater needs no introduction to Harold Prince.';
  assert.equal(detectHardPaywall(text, 'wsj.com').detected, false);
});
