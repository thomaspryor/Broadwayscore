/**
 * Unit tests for scripts/lib/serp-unavailable-strikes.js (BRO-6492).
 * Run: node --test scripts/lib/serp-unavailable-strikes.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSerpUnavailableStrikes, DEFAULT_MAX_STRIKES, resolveMaxStrikes } = require('./serp-unavailable-strikes.js');

test('one or two unavailable outlets do not abort; the third in a row does', () => {
  const s = createSerpUnavailableStrikes();
  assert.equal(DEFAULT_MAX_STRIKES, 3);
  assert.deepEqual(s.note(true), { abort: false, strikes: 1 });
  assert.deepEqual(s.note(true), { abort: false, strikes: 2 });
  assert.deepEqual(s.note(true), { abort: true, strikes: 3 });
});

test('any answered query resets the count', () => {
  const s = createSerpUnavailableStrikes();
  s.note(true); s.note(true);
  assert.deepEqual(s.note(false), { abort: false, strikes: 0 });
  assert.equal(s.note(true).abort, false);
});

test('max 1 restores the old abort-on-first behaviour', () => {
  assert.equal(createSerpUnavailableStrikes(1).note(true).abort, true);
});

test('SERP_UNAVAILABLE_MAX_STRIKES overrides the default; junk falls back', () => {
  assert.equal(resolveMaxStrikes({}), 3);
  assert.equal(resolveMaxStrikes({ SERP_UNAVAILABLE_MAX_STRIKES: '10' }), 10);
  assert.equal(resolveMaxStrikes({ SERP_UNAVAILABLE_MAX_STRIKES: '0' }), 3);
  assert.equal(resolveMaxStrikes({ SERP_UNAVAILABLE_MAX_STRIKES: 'x' }), 3);
});
