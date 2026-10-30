/**
 * BRO-6553: the muted-text token must stay WCAG AA (4.5:1) on every dark surface.
 * (text-contrast-guard.test.mjs covers leftover text-gray-500/600 in src; this covers the token itself.)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ratio, checkToken, SURFACES } = require('../../scripts/lib/text-contrast.js');

describe('fg-muted token contrast', () => {
  test('ratio math matches known WCAG values', () => {
    assert.ok(Math.abs(ratio('#ffffff', '#000000') - 21) < 0.01);
    assert.ok(Math.abs(ratio('#6b7280', '#1a1a24') - 3.6) < 0.1, 'old gray-500 on raised is the failing 3.6:1');
  });

  test('fg-muted passes AA on every surface token', () => {
    const { token, failures } = checkToken();
    assert.ok(token, 'fg-muted token present');
    assert.deepStrictEqual(failures, []);
  });

  test('a failing token is reported by checkToken', () => {
    const bad = checkToken(undefined, "colors: { 'fg-muted': '#6b7280' }");
    assert.strictEqual(bad.token, '#6b7280');
    assert.ok(bad.failures.length >= 3, 'old gray-500 fails on raised, overlay and elevated');
    assert.deepStrictEqual(checkToken(undefined, 'no token here').failures, ['fg-muted token missing from tailwind.config.ts']);
    assert.ok(ratio('#6b7280', SURFACES.raised) < 4.5);
  });
});
