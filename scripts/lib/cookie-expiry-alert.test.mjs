import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const A = require('./cookie-expiry-alert.js');
const { checkAuthExpiry } = require('../check-cookie-health.js');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

const NOW = Date.now() / 1000;
const NYT_AUTH = ['NYT-S', 'nyt-a'];
const cookies = (expires) => NYT_AUTH.map(name => ({ name, value: 'x', expires }));

// Build a layer-2 result exactly the way check-cookie-health.js main() does.
function layer2(name, expires) {
  const auth = checkAuthExpiry(cookies(expires), NYT_AUTH);
  return { name, status: auth.status, message: auth.message, isCritical: true, layer: 2, authDays: auth.authDays };
}

function fakeRouter() {
  const routed = [], resolved = [];
  return {
    routed, resolved,
    routeAlert: async (o) => { routed.push(o); return { ok: true }; },
    resolveCondition: (k, o) => { resolved.push([k, o && o.reason]); return true; },
    log: { error() {} },
  };
}

test('the Oct 27 NYT state (both auth cookies expired) opens an auto card (BRO-6628)', async () => {
  const results = [layer2('nytimes', NOW - 86400)];
  assert.equal(results[0].status, 'fail');
  assert.equal(results[0].authDays, -1);
  const r = fakeRouter();
  const out = await A.routeCookieAlerts(results, 1, r);
  assert.deepEqual(out.routed, ['nytimes']);
  assert.equal(r.routed.length, 1);
  const o = r.routed[0];
  assert.equal(o.conditionKey, 'cookie-health:t1-auth-expired:nytimes');
  assert.equal(o.disposition, 'auto', 'files a Linear card, not a digest line');
  assert.match(o.title, /nytimes auth cookies are EXPIRED/);
  assert.match(o.description, /BRO-6590/, 'tells the worker not to renew from CI');
});

test('a cookie inside the fail window (<1d left) also files a card', async () => {
  const results = [layer2('nytimes', NOW + 3600 * 6)];
  assert.equal(results[0].status, 'fail');
  const out = await A.routeCookieAlerts(results, 1, fakeRouter());
  assert.deepEqual(out.routed, ['nytimes']);
});

test('healthy T1 cookies file nothing and resolve any open incident', async () => {
  const r = fakeRouter();
  const out = await A.routeCookieAlerts([layer2('nytimes', NOW + 40 * 86400)], 1, r);
  assert.deepEqual(out.routed, []);
  assert.deepEqual(r.resolved, [['cookie-health:t1-auth-expired:nytimes', 'cookies healthy again']]);
});

// BRO-5628 replay (via BRO-7079): The Stage's login died before the De
// Profundis opening and nothing paged, because only T1 Layer-2 expiry routed.
test('a critical non-T1 outlet with expired cookies files a warn card (BRO-5628)', async () => {
  const r = fakeRouter();
  const out = await A.routeCookieAlerts([layer2('thestage', NOW - 86400), layer2('wsj', NOW + 40 * 86400)], 1, r);
  assert.deepEqual(out.routed, ['thestage']);
  assert.equal(r.routed[0].severity, 'warn');
  assert.equal(r.routed[0].conditionKey, A.conditionKeyFor('thestage'));
  assert.ok(r.resolved.some(([k]) => k === A.conditionKeyFor('wsj')));
});

test('a Layer-3 live-access failure files a warn card even for T1; warn-level results do not', async () => {
  const live = { name: 'thestage', layer: 3, status: 'fail', message: 'logged out', isCritical: true };
  const t1live = { name: 'nytimes', layer: 3, status: 'fail', message: 'paywalled', isCritical: true };
  const warn = { name: 'variety', layer: 2, status: 'warn', authDays: 9, isCritical: true };
  assert.deepEqual(A.findCookieFailures([live, t1live, warn], 1).map(r => r.name), ['thestage', 'nytimes']);
  const r = fakeRouter();
  await A.routeCookieAlerts([live, t1live], 1, r);
  assert.deepEqual(r.routed.map(o => o.severity), ['warn', 'warn']);
  assert.match(r.routed[0].title, /live access check/);
});

