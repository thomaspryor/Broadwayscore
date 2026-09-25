// scripts/red-first-dispatch.test.mjs — BRO-4151.
//
// scripts/red-first-dispatch.js is the thin by-hand CLI around
// scripts/lib/red-first-dispatch.js's runRedFirstPass() (already covered in
// depth by scripts/lib/red-first-dispatch.test.mjs). This file covers:
//   - the CLI wrapper itself (--help / USAGE, exported shape)
//   - the BRO-4151 fix: a red-first card skipped for any reason other than
//     "already being handled elsewhere" (a live job, a very recent dispatch,
//     an unresolved dispatched-comment) must surface via routeAlert instead
//     of vanishing silently — BRO-4147 and BRO-4149 both sat 40+ minutes
//     with no job AND no alert before this fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { main, USAGE } = require('./red-first-dispatch.js');
const { isSilentSkipReason, runRedFirstPass } = require('./lib/red-first-dispatch.js');
const { DISPATCH_AT_FILING_MARKER } = require('./lib/linear-drain-parked.js');

// ── CLI wrapper ──────────────────────────────────────────────────────────

test('--help/-h prints USAGE and never touches Linear', async () => {
  const originalArgv = process.argv;
  const originalLog = console.log;
  const logged = [];
  console.log = (msg) => logged.push(msg);
  try {
    for (const flag of ['--help', '-h']) {
      logged.length = 0;
      process.argv = ['node', 'red-first-dispatch.js', flag];
      await main();
      assert.deepEqual(logged, [USAGE]);
    }
  } finally {
    console.log = originalLog;
    process.argv = originalArgv;
  }
});

test('USAGE documents both kill switches', () => {
  assert.match(USAGE, /RED_FIRST_DISABLED=1/);
  assert.match(USAGE, /LINEAR_NEXT_DISABLED=1/);
});

// ── BRO-4151: isSilentSkipReason ─────────────────────────────────────────

test('isSilentSkipReason: only already-being-handled reasons are silent', () => {
  assert.equal(isSilentSkipReason('live-job'), true);
  assert.equal(isSilentSkipReason('dispatched-comment'), true);
  assert.equal(isSilentSkipReason('recent-attempt:dispatch'), true);
  // Anything else got no job this tick and nothing is coming without help.
  assert.equal(isSilentSkipReason('no-safe-verify'), false);
  assert.equal(isSilentSkipReason('cap-reached'), false);
  assert.equal(isSilentSkipReason('state-moved'), false);
  assert.equal(isSilentSkipReason('human-gated:owner-judgment'), false);
  assert.equal(isSilentSkipReason('recent-attempt:refused'), false);
  assert.equal(isSilentSkipReason('recent-attempt:follow-up'), false);
  assert.equal(isSilentSkipReason(undefined), false);
});

// ── BRO-4151: runRedFirstPass surfaces non-silent skips ──────────────────

const NOW = Date.parse('2026-09-25T12:00:00.000Z');

const redCard = (n, { verify = 'VERIFY: owner-judgment', title = `main test.yml red: card ${n}` } = {}) => ({
  identifier: `BRO-${n}`,
  title,
  state: { name: 'Todo', type: 'unstarted' },
  description: `${DISPATCH_AT_FILING_MARKER} (BRO-4054; condition: test-yml:red:Lint Workflows:${String(n).padStart(8, '0')}). \n\n## Acceptance criteria\n${verify}\n`,
  comments: { nodes: [] },
});

function baseDeps(overrides = {}) {
  return {
    listOpenIssues: async () => [],
    getIssue: async () => null,
    openJobTaskIds: () => new Set(),
    readJournal: () => [],
    appendJournal: () => {},
    readTrackedLedger: () => ({ conditions: {} }),
    dispatch: () => { throw new Error('must not dispatch in this test'); },
    updateIssue: () => {},
    routeSkipAlert: async () => { throw new Error('routeSkipAlert must be overridden per test'); },
    ...overrides,
  };
}

test('a card with no safe-form VERIFY (BRO-4147/BRO-4149 class) gets surfaced via routeSkipAlert, not silently dropped', async () => {
  const card = redCard(4147); // default verify: owner-judgment -> no-safe-verify skip
  const alerts = [];
  const deps = baseDeps({
    listOpenIssues: async () => [card],
    routeSkipAlert: async (opts) => { alerts.push(opts); },
  });
  const summary = await runRedFirstPass({ now: NOW, log: () => {}, deps });
  assert.ok(summary.skipped.some((s) => s.identifier === 'BRO-4147' && s.reason === 'no-safe-verify'));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].disposition, 'digest');
  assert.equal(alerts[0].conditionKey, 'red-first-skip:BRO-4147');
  assert.match(alerts[0].title, /BRO-4147/);
  assert.match(alerts[0].description, /no-safe-verify/);
  assert.ok(alerts[0].fields.some((f) => f.name === 'Card' && f.value === 'BRO-4147'));
});

