/**
 * Regression tests for Lost Boys 2026-04-26 Issue #11.
 *
 * The byline parser captured three malformed names across one opening night:
 *   - Variety: "Frank Rizzo\n\nPlus Icon" (SVG button text bled into capture)
 *   - NY Sun: "ELYSA GARDNER" (page byline rendered all-caps)
 *   - Cititour: "Scott Lipton" (truncated — under-capture, NOT recoverable here)
 *
 * normalizeBylineCapture() owns the post-extraction cleanup for the first two.
 * The third is upstream of the regex's capture group — confirm we don't make
 * it worse.
 *
 * Run: node --test tests/unit/byline-normalization.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeBylineCapture } = require('../../scripts/lib/byline-normalization.js');

test('strips trailing "Plus Icon" SVG token (Variety, Lost Boys 2026-04-26)', () => {
  assert.equal(normalizeBylineCapture('Frank Rizzo\n\nPlus Icon'), 'Frank Rizzo');
  assert.equal(normalizeBylineCapture('Frank Rizzo Plus Icon'), 'Frank Rizzo');
});

test('strips trailing share/social tokens', () => {
  assert.equal(normalizeBylineCapture('Helen Shaw Share'), 'Helen Shaw');
  assert.equal(normalizeBylineCapture('Helen Shaw\nCopy Link'), 'Helen Shaw');
  assert.equal(normalizeBylineCapture('Helen Shaw Twitter Facebook Email'), 'Helen Shaw');
  assert.equal(normalizeBylineCapture('Helen Shaw — Comments'), 'Helen Shaw');
});

test('title-cases ALL-CAPS names (NY Sun, Lost Boys 2026-04-26)', () => {
  assert.equal(normalizeBylineCapture('ELYSA GARDNER'), 'Elysa Gardner');
  assert.equal(normalizeBylineCapture('JOHNNY OLEKSINSKI'), 'Johnny Oleksinski');
  assert.equal(normalizeBylineCapture('SARA HOLDREN'), 'Sara Holdren');
});

test('preserves mixed-case names (no all-caps trip)', () => {
  assert.equal(normalizeBylineCapture('Helen Shaw'), 'Helen Shaw');
  assert.equal(normalizeBylineCapture("O'Brien"), "O'Brien");
  assert.equal(normalizeBylineCapture('Adam McKnight'), 'Adam McKnight');
});

test('preserves accented + punctuated names', () => {
  assert.equal(normalizeBylineCapture('Frank Scheck'), 'Frank Scheck');
  assert.equal(normalizeBylineCapture('David Cote'), 'David Cote');
  assert.equal(normalizeBylineCapture("Sara O'Brien"), "Sara O'Brien");
});

test('handles edge cases: empty, whitespace, single word', () => {
  assert.equal(normalizeBylineCapture(''), '');
  assert.equal(normalizeBylineCapture('   '), '');
  assert.equal(normalizeBylineCapture('Helen'), 'Helen');
  assert.equal(normalizeBylineCapture('HELEN'), 'Helen');
});

test('does not over-trim names containing share-like substrings', () => {
  // "Saver" should not match "Save" (word boundary matters)
  assert.equal(normalizeBylineCapture('Hannah Saver'), 'Hannah Saver');
  // Real critic with "Print" in their last name (hypothetical)
  assert.equal(normalizeBylineCapture('Mary Printon'), 'Mary Printon');
});

test('combines title-casing + chrome stripping', () => {
  assert.equal(normalizeBylineCapture('ELYSA GARDNER Share'), 'Elysa Gardner');
  assert.equal(normalizeBylineCapture('FRANK RIZZO\n\nPlus Icon'), 'Frank Rizzo');
});

test('returns falsy input unchanged', () => {
  assert.equal(normalizeBylineCapture(null), null);
  assert.equal(normalizeBylineCapture(undefined), undefined);
});
