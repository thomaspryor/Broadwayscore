import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { isWatchdogParkedMirrorTracker } = require('../lib/digest-autofix-mirror-park-guard.js');
const { planAutofix } = require('../lib/digest-autofix.js');

test('isWatchdogParkedMirrorTracker: true for a bare-numeric (frozen Notion mirror) parked title', () => {
  assert.equal(isWatchdogParkedMirrorTracker('Watchdog parked #1234 after 3 dead dispatch attempts'), true);
  assert.equal(isWatchdogParkedMirrorTracker('Watchdog parked #1234 — redispatch never produced a launch'), true);
  assert.equal(isWatchdogParkedMirrorTracker('Watchdog parked #1234 — dispatch guard refuses by construction'), true);
});

test('isWatchdogParkedMirrorTracker: false for a linear: parked title (live board, must keep filing)', () => {
  assert.equal(isWatchdogParkedMirrorTracker('Watchdog parked #linear:BRO-91 — dispatch guard refuses by construction'), false);
});

// BRO-3923 ship-check finding: prefer the stable conditionKey over the title
// text — a later wording/punctuation edit to the pageOwner() title must not
// silently reopen the filing hole.
test('isWatchdogParkedMirrorTracker: conditionKey wins even if the title text has drifted', () => {
  assert.equal(isWatchdogParkedMirrorTracker('A totally reworded parked message', 'watchdog-park:1234'), true);
  assert.equal(isWatchdogParkedMirrorTracker('A totally reworded parked message', 'watchdog-park:linear:BRO-91'), false);
});

test('isWatchdogParkedMirrorTracker: falls back to the title when conditionKey is absent (health.errors/warns rows)', () => {
  assert.equal(isWatchdogParkedMirrorTracker('Watchdog parked #1234 after 3 dead dispatch attempts', null), true);
  assert.equal(isWatchdogParkedMirrorTracker('Watchdog parked #linear:BRO-91 — dispatch guard refuses by construction', undefined), false);
});

test('isWatchdogParkedMirrorTracker: false for unrelated titles and non-string input', () => {
  assert.equal(isWatchdogParkedMirrorTracker('Some unrelated health-check row'), false);
  assert.equal(isWatchdogParkedMirrorTracker(''), false);
  assert.equal(isWatchdogParkedMirrorTracker(null), false);
  assert.equal(isWatchdogParkedMirrorTracker(undefined), false);
});

// BRO-3923: proves the wiring, not just the leaf in isolation (CLAUDE.md §15
// — production code changes must fail the test, not just the standalone
// predicate).
test('planAutofix: never plans a card for a bare-numeric "Watchdog parked" queued row', () => {
  const queued = [{
    title: 'Watchdog parked #1234 — redispatch never produced a launch',
    description: 'Watchdog: card "Fix thing 1234" was claimed for redispatch but never produced a launch event.',
  }];
  const plan = planAutofix({ health: {}, tasks: [], queued });
  assert.deepEqual(plan, [], 'the frozen-mirror row must never reach planAutofix output at all');
});

test('planAutofix: never plans a card when only the conditionKey (not the title text) identifies the mirror', () => {
  const queued = [{
    title: 'Watchdog card, wording since changed',
    description: 'irrelevant',
    conditionKey: 'watchdog-park:5678',
  }];
  const plan = planAutofix({ health: {}, tasks: [], queued });
  assert.deepEqual(plan, []);
});

test('planAutofix: a linear: "Watchdog parked" queued row still plans a card normally', () => {
  const queued = [{
    title: 'Watchdog parked #linear:BRO-91 — dispatch guard refuses by construction',
    description: 'Watchdog: card cannot be redispatched by its own argv.',
  }];
  const plan = planAutofix({ health: {}, tasks: [], queued });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].state, 'needs-card');
  assert.equal(plan[0].title, 'BSC Daily: Watchdog parked #linear:BRO-91 — dispatch guard refuses by construction');
});
