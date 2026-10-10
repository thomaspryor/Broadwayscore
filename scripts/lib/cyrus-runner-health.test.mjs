import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  refuseNewWork,
  assessRunnerHealth,
  staggerDelayMs,
  DEFAULT_STAGGER_WINDOW_MS,
} = require('./cyrus-runner-health.js');

const NOW = Date.parse('2026-08-16T12:00:00.000Z');
const fresh = (extra = {}) => ({
  at: '2026-08-16T11:59:50.000Z',
  capUSD: 25,
  spentUSD: 5,
  runners: [],
  ...extra,
});

// ── budget cap gate (acceptance: spend over cap refuses to start work) ────────

test('spend at or over the cap refuses new work, with the numbers', () => {
  for (const spentUSD of [25, 30]) {
    const r = refuseNewWork(fresh({ spentUSD }));
    assert.equal(r.refuse, true);
    assert.match(r.reason, /reached the \$25\.00 daily cap/);
    assert.match(r.reason, /not starting new work/);
  }
});

test('spend under the cap allows new work', () => {
  const r = refuseNewWork(fresh({ spentUSD: 24.99 }));
  assert.equal(r.refuse, false);
  assert.equal(r.reason, null);
});

test('an unconfigured cap never freezes the fleet', () => {
  // No cap invented: absent/zero/negative capUSD must always allow, even at
  // high spend — an absent cap must not silently refuse all work.
  for (const capUSD of [undefined, null, 0, -1]) {
    const r = refuseNewWork(fresh({ capUSD, spentUSD: 9999 }));
    assert.equal(r.refuse, false, `capUSD=${capUSD} should not refuse`);
  }
});

test('missing state allows work rather than crashing the gate', () => {
  assert.equal(refuseNewWork(null).refuse, false);
});

// ── digest verdict: missing heartbeat is visible, not silent ──────────────────

test('a healthy fleet says nothing', () => {
  const r = assessRunnerHealth(fresh(), NOW);
  assert.equal(r.status, 'ok');
  assert.equal(r.message, null);
});

test('no status file is unknown, never an alarm', () => {
  // Machines that do not run runners must not get a scary digest line.
  for (const absent of [null, undefined]) {
    const r = assessRunnerHealth(absent, NOW);
    assert.equal(r.status, 'unknown');
    assert.equal(r.message, null);
  }
});

test('a scheduler that stopped checking in is a visible error with the restart command', () => {
  // The core acceptance: absence of a heartbeat produces a warning, not silence.
  const r = assessRunnerHealth(fresh({ at: '2026-08-16T11:00:00.000Z' }), NOW);
  assert.equal(r.status, 'error');
  assert.match(r.message, /has not checked in for 60 min/);
  assert.match(r.message, /no runner is picking up work/);
  assert.match(r.message, /launchctl kickstart/);
});

test('an unparseable timestamp is an error, not a silent pass', () => {
  const r = assessRunnerHealth(fresh({ at: 'not a date' }), NOW);
  assert.equal(r.status, 'error');
  assert.match(r.message, /unreadable/);
});

test('hitting the spend cap surfaces in the digest as a warning', () => {
  const r = assessRunnerHealth(fresh({ spentUSD: 25 }), NOW);
  assert.equal(r.status, 'warn');
  assert.match(r.message, /daily spend cap of \$25\.00 reached/);
  assert.match(r.message, /new work is being refused/);
});

test('approaching the cap warns before work is actually refused', () => {
  const r = assessRunnerHealth(fresh({ spentUSD: 23 }), NOW); // 92% of 25
  assert.equal(r.status, 'warn');
  assert.match(r.message, /approaching the limit/);
});

test('a runner that claimed a slot but went dark is flagged', () => {
  const r = assessRunnerHealth(
    fresh({ runners: [{ id: 'runner-a', lastBeatAt: '2026-08-16T10:30:00.000Z' }] }),
    NOW,
  );
  assert.equal(r.status, 'warn');
  assert.match(r.message, /runner-a \(90 min\)/);
  assert.match(r.message, /stopped checking in/);
});

test('a runner that never beat at all is flagged, not silently skipped', () => {
  const r = assessRunnerHealth(fresh({ runners: [{ id: 'runner-b' }] }), NOW);
  assert.equal(r.status, 'warn');
  assert.match(r.message, /runner-b \(never\)/);
});

test('a runner beating within its window stays quiet', () => {
  const r = assessRunnerHealth(
    fresh({ runners: [{ id: 'runner-a', lastBeatAt: '2026-08-16T11:58:00.000Z' }] }),
    NOW,
  );
  assert.equal(r.status, 'ok');
});

test('scheduler silence outranks a per-runner beat that looks fresh', () => {
  // If the whole snapshot is stale, per-runner timestamps inside it are stale
  // too — the scheduler error must win rather than a stale file reading "ok".
  const r = assessRunnerHealth(
    fresh({ at: '2026-08-16T11:00:00.000Z', runners: [{ id: 'x', lastBeatAt: '2026-08-16T11:00:00.000Z' }] }),
    NOW,
  );
  assert.equal(r.status, 'error');
});

// ── staggered quotas ──────────────────────────────────────────────────────────

test('the same runner id always maps to the same offset', () => {
  assert.equal(staggerDelayMs('runner-a'), staggerDelayMs('runner-a'));
});

test('different runner ids spread across the window rather than colliding', () => {
  const ids = Array.from({ length: 12 }, (_, i) => `runner-${i}`);
  const offsets = ids.map((id) => staggerDelayMs(id, 600000));
  const distinct = new Set(offsets);
  // Not a guarantee of zero collisions, but 12 ids must not all land together.
  assert.ok(distinct.size >= 10, `expected spread, got ${distinct.size} distinct of 12`);
});

test('offsets stay within the requested window', () => {
  for (const id of ['a', 'runner-42', '', 'x'.repeat(200)]) {
    const off = staggerDelayMs(id, 600000);
    assert.ok(off >= 0 && off < 600000, `offset ${off} out of range for "${id}"`);
  }
});

test('an unusable window falls back to the default width', () => {
  for (const bad of [0, -5, undefined, NaN]) {
    const off = staggerDelayMs('runner-a', bad);
    assert.ok(off >= 0 && off < DEFAULT_STAGGER_WINDOW_MS);
  }
});
