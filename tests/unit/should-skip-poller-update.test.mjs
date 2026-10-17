/**
 * Regression: collect-review-texts.js used to write fullText:'' over an
 * existing non-empty value when its scraper tier returned nothing. The push-
 * action patch (commit 6c34f1ebf7) caught it at push time; this predicate
 * (used at the source in collect-review-texts.js updateReviewJson) stops the
 * bleed before the bad write happens.
 *
 * Joe Turner postmortem 2026-04-26 — A #1, A #16.
 *
 * Run: node --test tests/unit/should-skip-poller-update.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldSkipPollerUpdate } = require('../../scripts/lib/review-write-guard.js');

test('blocks: empty new text vs existing non-empty fullText', () => {
  const r = shouldSkipPollerUpdate({ fullText: 'A real review with content here' }, '');
  assert.equal(r.skip, true);
  assert.match(r.reason, /new text empty/);
});

test('blocks: whitespace-only new text vs existing non-empty fullText', () => {
  const r = shouldSkipPollerUpdate({ fullText: 'A real review' }, '   \n\t   ');
  assert.equal(r.skip, true);
  assert.match(r.reason, /new text empty/);
});

test('blocks: _locked=true even when new text non-empty', () => {
  const r = shouldSkipPollerUpdate(
    { fullText: 'Original pasted text', _locked: true },
    'Different freshly-scraped text'
  );
  assert.equal(r.skip, true);
  assert.match(r.reason, /_locked=true/);
});

test('blocks: manualContentTier=complete even when new text non-empty', () => {
  const r = shouldSkipPollerUpdate(
    { fullText: 'User-pasted full review', manualContentTier: 'complete' },
    'Different freshly-scraped text'
  );
  assert.equal(r.skip, true);
  assert.match(r.reason, /manualContentTier=complete/);
});

test('allows: new non-empty text vs existing empty fullText (initial collect)', () => {
  const r = shouldSkipPollerUpdate({ fullText: '' }, 'Freshly scraped review text');
  assert.equal(r.skip, false);
});

test('allows: new non-empty text vs missing fullText (stub file)', () => {
  const r = shouldSkipPollerUpdate({}, 'Freshly scraped review text');
  assert.equal(r.skip, false);
});

test('allows: new non-empty text vs existing non-empty (refresh)', () => {
  const r = shouldSkipPollerUpdate(
    { fullText: 'Old version of review' },
    'New version of review'
  );
  assert.equal(r.skip, false);
});

test('allows: empty new + empty existing (no-op stub)', () => {
  // No data to lose, no protection needed; caller can still write metadata fields.
  const r = shouldSkipPollerUpdate({ fullText: '' }, '');
  assert.equal(r.skip, false);
});

test('allows: _locked=true on a stub with empty fullText (initial pin)', () => {
  // A locked stub with no content yet should still accept the first real text.
  const r = shouldSkipPollerUpdate({ _locked: true, fullText: '' }, 'First scrape');
  assert.equal(r.skip, false);
});

test('allows: manualContentTier=complete on a stub with empty fullText', () => {
  const r = shouldSkipPollerUpdate(
    { manualContentTier: 'complete', fullText: '' },
    'First scrape'
  );
  assert.equal(r.skip, false);
});

test('handles null/undefined existingData defensively', () => {
  // Caller wraps in try/catch already, but this should not throw.
  assert.doesNotThrow(() => shouldSkipPollerUpdate(null, 'text'));
  assert.doesNotThrow(() => shouldSkipPollerUpdate(undefined, ''));
  const r1 = shouldSkipPollerUpdate(null, 'text');
  assert.equal(r1.skip, false);
  const r2 = shouldSkipPollerUpdate(undefined, '');
  assert.equal(r2.skip, false);
});

test('handles non-string fullText defensively (legacy data shapes)', () => {
  // Legacy files might carry fullText as null. Treat as empty.
  const r = shouldSkipPollerUpdate({ fullText: null }, 'New text');
  assert.equal(r.skip, false);
});

test('REGRESSION: pre-fix logic would let the empty-write through', () => {
  // The original code at line 4209 was an unconditional `data.fullText = cleanedText`.
  // That clobbered Culture Sauce 8000ch → 0ch on Joe Turner opening night.
  // Confirm the guard fires for that exact shape.
  const cultureSauceShape = {
    fullText: 'Greg Evans pieces about the Joe Turner Broadway revival, '.repeat(100),
    showId: 'joe-turners-come-and-gone-2026',
    outletId: 'culturesauce',
  };
  const r = shouldSkipPollerUpdate(cultureSauceShape, '');
  assert.equal(r.skip, true);
  assert.ok(/existing fullText is \d{3,}ch/.test(r.reason), `reason should report char count: ${r.reason}`);
});
