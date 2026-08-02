import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseRecheckAfter, parseRecheckAfterFromCard } = require('./recheck-stamp.js');

test('parseRecheckAfter reads a stamp as midnight UTC of that day', () => {
  assert.equal(parseRecheckAfter('RECHECK-AFTER: 2026-08-08'), Date.parse('2026-08-08T00:00:00Z'));
  assert.equal(parseRecheckAfter('recheck-after: 2026-08-08 (case-insensitive)'), Date.parse('2026-08-08T00:00:00Z'));
});

test('parseRecheckAfter returns null on missing or malformed stamps', () => {
  assert.equal(parseRecheckAfter('no stamp here'), null);
  assert.equal(parseRecheckAfter(''), null);
  assert.equal(parseRecheckAfter(null), null);
  assert.equal(parseRecheckAfter(undefined), null);
  assert.equal(parseRecheckAfter('RECHECK-AFTER: soon'), null);
});

test('parseRecheckAfterFromCard scans notes, then outcome, then name', () => {
  assert.equal(
    parseRecheckAfterFromCard({ notes: 'x', outcome: 'RECHECK-AFTER: 2026-08-03', name: 'y' }),
    Date.parse('2026-08-03T00:00:00Z'),
  );
  assert.equal(
    parseRecheckAfterFromCard({ name: 'watch until RECHECK-AFTER: 2026-08-04' }),
    Date.parse('2026-08-04T00:00:00Z'),
  );
});

test('notes stamp wins over a disagreeing outcome stamp', () => {
  assert.equal(
    parseRecheckAfterFromCard({ notes: 'RECHECK-AFTER: 2026-08-10', outcome: 'RECHECK-AFTER: 2026-08-01' }),
    Date.parse('2026-08-10T00:00:00Z'),
  );
});

test('parseRecheckAfterFromCard is null-safe', () => {
  assert.equal(parseRecheckAfterFromCard(null), null);
  assert.equal(parseRecheckAfterFromCard({}), null);
  assert.equal(parseRecheckAfterFromCard({ notes: null, outcome: undefined }), null);
});
