// BRO-5593: Sentry triage files real errors as Linear cards (not GitHub issues),
// keeps the sentry-<id> dedupe marker, and fails closed on a lookup error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const lib = require('../lib/sentry-linear-filing.js');
const { DEDUPE_OPT_OUTS } = require('../lib/card-dedupe.js');

const ISSUE = { id: '4567', title: "TypeError: Cannot read properties of undefined (reading 'score')", culprit: 'src/app/show/page.tsx', firstSeen: '2026-10-20T00:00:00Z', count: 12, userCount: 7, permalink: 'https://sentry.io/x/4567/' };
const REAL = { noise: false, reason: 'application error', lowFrequency: false };

function stubs({ found = [], lookupError, createError } = {}) {
  const calls = { lookup: [], create: [] };
  return {
    calls,
    deps: {
      async listIssuesByProvenance(args) {
        calls.lookup.push(args);
        if (lookupError) throw lookupError;
        return found;
      },
      async createLinearIssue(args) {
        calls.create.push(args);
        if (createError) throw createError;
        return { issue: { identifier: 'BRO-9001', url: 'https://linear.app/x/BRO-9001' } };
      },
    },
  };
}

test('files a new Linear card carrying the sentry-<id> marker through the chokepoint', async () => {
  const s = stubs();
  const r = await lib.fileSentryIssue({ issue: ISSUE, classification: REAL, org: 'o' }, s.deps);
  assert.equal(r.action, 'filed');
  assert.equal(r.card.identifier, 'BRO-9001');
  assert.equal(s.calls.create.length, 1);
  const c = s.calls.create[0];
  assert.match(c.description, /^sentry-issue: sentry-4567$/m);
  assert.ok(lib.hasMarker(c.description, '4567'));
  assert.equal(c.dispatch, true);
  assert.equal(c.source, 'sentry-triage');
  assert.equal(c.priority, 3);
  assert.ok(Object.prototype.hasOwnProperty.call(DEDUPE_OPT_OUTS, c.dedupeOptOut), 'opt-out must be registered');
  assert.match(c.description, /https:\/\/sentry\.io\/x\/4567\//);
  // The lookup searched by the marker
  assert.deepEqual(s.calls.lookup[0].descriptionMarkers, ['sentry-issue: sentry-4567']);
});

test('a low-frequency real issue is filed but not dispatched (BRO-7722)', async () => {
  const s = stubs();
  const r = await lib.fileSentryIssue({ issue: ISSUE, classification: { ...REAL, lowFrequency: true }, org: 'o' }, s.deps);
  assert.equal(r.action, 'filed');
  const c = s.calls.create[0];
  assert.ok(!c.dispatch);
  assert.equal(c.park, lib.LOW_FREQUENCY_PARK);
  assert.equal(c.priority, 4);
  // createLinearIssue's real disposition rule must accept it (dispatch:false alone was refused).
  const { resolveDisposition } = require('../lib/card-disposition.js');
  assert.equal(resolveDisposition(c).ok, true);
  const hd = require('../lib/headless-dispatchability.js');
  assert.equal(hd.isWorkerTakeableParkReason(c.park), false, 'a worker must not pick up a low-frequency park');
});

test('every Sentry card carries a safe VERIFY the cloud worker accepts (BRO-7722)', async () => {
  const s = stubs();
  await lib.fileSentryIssue({ issue: ISSUE, classification: REAL, org: 'o' }, s.deps);
  const c = s.calls.create[0];
  assert.equal(resolveDispositionOk(c), true);
  const { evaluateVerifiability } = require('../lib/verify-gate.js');
  const v = evaluateVerifiability(c.description, []);
  assert.equal(v.armed, true, JSON.stringify(v));
  assert.equal(v.cmd, 'npx tsx --test tests/unit/sentry-4567.test.mjs');
  assert.match(c.description, /^CREATES: tests\/unit\/sentry-4567\.test\.mjs$/m);
  assert.throws(() => lib.regressionTestPath('abc'));
});

function resolveDispositionOk(c) {
  return require('../lib/card-disposition.js').resolveDisposition(c).ok;
}

test('an existing card (any state) means no new card', async () => {
  const s = stubs({ found: [{ identifier: 'BRO-1', state: { type: 'completed' }, description: 'x\nsentry-issue: sentry-4567\n' }] });
  const r = await lib.fileSentryIssue({ issue: ISSUE, classification: REAL, org: 'o' }, s.deps);
  assert.equal(r.action, 'existing');
  assert.equal(r.card.identifier, 'BRO-1');
  assert.equal(s.calls.create.length, 0);
});

test('a prefix match (sentry-45678) is not the same Sentry issue', async () => {
  const s = stubs({ found: [{ identifier: 'BRO-2', description: 'sentry-issue: sentry-45678' }] });
  const r = await lib.fileSentryIssue({ issue: ISSUE, classification: REAL, org: 'o' }, s.deps);
  assert.equal(r.action, 'filed');
});

test('fails closed: a lookup error files nothing and reports skipped', async () => {
  const s = stubs({ lookupError: new Error('Linear 503') });
  const r = await lib.fileSentryIssue({ issue: ISSUE, classification: REAL, org: 'o' }, s.deps);
  assert.equal(r.action, 'skipped');
  assert.match(r.reason, /Linear 503/);
  assert.equal(s.calls.create.length, 0);
});

test('a create error is reported as skipped, never as filed', async () => {
  const s = stubs({ createError: new Error('USAGE_LIMIT_EXCEEDED') });
  const r = await lib.fileSentryIssue({ issue: ISSUE, classification: REAL, org: 'o' }, s.deps);
  assert.equal(r.action, 'skipped');
  assert.match(r.reason, /USAGE_LIMIT_EXCEEDED/);
});

test('per-run cap defers new cards but still recognises existing ones', async () => {
  const s = stubs();
  const r = await lib.fileSentryIssue({ issue: ISSUE, classification: REAL, org: 'o', canCreate: false }, s.deps);
  assert.equal(r.action, 'deferred');
  assert.equal(s.calls.create.length, 0);
  const s2 = stubs({ found: [{ identifier: 'BRO-3', description: 'sentry-issue: sentry-4567' }] });
  const r2 = await lib.fileSentryIssue({ issue: ISSUE, classification: REAL, org: 'o', canCreate: false }, s2.deps);
  assert.equal(r2.action, 'existing');
});

test('low-frequency errors file at Low priority; missing permalink builds a Sentry link', () => {
  const card = lib.buildSentryCard({ ...ISSUE, permalink: undefined }, { ...REAL, lowFrequency: true }, 'myorg');
  assert.equal(card.priority, 4);
  assert.match(card.description, /https:\/\/sentry\.io\/organizations\/myorg\/issues\/4567\//);
  assert.match(card.description, /low frequency/);
});

test('triage-sentry.js and its workflow no longer file GitHub issues', () => {
  const script = readFileSync(new URL('../triage-sentry.js', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /api\.github\.com/);
  assert.match(script, /fileSentryIssue/);
  const wf = readFileSync(new URL('../../.github/workflows/sentry-triage.yml', import.meta.url), 'utf8');
  assert.match(wf, /LINEAR_API_KEY: \$\{\{ secrets\.LINEAR_API_KEY \}\}/);
  assert.doesNotMatch(wf, /issues: write/);
});

test('a closed card plus an event after it closed files ONE regression card (BRO-7722)', () => {
  const closed = { identifier: 'BRO-1', state: { type: 'completed' }, completedAt: '2026-11-10T00:00:00Z' };
  assert.equal(lib.regressionOf([closed], { lastSeen: '2026-11-12T00:00:00Z' }), closed);
  // seen before the close: same issue, no refile
  assert.equal(lib.regressionOf([closed], { lastSeen: '2026-11-09T00:00:00Z' }), null);
  // an open card (e.g. the regression card itself) stops any further refile
  assert.equal(lib.regressionOf([closed, { identifier: 'BRO-2', state: { type: 'unstarted' } }], { lastSeen: '2026-11-12T00:00:00Z' }), null);
  // no close time or no lastSeen: fail closed (no refile)
  assert.equal(lib.regressionOf([{ ...closed, completedAt: null }], { lastSeen: '2026-11-12T00:00:00Z' }), null);
  assert.equal(lib.regressionOf([closed], {}), null);
  assert.equal(lib.regressionOf([], { lastSeen: '2026-11-12T00:00:00Z' }), null);
});

test('fileSentryIssue files a regression card titled as such when the fix did not hold', async () => {
  const closed = { identifier: 'BRO-1', description: 'sentry-issue: sentry-4567', state: { type: 'completed' }, completedAt: '2026-11-10T00:00:00Z' };
  const calls = [];
  const deps = {
    listIssuesByProvenance: async () => [closed],
    createLinearIssue: async (c) => { calls.push(c); return { issue: { identifier: 'BRO-9' } }; },
  };
  const r = await lib.fileSentryIssue({ issue: { ...ISSUE, lastSeen: '2026-11-12T00:00:00Z' }, classification: REAL, org: 'o' }, deps);
  assert.equal(r.action, 'filed');
  assert.match(calls[0].title, /^Sentry regression:/);
  assert.match(calls[0].description, /^REGRESSION: BRO-1 /);
  assert.ok(lib.hasMarker(calls[0].description, '4567'));
  const r2 = await lib.fileSentryIssue({ issue: { ...ISSUE, lastSeen: '2026-11-09T00:00:00Z' }, classification: REAL, org: 'o' }, deps);
  assert.equal(r2.action, 'existing');
});

// --- BRO-7595: one error split by Sentry into several ids goes on ONE card ---
// Live shapes from 2026-11-18: BRO-7726/BRO-7727 were filed for the same
// UGC insert error, differing only in the trailing code; Linear stores the
// culprit escaped ("\_(chunks/9308)").
const UGC_A = { id: '7835186801', title: 'UgcError: UGC insert reviews failed (account_gone)', culprit: 'y(chunks/20993)', firstSeen: '2026-11-08T03:03:09Z', count: 5, userCount: 5, permalink: 'https://sentry.io/x/7835186801/' };
const UGC_B = { ...UGC_A, id: '7835186900', title: 'UgcError: UGC insert reviews failed (23503)', permalink: 'https://sentry.io/x/7835186900/' };

function twinCard(issue, extra = {}) {
  const built = lib.buildSentryCard(issue, REAL, 'o');
  return { id: 'uuid-twin', identifier: 'BRO-7726', state: { type: 'unstarted' }, description: `${built.description}\n\nFiled by: sentry-triage (kind: x)`, ...extra };
}

function groupingStubs({ fresh, getError, updateError } = {}) {
  const calls = { create: [], get: [], update: [], comment: [] };
  return {
    calls,
    deps: {
      async listIssuesByProvenance() { return []; },
      async createLinearIssue(args) { calls.create.push(args); return { issue: { id: `uuid-${calls.create.length}`, identifier: `BRO-90${calls.create.length}` } }; },
      async getIssue(id) { calls.get.push(id); if (getError) throw getError; return typeof fresh === 'function' ? fresh(id) : fresh; },
      async updateIssue(id, input) { calls.update.push({ id, input }); if (updateError) throw updateError; },
      async createComment(id, body) { calls.comment.push({ id, body }); },
    },
  };
}

test('sentryFamily: same error and culprit match across trailing codes; culprit and wording must agree', () => {
  assert.equal(lib.sentryFamily(UGC_A.title, UGC_A.culprit), lib.sentryFamily(UGC_B.title, UGC_B.culprit));
  assert.notEqual(lib.sentryFamily(UGC_A.title, UGC_A.culprit), lib.sentryFamily(UGC_A.title, '_(chunks/9308)'));
  assert.notEqual(lib.sentryFamily(UGC_A.title, UGC_A.culprit), lib.sentryFamily('UgcError: UGC insert watchlist failed (23503)', UGC_A.culprit));
  // A descriptive parenthetical is part of the error, not a code.
  assert.notEqual(lib.sentryFamily("TypeError: Cannot read properties of undefined (reading 'a')", 'c'), lib.sentryFamily("TypeError: Cannot read properties of undefined (reading 'b')", 'c'));
  assert.equal(lib.sentryFamily(UGC_A.title, ''), null);
  assert.equal(lib.sentryFamily(UGC_A.title, 'Unknown'), null);
  // Linear's markdown escaping does not change the family.
  assert.equal(lib.cardFamily('Error: UgcError: UGC auth.callback failed (timeout)\nCulprit: \\_(chunks/9308)'), lib.sentryFamily('UgcError: UGC auth.callback failed (500)', '_(chunks/9308)'));
});

test('a second Sentry id of an open card\'s error is added to that card, not filed (even past the cap)', async () => {
  const twin = twinCard(UGC_A);
  const fresh = { ...twin, description: `${twin.description}\n\nA person's note added after the list read.` };
  const s = groupingStubs({ fresh });
  const r = await lib.fileSentryIssue({ issue: UGC_B, classification: REAL, org: 'o', canCreate: false, familyCards: [twin] }, s.deps);
  assert.equal(r.action, 'grouped');
  assert.equal(s.calls.create.length, 0);
  assert.deepEqual(s.calls.get, ['BRO-7726']);
  const desc = s.calls.update[0].input.description;
  // Built from the fresh read (the person's note survives), marker on its own line.
  assert.ok(desc.startsWith(fresh.description.trimEnd()));
  assert.ok(lib.hasMarker(desc, UGC_B.id));
  assert.ok(lib.hasMarker(desc, UGC_A.id));
  const note = s.calls.comment[0].body;
  assert.match(note, /resolve BOTH Sentry issues: 7835186801 and 7835186900/);
  assert.match(note, /https:\/\/sentry\.io\/x\/7835186900\//);
});

test('a parked twin does not absorb a real (dispatchable) error; it does absorb a low-frequency one', async () => {
  const parked = twinCard(UGC_A, { description: `PARKED: ${lib.LOW_FREQUENCY_PARK}\n\n${twinCard(UGC_A).description}` });
  const s = groupingStubs({ fresh: parked });
  const r = await lib.fileSentryIssue({ issue: UGC_B, classification: REAL, org: 'o', familyCards: [parked] }, s.deps);
  assert.equal(r.action, 'filed');
  assert.equal(s.calls.update.length, 0);
  const s2 = groupingStubs({ fresh: parked });
  const r2 = await lib.fileSentryIssue({ issue: UGC_B, classification: { ...REAL, lowFrequency: true }, org: 'o', familyCards: [parked] }, s2.deps);
  assert.equal(r2.action, 'grouped');
});

test('closed, duplicate or different-culprit twins are never grouped into', async () => {
  for (const extra of [{ state: { type: 'completed' } }, { state: { type: 'canceled' } }, { state: { type: 'duplicate' } }]) {
    const t = twinCard(UGC_A, extra);
    const s = groupingStubs({ fresh: t });
    assert.equal((await lib.fileSentryIssue({ issue: UGC_B, classification: REAL, org: 'o', familyCards: [t] }, s.deps)).action, 'filed');
  }
  const t = twinCard(UGC_A);
  const s = groupingStubs({ fresh: t });
  const r = await lib.fileSentryIssue({ issue: { ...UGC_B, culprit: '_(chunks/9308)' }, classification: REAL, org: 'o', familyCards: [t] }, s.deps);
  assert.equal(r.action, 'filed');
});

test('grouping fails open: a failed re-read or write files a new card', async () => {
  for (const opts of [{ getError: new Error('Linear 503') }, { updateError: new Error('Linear 500') }]) {
    const t = twinCard(UGC_A);
    const s = groupingStubs({ fresh: t, ...opts });
    const r = await lib.fileSentryIssue({ issue: UGC_B, classification: REAL, org: 'o', familyCards: [t] }, s.deps);
    assert.equal(r.action, 'filed', JSON.stringify(opts));
    assert.equal(s.calls.create.length, 1);
  }
  // A twin that closed between the list and the re-read is not used.
  const t = twinCard(UGC_A);
  const s = groupingStubs({ fresh: { ...t, state: { type: 'completed' } } });
  assert.equal((await lib.fileSentryIssue({ issue: UGC_B, classification: REAL, org: 'o', familyCards: [t] }, s.deps)).action, 'filed');
});

test('two ids of one error in the same run make one card (built description kept for the second)', async () => {
  const familyCards = [];
  const s = groupingStubs({ fresh: () => ({ ...familyCards[0] }) });
  const r1 = await lib.fileSentryIssue({ issue: UGC_A, classification: REAL, org: 'o', familyCards }, s.deps);
  const r2 = await lib.fileSentryIssue({ issue: UGC_B, classification: REAL, org: 'o', familyCards }, s.deps);
  assert.equal(r1.action, 'filed');
  assert.equal(r2.action, 'grouped');
  assert.equal(r2.card.identifier, 'BRO-901');
  assert.equal(s.calls.create.length, 1);
});

test('a regression is filed as its own card, never grouped', async () => {
  const closed = { identifier: 'BRO-1', description: `sentry-issue: sentry-${UGC_B.id}`, state: { type: 'completed' }, completedAt: '2026-11-10T00:00:00Z' };
  const t = twinCard(UGC_A);
  const s = groupingStubs({ fresh: t });
  s.deps.listIssuesByProvenance = async () => [closed];
  const r = await lib.fileSentryIssue({ issue: { ...UGC_B, lastSeen: '2026-11-12T00:00:00Z' }, classification: REAL, org: 'o', familyCards: [t] }, s.deps);
  assert.equal(r.action, 'filed');
  assert.match(s.calls.create[0].title, /^Sentry regression:/);
});

test('triage-sentry.js reads the family cards once per run and passes them in', async () => {
  const args = [];
  await lib.listSentryFamilyCards({ listIssuesByProvenance: async (a) => { args.push(a); return []; } }, Date.parse('2026-11-18T00:00:00Z'));
  assert.deepEqual(args[0].descriptionMarkers, ['Filed by: sentry-triage']);
  assert.equal(args[0].since, '2026-08-20T00:00:00.000Z');
  const script = readFileSync(new URL('../triage-sentry.js', import.meta.url), 'utf8');
  assert.match(script, /familyCards = await listSentryFamilyCards\(deps\)/);
  assert.match(script, /canCreate: [^}]*familyCards \}/);
  assert.match(script, /r\.action === 'grouped'/);
});

test('numbers inside the error text keep errors apart; the real split pairs still group (BRO-7595 review)', () => {
  assert.notEqual(lib.sentryFamily('Error: Minified React error #418; visit https://react.dev/errors/418', 'c'), lib.sentryFamily('Error: Minified React error #423; visit https://react.dev/errors/423', 'c'));
  assert.notEqual(lib.sentryFamily('Error: Request failed with status code 404', 'c'), lib.sentryFamily('Error: Request failed with status code 500', 'c'));
  const pairs = [
    ['SecurityError: Attempt to use history.replaceState() more than 100 times per 10 seconds', 'SecurityError: Attempt to use history.replaceState() more than 100 times per 10 seconds', '?(chunks/b468fba8)'],
    ['UgcError: UGC insert reviews failed (account_gone)', 'UgcError: UGC insert reviews failed (23503)', 'y(chunks/20993)'],
    ['UgcError: UGC insert watchlist failed (account_gone)', 'UgcError: UGC insert watchlist failed (23503)', 'y(chunks/20993)'],
  ];
  for (const [a, b, c] of pairs) assert.equal(lib.sentryFamily(a, c), lib.sentryFamily(b, c), a);
});

test('a Backlog twin counts as parked: it does not absorb a dispatchable error', async () => {
  const t = twinCard(UGC_A, { state: { type: 'backlog' } });
  const s = groupingStubs({ fresh: t });
  assert.equal((await lib.fileSentryIssue({ issue: UGC_B, classification: REAL, org: 'o', familyCards: [t] }, s.deps)).action, 'filed');
  const s2 = groupingStubs({ fresh: t });
  assert.equal((await lib.fileSentryIssue({ issue: UGC_B, classification: { ...REAL, lowFrequency: true }, org: 'o', familyCards: [t] }, s2.deps)).action, 'grouped');
});
