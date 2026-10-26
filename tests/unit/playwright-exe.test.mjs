import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pickExecutable, launchExtras, CLOUD_CHROMIUM } = require('../../scripts/lib/playwright-exe.js');

test('bundled browser present: no override', () => {
  assert.equal(pickExecutable({ bundled: '/a/chrome', exists: () => true }), null);
});
test('bundled browser missing, cloud chromium present: override', () => {
  assert.equal(pickExecutable({ bundled: '/a/chrome', exists: (p) => p === CLOUD_CHROMIUM }), CLOUD_CHROMIUM);
});
test('both missing: no override', () => {
  assert.equal(pickExecutable({ bundled: '/a/chrome', exists: () => false }), null);
});
test('launchExtras survives a chromium whose executablePath throws', () => {
  const r = launchExtras({ executablePath() { throw new Error('nope'); } });
  assert.ok(r.executablePath === undefined || r.executablePath === CLOUD_CHROMIUM);
  assert.deepEqual(Object.keys(r).filter((k) => k !== 'executablePath'), []);
});
