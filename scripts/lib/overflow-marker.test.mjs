import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { OVERFLOW_NOTE, OVERFLOW_MARKER_SUBSTR, hasOverflowMarker, cardHasOverflow } = require('./overflow-marker.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('the marker substring is a prefix of the note notion-brain actually writes', () => {
  assert.ok(OVERFLOW_NOTE.includes(OVERFLOW_MARKER_SUBSTR),
    'detector must match what the producer emits, or truncation goes unnoticed');
});

// The point of this module: notion-brain.js is a CLI (no exports, exits at
// load without NOTION_API_KEY), so nothing can require it to learn the
// marker. If it ever went back to defining its own copy, a wording change on
// the write side would silently stop every reader from noticing truncation —
// which is exactly the failure that hid 14 truncated cards from the nightly
// acceptance recheck.
test('notion-brain.js imports the marker rather than redeclaring it', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'notion-brain.js'), 'utf8');
  // Extension optional: this repo writes both `require('./lib/x')` and
  // `require('./lib/x.js')`, and normalising notion-brain.js to the other
  // form must not redden CI.
  assert.match(src, /require\('\.\/lib\/overflow-marker(\.js)?'\)/, 'notion-brain must import the shared marker');
  assert.doesNotMatch(src, /const OVERFLOW_MARKER_SUBSTR\s*=/, 'no second definition of the marker');
  assert.doesNotMatch(src, /const OVERFLOW_NOTE\s*=/, 'no second definition of the note');
});

test('hasOverflowMarker spots a truncated preview and is null-safe', () => {
  assert.equal(hasOverflowMarker('short notes'), false);
  assert.equal(hasOverflowMarker('long notes' + OVERFLOW_NOTE), true);
  assert.equal(hasOverflowMarker(''), false);
  assert.equal(hasOverflowMarker(null), false);
  assert.equal(hasOverflowMarker(undefined), false);
});

test('cardHasOverflow checks every long-text field, not just notes', () => {
  assert.equal(cardHasOverflow({ notes: 'a' + OVERFLOW_NOTE }), true);
  assert.equal(cardHasOverflow({ outcome: 'a' + OVERFLOW_NOTE }), true);
  assert.equal(cardHasOverflow({ keyFiles: 'a' + OVERFLOW_NOTE }), true);
  assert.equal(cardHasOverflow({ notes: 'a', outcome: 'b', keyFiles: 'c' }), false);
  assert.equal(cardHasOverflow({}), false);
  assert.equal(cardHasOverflow(null), false);
});

// Matching on the stable prefix, not the whole note: the trailing arrow is
// decoration and cards written under an older arrow/spacing must still be
// recognised as truncated.
test('a card written with an older arrow variant is still detected', () => {
  assert.equal(hasOverflowMarker('notes\n\n[Full content in page body below]'), true);
  assert.equal(hasOverflowMarker('notes\n\n[Full content in page body below v]'), true);
});
