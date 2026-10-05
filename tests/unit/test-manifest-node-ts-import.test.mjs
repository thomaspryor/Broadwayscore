import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const EXT = '.t' + 's'; // built at runtime so this file's own source never matches the guard
const { validateManifest } = require('../../scripts/lib/test-manifest.js');

function fixture(manifestName, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-ts-'));
  fs.writeFileSync(path.join(dir, 'a.test.mjs'), body);
  fs.writeFileSync(path.join(dir, manifestName), 'a.test.mjs\n');
  return { dir, manifest: path.join(dir, manifestName) };
}

test('node manifest rejects a test importing a .ts module (BRO-4647)', () => {
  const { dir, manifest } = fixture('unit-test-manifest.txt', "import { x } from '../src/lib/date-utils" + EXT + "';\n");
  const { errors } = validateManifest(manifest, dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /tsx manifest/);
});

test('tsx manifest accepts the same test', () => {
  const { dir, manifest } = fixture('unit-test-manifest-tsx.txt', "import { x } from '../src/lib/date-utils" + EXT + "';\n");
  assert.deepEqual(validateManifest(manifest, dir).errors, []);
});

test('node manifest accepts a plain-JS test', () => {
  const { dir, manifest } = fixture('unit-test-manifest.txt', "import fs from 'node:fs';\n");
  assert.deepEqual(validateManifest(manifest, dir).errors, []);
});

test('the real node manifest has no .ts-importing tests', () => {
  const root = path.join(import.meta.dirname, '..', '..');
  const { errors } = validateManifest(path.join(root, 'tests/unit-test-manifest.txt'), root);
  assert.deepEqual(errors, []);
});
