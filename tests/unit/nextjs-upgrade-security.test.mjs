/**
 * BRO-3203: Next 14.2.35 was the last 14.x and could not be patched for
 * GHSA-p293-qw3h-jr36 / GHSA-2xp9-vwfh-vxw4 (first fixed in 15.5.24), so
 * BRO-3202 allowlisted them until 2026-11-15. The 15.5 upgrade removed both.
 * This pins the floor so a downgrade or a re-added exemption fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ALLOWLIST } = require('../../scripts/audit-dependencies.js');
const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(fs.readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));

const FIXED_ADVISORIES = ['GHSA-p293-qw3h-jr36', 'GHSA-2xp9-vwfh-vxw4'];
const FIRST_PATCHED = [15, 5, 24];

function atLeast(version, floor) {
  const parts = version.replace(/^[^\d]*/, '').split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== floor[i]) return parts[i] > floor[i];
  }
  return true;
}

test('the locked next version is at or above the first patched release', () => {
  const locked = lock.packages['node_modules/next']?.version;
  assert.ok(locked, 'next missing from package-lock.json');
  assert.ok(atLeast(locked, FIRST_PATCHED), `locked next ${locked} is below 15.5.24`);
  assert.ok(atLeast(pkg.dependencies.next, FIRST_PATCHED), `package.json pins next ${pkg.dependencies.next}`);
});

test('eslint-config-next moves in lockstep with next', () => {
  assert.equal(pkg.devDependencies['eslint-config-next'], pkg.dependencies.next);
});

test('the fixed advisories carry no allowlist exemption', () => {
  for (const ghsa of FIXED_ADVISORIES) {
    assert.equal(ALLOWLIST.find((a) => a.ghsa === ghsa), undefined, `${ghsa} is still allowlisted`);
  }
});

test('atLeast compares numerically, not as strings', () => {
  assert.equal(atLeast('15.5.24', FIRST_PATCHED), true);
  assert.equal(atLeast('15.10.0', FIRST_PATCHED), true);
  assert.equal(atLeast('16.0.0', FIRST_PATCHED), true);
  assert.equal(atLeast('15.5.9', FIRST_PATCHED), false);
  assert.equal(atLeast('14.2.35', FIRST_PATCHED), false);
});
