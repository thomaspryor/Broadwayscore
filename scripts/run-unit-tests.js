#!/usr/bin/env node
'use strict';

// Local equivalent of the "unit-tests" job in .github/workflows/test.yml.
// Runs the SAME two manifests CI reads, each under the SAME runner CI uses —
// instead of `node --test 'tests/unit/*.test.mjs'`, which globs the
// directory and sweeps tsx-only files (registered in
// tests/unit-test-manifest-tsx.txt because they import TS through the `@/`
// path alias) into the plain-node batch, where they fail unconditionally
// with ERR_MODULE_NOT_FOUND regardless of whether the tree is green
// (BRO-3061).
//
// This intentionally runs everything the CI unit-tests job runs — including
// the scripts/** entries in the node manifest, not just tests/unit/ — so a
// passing `npm run test:unit` means the same thing locally as a passing CI
// unit-tests job. Slower than a tests/unit/-only glob, by design: local/CI
// parity matters more than speed here.

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { validateManifest } = require('./lib/test-manifest.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const repoRoot = path.join(__dirname, '..');
const TEST_TIMEOUT_MS = '300000';

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/run-unit-tests.js\n\nRuns the same two manifests as CI\'s "unit-tests" job (tests/unit-test-manifest.txt under node --test, tests/unit-test-manifest-tsx.txt under npx tsx --test). Takes no arguments.');
  process.exit(0);
}

const BATCHES = [
  {
    manifest: 'tests/unit-test-manifest.txt',
    label: 'node',
    command: 'node',
    baseArgs: ['--test', '--test-timeout', TEST_TIMEOUT_MS],
  },
  {
    manifest: 'tests/unit-test-manifest-tsx.txt',
    label: 'tsx',
    command: 'npx',
    baseArgs: ['tsx', '--test', '--test-timeout', TEST_TIMEOUT_MS],
  },
];

function main() {
  let exitCode = 0;

  for (const { manifest, label, command, baseArgs } of BATCHES) {
    const manifestPath = path.join(repoRoot, manifest);
    const { entries, errors } = validateManifest(manifestPath, repoRoot);
    if (errors.length > 0) {
      console.error(`${manifest} failed validation:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
      exitCode = 1;
      continue;
    }

    console.log(`\n── ${label} batch: ${entries.length} files from ${manifest} ──`);
    const result = spawnSync(command, [...baseArgs, ...entries], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    if (result.status !== 0) exitCode = 1;
  }

  process.exit(exitCode);
}

main();
