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
  assert.equal(v.cmd, 'node --test tests/unit/sentry-4567.test.mjs');
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
