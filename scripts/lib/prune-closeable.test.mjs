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

// ── Crown (owner-loop) tabs are never auto-closed — task #1751 ──────────────
// The reproducing incident: an owner session ran on Opus for 8 days titled
// "✅ 🤖🔮 Data·OWNER: drive the Linear migration to done — own, m" and was
// closeable that whole time, because bsc-next's buildAutoTitle had stamped the
// 🤖 on it. Both auto-dispatch signals said "worker"; only the missing 👑 in
// the owner's sidebar gave it away.

const { isCrownTab, CROWN_TAB_RE } = require('./prune-closeable.js');

test('isCrownTab: 👑 leading, with or without preceding glyphs', () => {
  assert.equal(isCrownTab('👑 OWNER — Linear migration to done (8/14)'), true);
  assert.equal(isCrownTab('✅ 👑 OWNER — land card #1889 Express retry merge'), true);
  assert.equal(isCrownTab('🧭 👑 OWNER — Notion→Linear cutover: Sprint 3 onward'), true);
  assert.equal(isCrownTab('❓ 👑 OWNER — BRO-343 P1 triage + dispatch crown loop v17'), true);
});

test('isCrownTab: a 👑 that is NOT the leading glyph does not crown the tab', () => {
  // Only a leading crown counts — otherwise any card whose SUBJECT merely
  // mentioned 👑 would silently opt itself out of the sweep forever.
  assert.equal(isCrownTab('🤖🔮 Data·rename the 👑 owner tabs'), false);
  assert.equal(isCrownTab('🤖⚡ Infra·bsc-prune fix'), false);
  assert.equal(isCrownTab(''), false);
  assert.equal(isCrownTab(undefined), false);
  assert.equal(isCrownTab(null), false);
});

test('isCloseable: crown tab is never closeable, even when BOTH auto-dispatch signals fire', () => {
  // The exact #1751 state: live claude, idle at the prompt, flagged
  // auto-dispatched. Pre-fix this returned true.
  assert.equal(isCloseable({
    hasLiveClaude: true,
    isAutoDispatched: true,
    isRunning: false,
    title: '👑 OWNER — Linear migration to done (8/14)',
  }), false);
  // …and still false when the process is fully dead, matching the owner rule
  // that non-worker tabs stay open for the owner to close by hand.
  assert.equal(isCloseable({
    hasLiveClaude: false,
    isAutoDispatched: true,
    title: '👑 OWNER — Linear migration to done (8/14)',
  }), false);
});

test('isCloseable: omitting title preserves pre-#1751 behaviour byte-for-byte', () => {
  // Every existing caller that does not thread a title must be unaffected.
  assert.equal(isCloseable({ hasLiveClaude: true, isAutoDispatched: true, isRunning: false }), true);
  assert.equal(isCloseable({ hasLiveClaude: true, isAutoDispatched: true, isRunning: true }), false);
  assert.equal(isCloseable({ hasLiveClaude: false, isAutoDispatched: true }), true);
  assert.equal(isCloseable({ hasLiveClaude: true, isAutoDispatched: false, isRunning: false }), false);
  // A non-crown title must not change any of those answers either — including
  // the incident's own title, which stays closeable by design.
  assert.equal(isCloseable({
    hasLiveClaude: true, isAutoDispatched: true, isRunning: false,
    title: '✅ 🤖🔮 Data·OWNER: drive the Linear migration to done — own, m',
  }), true);
});

test('CROWN_TAB_RE stays byte-identical to dispatch-watchdog-core.js', () => {
  // The dispatch layer is tier-"critical" (CLAUDE.md rule 18), so its private
  // copy cannot be collapsed into this export without a gated review. Until it
  // is, drift must FAIL A TEST rather than quietly split "crown tab" into two
  // different definitions — the watchdog treating a tab as a crown while the
  // sweep closes it is the #1751 failure with the roles swapped.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(import.meta.dirname, 'dispatch-watchdog-core.js'), 'utf8');
  const m = /^const CROWN_TAB_RE = (.+);$/m.exec(src);
  assert.ok(m, 'dispatch-watchdog-core.js no longer declares CROWN_TAB_RE — update this guard');
  assert.equal(m[1], String(CROWN_TAB_RE),
    'CROWN_TAB_RE drifted between prune-closeable.js and dispatch-watchdog-core.js');
});
