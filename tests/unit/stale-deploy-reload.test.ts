/**
 * Stale-tab recovery after a deploy (src/lib/stale-deploy-reload.ts, BRO-5565).
 * Error shapes are the real Sentry events BROADWAY-SCORECARD-2J / -2B.
 * Run: npx tsx --test tests/unit/stale-deploy-reload.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStaleDeployError, reloadOnStaleDeploy, STALE_RELOAD_KEY, STALE_RELOAD_WINDOW_MS } from '../../src/lib/stale-deploy-reload';

(globalThis as unknown as Record<string, unknown>).window = globalThis;

const WEBPACK_STACK = 'TypeError: x\n    at a (https://broadwayscorecard.com/_next/static/chunks/webpack-d17dd301cb48573d.js:1:143)';
const err = (message: string, stack: string, name = 'TypeError') => Object.assign(new Error(message), { name, stack });

class Mem { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } }

test('Chrome and Safari wording of the webpack missing-module crash are stale-deploy errors', () => {
  assert.equal(isStaleDeployError(err("Cannot read properties of undefined (reading 'call')", WEBPACK_STACK)), true);
  assert.equal(isStaleDeployError(err("undefined is not an object (evaluating 'd[e].call')", WEBPACK_STACK)), true);
});

test('Firefox wording counts, including $ in minified names', () => {
  assert.equal(isStaleDeployError(err('e[o] is undefined', WEBPACK_STACK)), true);
  assert.equal(isStaleDeployError(err("undefined is not an object (evaluating '$[e].call')", WEBPACK_STACK)), true);
  assert.equal(isStaleDeployError(err('e[o] is undefined', 'at foo (https://broadwayscorecard.com/_next/static/chunks/app-1.js:1:1)')), false);
});

test('chunk load failures count', () => {
  assert.equal(isStaleDeployError(err('Loading chunk 5357 failed.', '', 'ChunkLoadError')), true);
});

test("an ordinary 'reading call' bug outside the webpack runtime does not trigger a reload", () => {
  assert.equal(isStaleDeployError(err("Cannot read properties of undefined (reading 'call')", 'at foo (https://broadwayscorecard.com/_next/static/chunks/app-1.js:1:1)')), false);
});

test('other errors and non-errors never match', () => {
  assert.equal(isStaleDeployError(err("Cannot read properties of undefined (reading 'map')", WEBPACK_STACK)), false);
  assert.equal(isStaleDeployError(null), false);
  assert.equal(isStaleDeployError('reading call'), false);
});

test('reloads once, then not again inside the window, then again after it', () => {
  const storage = new Mem();
  let reloads = 0;
  const run = (now: number) => reloadOnStaleDeploy({ storage, now, reload: () => { reloads++; }, pathname: '/west-end' });
  assert.equal(run(1_000_000), true);
  assert.equal(run(1_000_000 + 1000), false, 'a bug that survives the reload must not loop');
  assert.equal(reloads, 1);
  assert.equal(storage.getItem(STALE_RELOAD_KEY), '1000000');
  assert.equal(run(1_000_000 + STALE_RELOAD_WINDOW_MS + 1), true);
  assert.equal(reloads, 2);
});

test('never reloads without a loop guard or on the OAuth return pages', () => {
  let reloads = 0;
  const reload = () => { reloads++; };
  assert.equal(reloadOnStaleDeploy({ storage: null, reload, pathname: '/' }), false);
  const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(reloadOnStaleDeploy({ storage: throwing, reload, pathname: '/' }), false);
  assert.equal(reloadOnStaleDeploy({ storage: new Mem(), reload, pathname: '/auth/callback' }), false);
  assert.equal(reloads, 0);
});

test('does not reload while the visitor is typing, and does not spend the loop guard', () => {
  const storage = new Mem();
  let reloads = 0;
  assert.equal(reloadOnStaleDeploy({ storage, reload: () => { reloads++; }, pathname: '/', typing: true }), false);
  assert.equal(storage.getItem(STALE_RELOAD_KEY), null);
  assert.equal(reloads, 0);
});

test('onReload runs before the reload, and a throwing onReload cannot block it', () => {
  const order: string[] = [];
  reloadOnStaleDeploy({ storage: new Mem(), pathname: '/', typing: false, onReload: () => order.push('count'), reload: () => order.push('reload') });
  assert.deepEqual(order, ['count', 'reload']);
  const order2: string[] = [];
  reloadOnStaleDeploy({ storage: new Mem(), pathname: '/', typing: false, onReload: () => { throw new Error('x'); }, reload: () => order2.push('reload') });
  assert.deepEqual(order2, ['reload']);
});