test('an outlet failing both ways reports the auth expiry; non-critical outlets and skips are ignored', () => {
  const live = { name: 'nytimes', layer: 3, status: 'fail', message: 'x', isCritical: true };
  const auth = layer2('nytimes', NOW - 86400);
  const out = A.findCookieFailures([live, auth], 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].layer, 2);
  const minor = { name: 'playbill', layer: 2, status: 'fail', authDays: -1, isCritical: false, message: 'x' };
  const skip = { name: 'wsj', layer: 3, status: 'skip', isCritical: true };
  assert.deepEqual(A.findCookieFailures([minor, skip], 1), []);
  assert.deepEqual(A.findCookieHealthy([minor, skip], 1), []);
});

test('a routing error is reported but never thrown (the check keeps its own exit code)', async () => {
  const r = fakeRouter();
  r.routeAlert = async () => { throw new Error('LINEAR_API_KEY not set'); };
  const out = await A.routeCookieAlerts([layer2('nytimes', NOW - 86400)], 1, r);
  assert.deepEqual(out.routed, []);
  assert.match(out.errors[0], /nytimes: LINEAR_API_KEY not set/);
});

test('check-cookie-health.js routes the card before it exits non-zero, and the workflow can file and persist it', () => {
  const js = fs.readFileSync(path.join(ROOT, 'scripts/check-cookie-health.js'), 'utf8');
  const route = js.indexOf('routeCookieAlerts(results, AUTH_ERROR_DAYS)');
  const exit = js.indexOf('process.exit(1);', route);
  assert.ok(route > 0 && exit > route, 'routes the card before the critical-failure exit');
  const y = fs.readFileSync(path.join(ROOT, '.github/workflows/check-cookie-health.yml'), 'utf8');
  assert.match(y, /LINEAR_API_KEY: \$\{\{ secrets\.LINEAR_API_KEY \}\}/);
  assert.match(y, /npm ci/);
  assert.match(y, /git add data\/audit\/alert-ledger\.json/);
});

test('missing cookies (authDays null) neither file a card nor resolve an open one', async () => {
  const r = fakeRouter();
  const missing = [{ name: 'nytimes', layer: 2, status: 'warn', authDays: null, isCritical: true }];
  const out = await A.routeCookieAlerts(missing, 1, r);
  assert.deepEqual(out.routed, []);
  assert.deepEqual(r.resolved, []);
});

test('routeAlert returning ok:false is an error, not a routed card', async () => {
  const r = fakeRouter();
  r.routeAlert = async () => ({ ok: false, error: 'linear 500' });
  const out = await A.routeCookieAlerts([layer2('nytimes', NOW - 86400)], 1, r);
  assert.deepEqual(out.routed, []);
  assert.match(out.errors[0], /nytimes: linear 500/);
});

// Ship-check review of BRO-5628: a no-cookie outlet failing live is not a
// cookie card, and a run with only a healthy expiry read (live check off)
// must not close a live-access card, which has its own key.
test('no-cookie outlets file no card; expiry health never resolves a live-access card', async () => {
  const nypost = { name: 'nytimes', layer: 3, status: 'fail', message: 'x', isCritical: true, noCookiesRequired: true };
  assert.deepEqual(A.findCookieFailures([nypost], 1), []);
  const r = fakeRouter();
  await A.routeCookieAlerts([{ name: 'thestage', layer: 3, status: 'fail', message: 'logged out', isCritical: true }], 1, r);
  assert.equal(r.routed[0].conditionKey, A.conditionKeyFor('thestage', true));
  assert.notEqual(A.conditionKeyFor('thestage', true), A.conditionKeyFor('thestage'));
  const r2 = fakeRouter();
  await A.routeCookieAlerts([layer2('thestage', NOW + 40 * 86400)], 1, r2);
  assert.deepEqual(r2.resolved.map(([k]) => k), [A.conditionKeyFor('thestage')]);
  const r3 = fakeRouter();
  await A.routeCookieAlerts([{ name: 'thestage', layer: 3, status: 'pass', message: 'ok', isCritical: true }], 1, r3);
  assert.deepEqual(r3.resolved.map(([k]) => k), [A.conditionKeyFor('thestage', true)]);
});
