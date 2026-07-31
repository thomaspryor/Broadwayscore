import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isCloseable, hasAutoDispatchMarker, AUTO_GLYPH } = require('./prune-closeable.js');

test('hasAutoDispatchMarker: detects the 🤖 glyph anywhere in the title', () => {
  assert.equal(hasAutoDispatchMarker('✅ 🤖⚡ Infra·bsc-prune fix'), true);
  assert.equal(hasAutoDispatchMarker('✅ Redesign show pages'), false);
  assert.equal(hasAutoDispatchMarker(''), false);
  assert.equal(hasAutoDispatchMarker(undefined), false);
});

// Card #709 (owner-approved 2026-07-31): the four required cases.
test('isCloseable: ✅🤖 + idle-at-prompt (live claude, not running) => close', () => {
  assert.equal(isCloseable({
    title: `✅ ${AUTO_GLYPH}⚡ Infra·bsc-prune fix`,
    hasLiveClaude: true,
    isRunning: false,
  }), true);
});

test('isCloseable: ✅🤖 + mid-turn (live claude, running) => skip', () => {
  assert.equal(isCloseable({
    title: `✅ ${AUTO_GLYPH}⚡ Infra·bsc-prune fix`,
    hasLiveClaude: true,
    isRunning: true,
  }), false);
});

test('isCloseable: ✅ non-🤖 + idle claude => skip (owner-driven tabs stay protected)', () => {
  assert.equal(isCloseable({
    title: '✅ Redesign show pages',
    hasLiveClaude: true,
    isRunning: false,
  }), false);
});

test('isCloseable: ✅ + no claude at all => close, regardless of marker', () => {
  assert.equal(isCloseable({
    title: '✅ Redesign show pages',
    hasLiveClaude: false,
    isRunning: true, // must be ignored when hasLiveClaude is false
  }), true);
  assert.equal(isCloseable({
    title: `✅ ${AUTO_GLYPH}⚡ Infra·bsc-prune fix`,
    hasLiveClaude: false,
  }), true);
});
