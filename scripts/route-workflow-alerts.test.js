'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { KINDS, buildAlert, run } = require('./route-workflow-alerts.js');

const env = { GITHUB_RUN_ID: '42', GITHUB_REPOSITORY: 'o/r', GITHUB_SERVER_URL: 'https://github.com' };
const fakeRouter = (r) => { const calls = []; return { calls, routeAlert: async (o) => { calls.push(o); return r; }, resolveCondition: (k) => { calls.push({ resolve: k }); return true; } }; };

test('every kind builds valid routeAlert options with a unique key', () => {
  const keys = new Set();
  for (const kind of Object.keys(KINDS)) {
    const o = buildAlert(kind, env, () => 'body');
    assert.ok(o.conditionKey && o.title && ['auto', 'digest', 'human'].includes(o.disposition), kind);
    keys.add(o.conditionKey);
  }
  assert.strictEqual(keys.size, Object.keys(KINDS).length);
});

test('dispositions: technical = auto+dispatch, owner action = human/digest', () => {
  assert.strictEqual(buildAlert('lighthouse-regression', env, () => '').disposition, 'auto');
  assert.strictEqual(buildAlert('opening-night-stage', env).dispatchAtFiling, true);
  assert.strictEqual(buildAlert('gitlab-token-expired', env).disposition, 'human');
  assert.strictEqual(buildAlert('tony-ibdb-scraper', { INPUT_YEAR: '2026' }).title, 'Run Tony nominations IBDB scraper for 2026');
});

test('lighthouse body file is included; missing file falls back', () => {
  assert.match(buildAlert('lighthouse-regression', { LIGHTHOUSE_BODY_FILE: '/x' }, () => '| / | 50 |').description, /\| \/ \| 50 \|/);
  assert.match(buildAlert('lighthouse-regression', { LIGHTHOUSE_BODY_FILE: '/x' }, () => { throw new Error('enoent'); }).description, /below thresholds/);
});

test('run: auto needs a card, dispatchAtFiling carries the run id', async () => {
  const good = fakeRouter({ action: 'filed', linearIdentifier: 'BRO-1', dispatchOk: true });
  assert.strictEqual((await run({ mode: 'route', kind: 'opening-night-stage', env, router: good, log() {} })).ok, true);
  assert.deepStrictEqual(good.calls[0].dispatchAtFiling, { runId: '42', runUrl: 'https://github.com/o/r/actions/runs/42' });
  const bad = fakeRouter({ action: 'filed', linearIdentifier: null });
  assert.strictEqual((await run({ mode: 'route', kind: 'opening-night-stage', env, router: bad, log() {} })).ok, false);
  const digest = fakeRouter({ action: 'queued' });
  assert.strictEqual((await run({ mode: 'route', kind: 'tony-ibdb-scraper', env, router: digest, log() {} })).ok, true);
});

test('run: a throwing router reports not-ok; resolve calls resolveCondition', async () => {
  const boom = { routeAlert: async () => { throw new Error('x'); }, resolveCondition() {} };
  assert.strictEqual((await run({ mode: 'route', kind: 'gitlab-token-failed', env, router: boom, log() {} })).ok, false);
  const r = fakeRouter({});
  await run({ mode: 'resolve', kind: 'lighthouse-regression', env, router: r, log() {} });
  assert.deepStrictEqual(r.calls[0], { resolve: KINDS['lighthouse-regression'] });
});
