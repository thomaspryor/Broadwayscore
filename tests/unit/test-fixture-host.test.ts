// The /test/* fixture pages must never render on the production site
// (BRO-4525). TestGuard used to rely on featureFlags.userAccounts being off in
// prod; launching accounts turns it on, so the guard also checks the host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTestFixtureHost } from '../../src/lib/test-fixture-host';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('local and demo hosts may render fixtures', () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]', 'demo.broadwayscorecard.com', 'LOCALHOST']) {
    assert.equal(isTestFixtureHost(h), true, h);
  }
});

test('production and preview hosts may not', () => {
  for (const h of ['broadwayscorecard.com', 'www.broadwayscorecard.com', 'operascorecard.com', 'bsc-git-x.vercel.app', 'demo.broadwayscorecard.com.evil.com', '']) {
    assert.equal(isTestFixtureHost(h), false, h);
  }
});

test('TestGuard checks the host, not only the accounts flag', () => {
  const src = readFileSync(path.join(ROOT, 'src/app/test/_components/TestGuard.tsx'), 'utf8');
  assert.match(src, /isTestFixtureHost\(window\.location\.hostname\)/);
  const layout = readFileSync(path.join(ROOT, 'src/app/test/layout.tsx'), 'utf8');
  assert.match(layout, /<TestGuard>\{children\}<\/TestGuard>/);
});
