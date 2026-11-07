// BRO-6872 card acceptance (VERIFY line in scripts/check-provider-spend.js): passes when no Browserbase caller
// allowance in scripts/lib/browserbase-caps.js ends within 14 days of today. Reads the wall clock, so it is kept
// out of every unit manifest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { expiringCallerAllowances } = require('../../scripts/lib/browserbase-caps.js');

test('no Browserbase caller allowance ends within the warning window', () => {
  assert.deepEqual(expiringCallerAllowances(), []);
});
