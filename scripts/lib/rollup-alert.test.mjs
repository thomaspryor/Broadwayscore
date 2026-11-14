import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildDispatchFailedAlert, buildStillImagelessAlert, IMAGELESS_DISPATCH_FAILED_KEY, IMAGELESS_STILL_IMAGELESS_KEY } = require('./image-trigger-guard.js');
const { buildRollupAlert, syncRollup } = require('./rollup-alert.js');

const shows = (n) => Array.from({ length: n }, (_, i) => ({ id: `show-${i}`, title: `Show ${i}`, attempts: 3 }));

test('N failed-dispatch shows fold into one alert with the stable rollup key (BRO-5496)', () => {
  const opts = buildDispatchFailedAlert(shows(5), 'HTTP 403');
  assert.ok(opts && !Array.isArray(opts));
  assert.equal(opts.conditionKey, IMAGELESS_DISPATCH_FAILED_KEY);
  for (let i = 0; i < 5; i++) assert.match(opts.description, new RegExp(`show-${i}`));
  assert.match(opts.hint, /show_id=show-0,show-1,show-2,show-3,show-4/);
  assert.equal(buildDispatchFailedAlert(shows(1), 'x').conditionKey, opts.conditionKey);
});

test('N still-imageless shows fold into one alert with the stable rollup key', () => {
  const opts = buildStillImagelessAlert(shows(4));
  assert.equal(opts.conditionKey, IMAGELESS_STILL_IMAGELESS_KEY);
  assert.match(opts.title, /4 show\(s\)/);
  assert.equal(buildStillImagelessAlert(shows(1)).conditionKey, opts.conditionKey);
});

test('no findings gives no alert', () => {
  assert.equal(buildDispatchFailedAlert([], 'x'), null);
  assert.equal(buildStillImagelessAlert([]), null);
  assert.equal(buildRollupAlert({ key: 'k', items: null }), null);
});

test('syncRollup comments only members added after the card was filed', async () => {
  const comments = [];
  const patches = [];
  let row = { rollupMembers: ['show-0'] };
  const router = { loadLedger: () => ({ conditions: { k: row } }), patchCondition: (key, p) => { patches.push([key, p]); row = { ...row, ...p }; } };
  const linearClient = { getIssue: async () => ({ id: 'uuid' }), createComment: async (id, body) => comments.push(body) };
  const args = { key: 'k', items: shows(3), itemId: (s) => s.id, itemBlock: (s) => `- ${s.id}`, header: (a) => `${a.length} new` };
  const r = await syncRollup(args, { action: 'silent', linearIdentifier: 'BRO-1' }, { router, linearClient });
  assert.equal(r.commented, 2);
  assert.equal(comments.length, 1);
  assert.doesNotMatch(comments[0], /show-0/);
  assert.deepEqual(patches[0][1].rollupMembers.sort(), ['show-0', 'show-1', 'show-2']);
  const again = await syncRollup(args, { action: 'silent', linearIdentifier: 'BRO-1' }, { router, linearClient });
  assert.equal(again.commented, 0);
  assert.equal(comments.length, 1);
});

test('a cooldown re-fire that wipes the ledger row does not re-comment known members', async () => {
  const { snapshotRollupMembers } = require('./rollup-alert.js');
  const comments = [];
  let row = { rollupShows: ['show-0', 'show-1'] }; // legacy field name still honoured
  const router = { loadLedger: () => ({ conditions: { k: row } }), patchCondition: (key, p) => { row = { ...row, ...p }; } };
  const linearClient = { getIssue: async () => ({ id: 'uuid' }), createComment: async (id, body) => comments.push(body) };
  const prior = snapshotRollupMembers('k', { router });
  row = { status: 'open' }; // routeAlert rewrote the row and dropped rollup fields
  const args = { key: 'k', items: shows(3), itemId: (s) => s.id, itemBlock: (s) => `- ${s.id}`, header: (a) => `${a.length} new`, priorMembers: prior };
  const r = await syncRollup(args, { action: 'silent', linearIdentifier: 'BRO-1' }, { router, linearClient });
  assert.equal(r.commented, 1);
  assert.match(comments[0], /show-2/);
  assert.doesNotMatch(comments[0], /show-0|show-1/);
});
