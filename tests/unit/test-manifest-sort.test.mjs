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

// BRO-3426's 178c0ccb02c appended tests/unit/done-evidence-audit.test.mjs while
// that entry already sat in its sorted position, so the manifest carried it
// twice and main went red on the sortedness check alone. Sorting WITHOUT
// deduping would have laundered that defect: the two copies sort adjacent, the
// check then passes, and the test file stays registered twice. Both halves of
// the guard are pinned here.
const { validateManifest } = require('../../scripts/lib/test-manifest.js');

test('sortManifestFile drops a duplicate entry rather than parking the copies adjacent', () => {
  withTempManifest('b.test.mjs\na.test.mjs\nb.test.mjs\n', (p) => {
    assert.equal(sortManifestFile(p), true, 'a duplicated manifest is not already clean');
    assert.equal(fs.readFileSync(p, 'utf8'), 'a.test.mjs\nb.test.mjs\n');
    assert.equal(sortManifestFile(p), false, 'and the result is idempotent');
  });
});

test('sortManifestFile dedupes even when the duplicate is ALREADY in sorted position', () => {
  // The exact shape the sortedness check cannot see on its own.
  withTempManifest('a.test.mjs\na.test.mjs\nb.test.mjs\n', (p) => {
    assert.equal(sortManifestFile(p), true);
    assert.equal(fs.readFileSync(p, 'utf8'), 'a.test.mjs\nb.test.mjs\n');
  });
});

test('validateManifest reports a duplicate by name, sorted or not', () => {
  withTempManifest('a.test.mjs\na.test.mjs\nb.test.mjs\n', (p) => {
    const { errors } = validateManifest(p, path.dirname(p));
    const dup = errors.filter((e) => e.includes('more than once'));
    assert.equal(dup.length, 1, `expected one duplicate error, got: ${JSON.stringify(errors)}`);
    assert.match(dup[0], /a\.test\.mjs/);
    assert.ok(!errors.some((e) => e.includes('not sorted')),
      'an already-sorted duplicate must be caught by the duplicate check, not the sort check');
  });
});

test('validateManifest names each distinct duplicate exactly once', () => {
  withTempManifest('a.test.mjs\na.test.mjs\na.test.mjs\nb.test.mjs\nb.test.mjs\n', (p) => {
    const { errors } = validateManifest(p, path.dirname(p));
    const dup = errors.find((e) => e.includes('more than once'));
    assert.ok(dup, 'a duplicate error is present');
    assert.equal((dup.match(/a\.test\.mjs/g) || []).length, 1, 'a.test.mjs listed once');
    assert.equal((dup.match(/b\.test\.mjs/g) || []).length, 1, 'b.test.mjs listed once');
  });
});

test('validateManifest stays silent on a clean manifest', () => {
  withTempManifest('a.test.mjs\nb.test.mjs\n', (p) => {
    const { errors } = validateManifest(p, path.dirname(p));
    assert.deepEqual(errors.filter((e) => e.includes('more than once')), []);
  });
});
