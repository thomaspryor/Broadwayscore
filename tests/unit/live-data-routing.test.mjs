import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { planLiveDataRouting, splitNewAndKnown, KEY_PREFIX, conditionKeyFor } = require('../../scripts/lib/live-data-routing.js');
const { parseTapOutput } = require('../../scripts/lib/tap-failure-parser.js');

const TAP = `TAP version 13
not ok 1 - ceiling holds
  ---
  duration_ms: 1
  location: '/r/tests/unit/a.test.mjs:5:1'
  failureType: 'testCodeFailure'
  error: 'too many'
  ...
not ok 2 - tests/unit/b.test.mjs
  ---
  location: '/r/tests/unit/b.test.mjs:1:1'
  failureType: 'subtestsFailed'
  ...
ok 3 - fine
# tests 3
# fail 2
`;

test('each failing leaf test is its own routed condition; containers skipped', () => {
  const p = parseTapOutput(TAP, '/r');
  const plan = planLiveDataRouting(p.failures, [], p, 1);
  assert.deepEqual(plan.route.map((r) => r.conditionKey), [conditionKeyFor('tests/unit/a.test.mjs::ceiling holds')]);
  assert.equal(plan.route[0].disposition, 'auto'); // BRO-6983: persistent failures get one card
  assert.equal(plan.route[0].deferFilingHours, 72);
});
test('green tests resolve open keys; foreign keys untouched', () => {
  const p = parseTapOutput(TAP, '/r');
  const plan = planLiveDataRouting(p.failures, [`${KEY_PREFIX}gone`, 'corpus-drift:x'], p, 1);
  assert.deepEqual(plan.resolve, [`${KEY_PREFIX}gone`]);
});
test('a run with no verdict resolves nothing and a silent non-zero exit routes run-crashed', () => {
  const p = parseTapOutput('', '/r');
  const plan = planLiveDataRouting(p.failures, [`${KEY_PREFIX}old`], p, 1);
  assert.deepEqual(plan.resolve, []);
  assert.equal(plan.route[0].conditionKey, `${KEY_PREFIX}run-crashed`);
});
test('clean run resolves every open live-data key', () => {
  const p = parseTapOutput('ok 1 - a\n# tests 1\n# fail 0\n', '/r');
  const plan = planLiveDataRouting(p.failures, [`${KEY_PREFIX}old`], p, 0);
  assert.deepEqual(plan.resolve, [`${KEY_PREFIX}old`]);
  assert.equal(plan.route.length, 0);
});
test('truncated TAP (no summary) resolves nothing; long keys stay distinct', () => {
  const p = parseTapOutput('ok 1 - a\n', '/r');
  assert.deepEqual(planLiveDataRouting(p.failures, [`${KEY_PREFIX}old`], p, 0).resolve, []);
  const a = conditionKeyFor('f::' + 'x'.repeat(300) + 'A');
  const b = conditionKeyFor('f::' + 'x'.repeat(300) + 'B');
  assert.notEqual(a, b);
  assert.ok(a.length <= 200);
});
test('open keys of a file that failed this run are not resolved', () => {
  const p = parseTapOutput(TAP, '/r');
  const plan = planLiveDataRouting(p.failures, [conditionKeyFor('tests/unit/a.test.mjs::renamed test')], p, 1);
  assert.deepEqual(plan.resolve, []);
});

