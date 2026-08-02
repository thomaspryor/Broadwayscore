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
    hasLiveClaude: true,
    isAutoDispatched: true,
    isRunning: false,
  }), true);
});

test('isCloseable: ✅🤖 + mid-turn (live claude, running) => skip', () => {
  assert.equal(isCloseable({
    hasLiveClaude: true,
    isAutoDispatched: true,
    isRunning: true,
  }), false);
});

// Owner rule #3 (2026-08-02, supersedes same-day escalation #2): auto-close
// is limited to 🤖 auto-dispatched tabs — owner-opened ✅ tabs never close
// autonomously, even with a fully dead claude.
test('isCloseable: ✅ non-🤖 + idle claude => skip (owner rule 2026-08-02: 🤖-only)', () => {
  assert.equal(isCloseable({
    hasLiveClaude: true,
    isAutoDispatched: false,
    isRunning: false,
  }), false);
});

test('isCloseable: ✅ non-🤖 + mid-turn => skip', () => {
  assert.equal(isCloseable({
    hasLiveClaude: true,
    isAutoDispatched: false,
    isRunning: true,
  }), false);
});

test('isCloseable: ✅ non-🤖 + no claude at all => still skip (owner-opened tabs are hands-off)', () => {
  assert.equal(isCloseable({
    hasLiveClaude: false,
    isAutoDispatched: false,
    isRunning: true, // must be ignored when hasLiveClaude is false
  }), false);
});

test('isCloseable: ✅🤖 + no claude at all => close', () => {
  assert.equal(isCloseable({
    hasLiveClaude: false,
    isAutoDispatched: true,
  }), true);
});
