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
