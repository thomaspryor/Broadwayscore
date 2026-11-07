import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isBandAnchored } = require('./band-anchored.js');

test('anchored-v6 scoreSource is band-anchored', () => {
  assert.equal(isBandAnchored({ scoreSource: 'anchored-v6', llmScore: { score: 92 } }), true);
});

test('a stored band is band-anchored even without the scoreSource stamp', () => {
  assert.equal(isBandAnchored({ llmScore: { score: 90, band: { floor: 89, ceiling: 94, fraction: 0.2 } } }), true);
});

test('plain llm-v6 and malformed records are not', () => {
  assert.equal(isBandAnchored({ scoreSource: 'llm-v6', llmScore: { score: 81 } }), false);
  assert.equal(isBandAnchored({ llmScore: { score: 81, band: { floor: null } } }), false);
  assert.equal(isBandAnchored(null), false);
});
