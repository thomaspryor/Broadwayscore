import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { bundleBuildEnv } = require('../../scripts/lib/bundle-build-env');
const { BUILD_ENV } = require('../../scripts/lib/autonomous-checks');
const root = path.resolve(import.meta.dirname, '../..');

test('a bare performance build gets the existing public Sanity config', () => {
  const env = bundleBuildEnv({ PATH: '/bin' });
  for (const key of ['NEXT_PUBLIC_SANITY_PROJECT_ID', 'NEXT_PUBLIC_SANITY_DATASET', 'NEXT_PUBLIC_SANITY_API_VERSION']) {
    assert.equal(env[key], BUILD_ENV[key]);
  }
  assert.equal(env.PATH, '/bin');
  assert.equal(env.NEXT_PUBLIC_FEATURES, undefined);
  assert.equal(env.SKIP_HEAVY_PREBUILD, undefined);
});

test('explicit build configuration and feature flags are preserved', () => {
  const input = {
    NEXT_PUBLIC_SANITY_PROJECT_ID: 'another-project',
    NEXT_PUBLIC_SANITY_DATASET: 'preview',
    NEXT_PUBLIC_SANITY_API_VERSION: '2026-10-17',
    NEXT_PUBLIC_FEATURES: 'westEnd',
    SKIP_HEAVY_PREBUILD: 'false',
  };
  assert.deepEqual(bundleBuildEnv(input), input);
});

test('empty public settings are filled without mutating the caller environment', () => {
  const input = { NEXT_PUBLIC_SANITY_PROJECT_ID: '', NEXT_PUBLIC_SANITY_DATASET: '' };
  const env = bundleBuildEnv(input);
  assert.equal(env.NEXT_PUBLIC_SANITY_PROJECT_ID, BUILD_ENV.NEXT_PUBLIC_SANITY_PROJECT_ID);
  assert.equal(env.NEXT_PUBLIC_SANITY_DATASET, BUILD_ENV.NEXT_PUBLIC_SANITY_DATASET);
  assert.deepEqual(input, { NEXT_PUBLIC_SANITY_PROJECT_ID: '', NEXT_PUBLIC_SANITY_DATASET: '' });
});

test('the bundle CLI supplies the config and reports a failing build log', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bundle-build-env-'));
  try {
    // Stand in for npm, not the code under test. The real CLI must pass its
    // computed environment to the child and retain the child's error output.
    writeFileSync(path.join(dir, 'npm'), `#!${process.execPath}
const assert = require('node:assert/strict');
const { BUILD_ENV } = require(${JSON.stringify(path.join(root, 'scripts/lib/autonomous-checks.js'))});
assert.equal(process.argv[2], 'run');
assert.equal(process.argv[3], 'build');
for (const key of ['NEXT_PUBLIC_SANITY_PROJECT_ID', 'NEXT_PUBLIC_SANITY_DATASET', 'NEXT_PUBLIC_SANITY_API_VERSION']) {
  assert.equal(process.env[key], BUILD_ENV[key]);
}
assert.equal(process.env.NEXT_PUBLIC_FEATURES, 'westEnd');
console.error('BUILD_CONFIG_OK: simulated compilation failure');
process.exit(1);
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, NEXT_PUBLIC_FEATURES: 'westEnd' };
    for (const key of Object.keys(env)) if (key.startsWith('NEXT_PUBLIC_SANITY_')) delete env[key];
    const result = spawnSync(process.execPath, ['scripts/check-bundle-size.js', '--ci'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Build failed without producing size output/);
    assert.match(result.stderr, /BUILD_CONFIG_OK: simulated compilation failure/);
    assert.doesNotMatch(result.stdout, /All page sizes within budget/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
