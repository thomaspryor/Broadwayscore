import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sortManifestFile } = require('../../scripts/lib/test-manifest.js');

function withTempManifest(contents, fn) {
  const tmpPath = path.join(os.tmpdir(), `test-manifest-sort-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(tmpPath, contents);
  try {
    return fn(tmpPath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

test('sortManifestFile sorts an out-of-order manifest and reports a change', () => {
  withTempManifest('b.test.mjs\na.test.mjs\nc.test.mjs\n', (tmpPath) => {
    const changed = sortManifestFile(tmpPath);
    assert.equal(changed, true);
    assert.equal(fs.readFileSync(tmpPath, 'utf8'), 'a.test.mjs\nb.test.mjs\nc.test.mjs\n');
  });
});

test('sortManifestFile is a no-op on an already-sorted manifest', () => {
  withTempManifest('a.test.mjs\nb.test.mjs\nc.test.mjs\n', (tmpPath) => {
    const before = fs.statSync(tmpPath).mtimeMs;
    const changed = sortManifestFile(tmpPath);
    assert.equal(changed, false);
    assert.equal(fs.readFileSync(tmpPath, 'utf8'), 'a.test.mjs\nb.test.mjs\nc.test.mjs\n');
    assert.equal(fs.statSync(tmpPath).mtimeMs, before, 'must not rewrite an already-sorted file');
  });
});

test('sortManifestFile normalizes blank lines and a missing trailing newline', () => {
  withTempManifest('b.test.mjs\n\na.test.mjs', (tmpPath) => {
    const changed = sortManifestFile(tmpPath);
    assert.equal(changed, true);
    assert.equal(fs.readFileSync(tmpPath, 'utf8'), 'a.test.mjs\nb.test.mjs\n');
  });
});
