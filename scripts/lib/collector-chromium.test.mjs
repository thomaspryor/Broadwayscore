import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCollectorChromium } = require('./collector-chromium');

test('collector uses the launcher whose browsers the Playwright CLI installs', () => {
  const chromium = createCollectorChromium();
  const installed = require('playwright').chromium;
  assert.strictEqual(chromium.launcher, installed);
  assert.equal(chromium.executablePath(), installed.executablePath());
});

test('collector keeps stealth support without sharing plugins with other launchers', () => {
  const chromium = createCollectorChromium();
  const other = createCollectorChromium();
  const stealth = require('puppeteer-extra-plugin-stealth')();
  assert.strictEqual(chromium.use(stealth), chromium);
  assert.ok(chromium.plugins.list.includes(stealth));
  assert.ok(!other.plugins.list.includes(stealth));
  assert.ok(!require('playwright-extra').chromium.plugins.list.includes(stealth));
});
