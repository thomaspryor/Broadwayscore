import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MANIFESTS, validateManifest } = require('../../scripts/lib/test-manifest.js');

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

for (const manifest of MANIFESTS) {
  test(`${manifest} is non-empty and every listed file exists`, () => {
    const manifestPath = path.join(repoRoot, manifest);
    const { entries, errors } = validateManifest(manifestPath, repoRoot);
    assert.deepEqual(errors, []);
    assert.ok(entries.length > 0, `${manifest} must list at least one test file`);
  });
}
