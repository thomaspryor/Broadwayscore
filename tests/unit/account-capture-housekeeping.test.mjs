import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { showFollowEligible, signInOpenerProperties } = require('../../src/lib/account-capture.js');

test('show follow waits for auth and remains available to signed-out visitors', () => {
  assert.equal(showFollowEligible(true, false), false);
  assert.equal(showFollowEligible(false, true), false);
  assert.equal(showFollowEligible(false, false), true);
});

test('all sign-in stages use the opener in both properties', () => {
  for (const source of ['show_rate_link', 'header', 'show_bookmark']) {
    assert.deepEqual(signInOpenerProperties(source), { source, context: source });
  }
});

test('the banner and prompt producers use the shared decisions', async () => {
  const { readFile } = await import('node:fs/promises');
  const banner = await readFile(new URL('../../src/components/ShowFollowBanner.tsx', import.meta.url), 'utf8');
  const auth = await readFile(new URL('../../src/contexts/AuthContext.tsx', import.meta.url), 'utf8');
  assert.match(banner, /showFollowEligible\(loading, isAuthenticated\)/);
  assert.match(auth, /trackUgc\('sign_in_prompt_shown', signInOpenerProperties\(src\)\)/);
});
