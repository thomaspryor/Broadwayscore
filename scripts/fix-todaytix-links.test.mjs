import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// fix-todaytix-links.js is a 9-line entry point; the logic lives in the checker.
test('entry point loads without running main, and the checker exports what it calls', () => {
  const checker = require('./lib/todaytix-link-checker');
  assert.equal(typeof checker.main, 'function');
  assert.equal(typeof checker.checkUrl, 'function');
  assert.doesNotThrow(() => require('./fix-todaytix-links.js'));
});