test('a live-job skip never calls routeSkipAlert (already being handled)', async () => {
  const card = redCard(4200);
  let called = false;
  const deps = baseDeps({
    listOpenIssues: async () => [card],
    openJobTaskIds: () => new Set(['linear:BRO-4200']),
    routeSkipAlert: async () => { called = true; },
  });
  const summary = await runRedFirstPass({ now: NOW, log: () => {}, deps });
  assert.ok(summary.skipped.some((s) => s.identifier === 'BRO-4200' && s.reason === 'live-job'));
  assert.equal(called, false);
});

test('a dispatched-comment skip never calls routeSkipAlert (another machine already has it)', async () => {
  const card = { ...redCard(4201, { verify: 'VERIFY: `node scripts/run-unit-tests.js`' }),
    comments: { nodes: [{ body: 'Dispatched abc123 to headless:linear:BRO-4201 at 2026-09-25T11:00:00Z (headless)', createdAt: '2026-09-25T11:00:00Z' }] } };
  let called = false;
  const deps = baseDeps({
    listOpenIssues: async () => [card],
    getIssue: async () => card,
    routeSkipAlert: async () => { called = true; },
  });
  const summary = await runRedFirstPass({ now: NOW, log: () => {}, deps });
  assert.ok(summary.skipped.some((s) => s.identifier === 'BRO-4201' && s.reason === 'dispatched-comment'));
  assert.equal(called, false);
});

test('a very recent dispatch attempt never calls routeSkipAlert (still cooling down, already requested)', async () => {
  const card = redCard(4202);
  const journal = [{ ts: new Date(NOW - 60000).toISOString(), event: 'dispatch', identifier: 'BRO-4202' }];
  let called = false;
  const deps = baseDeps({
    listOpenIssues: async () => [card],
    readJournal: () => journal,
    routeSkipAlert: async () => { called = true; },
  });
  const summary = await runRedFirstPass({ now: NOW, log: () => {}, deps });
  assert.ok(summary.skipped.some((s) => s.identifier === 'BRO-4202' && s.reason.startsWith('recent-attempt:dispatch')));
  assert.equal(called, false);
});

test('cap-reached is surfaced too — any reason other than already-being-handled must not go silent', async () => {
  const cards = [redCard(4300, { verify: 'VERIFY: `node scripts/run-unit-tests.js`' }), redCard(4301, { verify: 'VERIFY: `node scripts/run-unit-tests.js`' })];
  const byId = new Map(cards.map((c) => [c.identifier, c]));
  const alerts = [];
  const deps = baseDeps({
    listOpenIssues: async () => cards,
    getIssue: async (id) => byId.get(id) || null,
    dispatch: () => {},
    routeSkipAlert: async (opts) => { alerts.push(opts); },
  });
  const summary = await runRedFirstPass({ now: NOW, log: () => {}, deps, dryRun: false });
  // Force the cap via a pre-filled journal so the second candidate is skipped.
  const journalFull = Array.from({ length: 6 }, (_, i) => ({ ts: new Date(NOW - (i + 1) * 60000).toISOString(), event: 'dispatch', identifier: `BRO-${9000 + i}` }));
  const alerts2 = [];
  const summary2 = await runRedFirstPass({ now: NOW, log: () => {}, deps: { ...deps, readJournal: () => journalFull, routeSkipAlert: async (opts) => { alerts2.push(opts); } } });
  assert.ok(summary2.skipped.some((s) => s.reason === 'cap-reached'));
  assert.ok(alerts2.some((a) => a.conditionKey.startsWith('red-first-skip:') && a.description.includes('cap-reached')));
  // sanity: the un-capped run dispatched both, no skip at all
  assert.deepEqual(summary.dispatched.sort(), ['BRO-4300', 'BRO-4301']);
  assert.equal(alerts.length, 0);
});

test('dry-run never calls routeSkipAlert, even for a no-safe-verify card', async () => {
  const card = redCard(4400);
  let called = false;
  const deps = baseDeps({
    listOpenIssues: async () => [card],
    routeSkipAlert: async () => { called = true; },
  });
  await runRedFirstPass({ dryRun: true, now: NOW, log: () => {}, deps });
  assert.equal(called, false);
});

test('a failing routeSkipAlert call is logged, not thrown — one bad alert must not abort the tick', async () => {
  const card = redCard(4500);
  const logs = [];
  const deps = baseDeps({
    listOpenIssues: async () => [card],
    routeSkipAlert: async () => { throw new Error('Linear is down'); },
  });
  const summary = await runRedFirstPass({ now: NOW, log: (m) => logs.push(m), deps });
  assert.ok(summary.skipped.some((s) => s.identifier === 'BRO-4500'));
  assert.ok(logs.some((l) => l.includes('BRO-4500') && l.includes('Linear is down')));
});
