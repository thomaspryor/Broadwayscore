import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isReclaimable } = require('../../scripts/lib/prune-dead-autodispatch-tabs.js');

// BRO-2586 acceptance criteria, verbatim: reclaimable only when BOTH
// auto-dispatched (robot-marker title) AND no live claude process; an owner
// tab, a selected tab, and any live-process tab are never reclaimable.

test('auto-dispatched + dead (no live claude) => reclaimable', () => {
  assert.equal(isReclaimable({
    title: '🤖⚡ Data·BRO-1234 some task',
    selected: false,
    hasLiveClaude: false,
    isAutoDispatched: true,
  }), true);
});

test('owner tab (not auto-dispatched) + dead => never reclaimable', () => {
  assert.equal(isReclaimable({
    title: 'Investigating flaky test',
    selected: false,
    hasLiveClaude: false,
    isAutoDispatched: false,
  }), false);
});

test('selected tab + auto-dispatched + dead => never reclaimable', () => {
  assert.equal(isReclaimable({
    title: '🤖⚡ Data·BRO-1234 some task',
    selected: true,
    hasLiveClaude: false,
    isAutoDispatched: true,
  }), false);
});

test('live-process tab + auto-dispatched => never reclaimable', () => {
  assert.equal(isReclaimable({
    title: '🤖⚡ Data·BRO-1234 some task',
    selected: false,
    hasLiveClaude: true,
    isAutoDispatched: true,
  }), false);
});

// Defense-in-depth parity with prune-closeable.test.mjs's own crown coverage
// (task #1751): a crowned owner-loop tab must never be reclaimed even if it
// somehow carries a 🤖 marker and reads as dead.
test('crown tab + auto-dispatched + dead => never reclaimable', () => {
  assert.equal(isReclaimable({
    title: '✅ 👑 OWNER — drive the Linear migration to done',
    selected: false,
    hasLiveClaude: false,
    isAutoDispatched: true,
  }), false);
});

test('owner tab + selected + live claude (all guards absent at once) => never reclaimable', () => {
  assert.equal(isReclaimable({
    title: 'Reviewing something',
    selected: true,
    hasLiveClaude: true,
    isAutoDispatched: false,
  }), false);
});