// BRO-6983: the job is red only for NEW failures.
const NOW = Date.parse('2026-11-04T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const seen = (h) => ({ lastSeen: hoursAgo(h) });
const route = (...names) => names.map((n) => ({ conditionKey: conditionKeyFor(`tests/unit/a.test.mjs::${n}`) }));

test('split: a first-sighting failure is NEW', () => {
  const { newKeys, knownKeys } = splitNewAndKnown(route('x'), {}, NOW);
  assert.equal(newKeys.length, 1);
  assert.equal(knownKeys.length, 0);
});
test('split: a card on a legacy row, or a deferred row past 72h, is known; everything else is still new', () => {
  const [a, b, c, d] = route('aged-with-card', 'legacy-carded', 'fresh', 'aged-no-card');
  const conditions = {
    [a.conditionKey]: { status: 'open', incidentOpenedAt: hoursAgo(80), deferredAuto: true, linearIdentifier: 'BRO-2', ...seen(2) },
    [b.conditionKey]: { status: 'open', incidentOpenedAt: hoursAgo(5), linearIdentifier: 'BRO-1', ...seen(2) },
    [c.conditionKey]: { status: 'open', incidentOpenedAt: hoursAgo(5), ...seen(2) },
    // Past 72h but the router has not filed the card yet (or filing keeps failing): the job stays red.
    [d.conditionKey]: { status: 'open', incidentOpenedAt: hoursAgo(80), deferredAuto: true, ...seen(2) },
  };
  const { newKeys, knownKeys } = splitNewAndKnown([a, b, c, d], conditions, NOW);
  assert.deepEqual(knownKeys, [a.conditionKey, b.conditionKey]);
  assert.deepEqual(newKeys, [c.conditionKey, d.conditionKey]);
});
test('split: a deferred row that kept the PREVIOUS incident\'s card is NEW until its own 72h passes', () => {
  const [a] = route('recurred');
  const { newKeys } = splitNewAndKnown([a], { [a.conditionKey]: { status: 'open', incidentOpenedAt: hoursAgo(10), deferredAuto: true, linearIdentifier: 'BRO-OLD', ...seen(1) } }, NOW);
  assert.deepEqual(newKeys, [a.conditionKey]);
});
test('split: a crashed suite (run-crashed) never counts as known, however old and carded', () => {
  const key = `${KEY_PREFIX}run-crashed`;
  const { newKeys, knownKeys } = splitNewAndKnown([{ conditionKey: key }], { [key]: { status: 'open', incidentOpenedAt: hoursAgo(900), deferredAuto: true, linearIdentifier: 'BRO-9', ...seen(1) } }, NOW);
  assert.deepEqual(newKeys, [key]);
  assert.deepEqual(knownKeys, []);
});
test('split: a resolved condition that fails again is NEW', () => {
  const [a] = route('back');
  const { newKeys } = splitNewAndKnown([a], { [a.conditionKey]: { status: 'resolved', incidentOpenedAt: hoursAgo(500) } }, NOW);
  assert.deepEqual(newKeys, [a.conditionKey]);
});
test('split: the class-A cross-market leak never counts as known, however old', () => {
  const key = conditionKeyFor('scripts/verify-contamination-gate.test.mjs::no class-A cross-market leaks (a show showing another production\'s reviews)');
  const { newKeys, knownKeys } = splitNewAndKnown([{ conditionKey: key }], { [key]: { status: 'open', incidentOpenedAt: hoursAgo(900), linearIdentifier: 'BRO-6891' } }, NOW);
  assert.deepEqual(newKeys, [key]);
  assert.deepEqual(knownKeys, []);
});
test('split: an open condition not seen for over 96h is a fresh incident, so NEW', () => {
  const [a] = route('stale');
  const { newKeys } = splitNewAndKnown([a], { [a.conditionKey]: { status: 'open', incidentOpenedAt: hoursAgo(300), linearIdentifier: 'BRO-1', ...seen(120) } }, NOW);
  assert.deepEqual(newKeys, [a.conditionKey]);
});
test('split: an old open row from before the deferred-card path (no deferredAuto, no card) is still NEW', () => {
  const [a] = route('legacy');
  const { newKeys } = splitNewAndKnown([a], { [a.conditionKey]: { status: 'open', incidentOpenedAt: hoursAgo(200), ...seen(2) } }, NOW);
  assert.deepEqual(newKeys, [a.conditionKey]);
});
