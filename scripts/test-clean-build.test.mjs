import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Exercise the real shell entry point without running publishing generators in
// the unit batch. The node shim records which generators prebuild actually runs.
function prebuild(t, overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'clean-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls');
  const node = path.join(dir, 'node');
  writeFileSync(node, '#!/bin/sh\nprintf "%s\\n" "$1" >> "$CALL_LOG"\n[ "$1" != "$FAIL_SCRIPT" ]\n');
  chmodSync(node, 0o755);
  const result = spawnSync('bash', ['scripts/prebuild.sh'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${dir}:${process.env.PATH}`, CALL_LOG: log,
      CI: '', VERCEL: '', REGENERATE_BUILD_DATA: '', SKIP_HEAVY_PREBUILD: '',
      FAIL_SCRIPT: '', ...overrides,
    },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(f => path.basename(f));
  return { ...result, calls };
}

test('local prebuild only regenerates ignored prerequisites, including with NODE_ENV=production', t => {
  for (const env of [{}, { NODE_ENV: 'production' }, { CI: 'false', VERCEL: '0' }]) {
    const result = prebuild(t, env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [
      'validate-shows-prebuild.js', 'generate-show-lookup.js', 'generate-diary-data.js',
      'generate-related-shows-mobile.js', 'build-actor-slugs-manifest.js',
      'build-cast-manifest.js', 'build-coverage-floor-snapshot.js', 'generate-stats-shows.js',
    ]);
  }
});

test('CI, Vercel and an explicit local refresh retain the full publishing path', t => {
  const ci = prebuild(t, { CI: 'true' });
  assert.equal(ci.status, 0, ci.stderr);
  for (const generator of [
    'build-slug-redirects.js', 'generate-brand-tokens.js', 'generate-outlet-logos.js',
    'generate-blog-reviews-for-scoring.js', 'generate-mobile-show-details.js',
    'generate-search-shows.js', 'compute-gold-lists.js', 'generate-mobile-data.js',
    'generate-homepage-archive.js', 'generate-west-end-archive.js',
  ]) assert.ok(ci.calls.includes(generator), generator);
  assert.ok(ci.calls.indexOf('build-cast-manifest.js') < ci.calls.indexOf('build-slug-redirects.js'));
  assert.ok(ci.calls.indexOf('generate-blog-reviews-for-scoring.js') < ci.calls.indexOf('generate-mobile-show-details.js'));
  assert.ok(ci.calls.indexOf('generate-mobile-data.js') < ci.calls.indexOf('generate-stats-shows.js'));
  for (const env of [{ CI: '1' }, { VERCEL: '1' }, { REGENERATE_BUILD_DATA: 'true' }]) {
    const result = prebuild(t, env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, ci.calls);
  }
});

test('the code-only CI path still refreshes show details before skipping heavy generators', t => {
  const result = prebuild(t, { CI: 'true', SKIP_HEAVY_PREBUILD: 'true' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.includes('generate-mobile-show-details.js'));
  assert.ok(!result.calls.includes('generate-mobile-data.js'));
  assert.equal(result.calls.at(-1), 'generate-stats-shows.js');
});

test('validation failures still abort local prebuild', t => {
  const result = prebuild(t, { FAIL_SCRIPT: 'scripts/validate-shows-prebuild.js' });
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, ['validate-shows-prebuild.js']);
});

test('Next dev leaves the project agent instructions intact', async t => {
  const config = require('../next.config.js');
  assert.equal(config.agentRules, false);
  const dir = mkdtempSync(path.join(tmpdir(), 'clean-build-agents-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agents = path.join(dir, 'AGENTS.md');
  const instructions = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  writeFileSync(agents, instructions);
  const { syncAgentRulesForDev } = require('next/dist/server/lib/app-info-log.js');
  await syncAgentRulesForDev(dir, config.agentRules);
  assert.equal(readFileSync(agents, 'utf8'), instructions);
});
