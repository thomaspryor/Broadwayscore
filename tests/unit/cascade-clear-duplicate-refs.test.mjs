// TESTS-VS-DERIVED-DATA-EXEMPT: unit test for a pure helper; uses an isolated tmp dir, no production data files.
/**
 * Unit tests for scripts/lib/cascade-clear-duplicate-refs.js.
 *
 * Background: 2026-05-26 CI failure showed that when rebuild-all-reviews
 * deletes a *--unknown.json sibling, any other review file that pointed
 * at it via `duplicateOf` is left dangling. The audit-duplicate-of-url-
 * mismatch gate then fails Data Validation until --fix is run manually.
 *
 * The fix wires `cascadeClearDuplicateRefs(dir, toDelete)` immediately
 * before each `fs.unlinkSync` in rebuild-all-reviews.js. These tests pin
 * the helper's contract: clear matching siblings, leave non-matching
 * siblings alone, stamp a breadcrumb, and survive missing directories.
 *
 * Run: node --test tests/unit/cascade-clear-duplicate-refs.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { cascadeClearDuplicateRefs } = require('../../scripts/lib/cascade-clear-duplicate-refs.js');

function mkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-clear-'));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('clears duplicateOf in sibling pointing at deleted file', () => {
  const dir = mkdir();
  try {
    writeJson(path.join(dir, 'nytimes--unknown.json'), { url: 'https://x.com/a' });
    writeJson(path.join(dir, 'nytimes--jesse-green.json'), {
      url: 'https://x.com/a',
      criticName: 'Jesse Green',
      duplicateOf: 'nytimes--unknown.json',
      duplicateReason: 'url-collision-detected-at-write',
    });

    const cleared = cascadeClearDuplicateRefs(dir, 'nytimes--unknown.json');
    assert.deepStrictEqual(cleared, ['nytimes--jesse-green.json']);

    const written = readJson(path.join(dir, 'nytimes--jesse-green.json'));
    assert.equal(written.duplicateOf, null);
    assert.equal(written.duplicateReason, null);
    assert.match(written.duplicateClearReason, /cascade-cleared: sibling nytimes--unknown\.json was deleted/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('leaves siblings whose duplicateOf points at a different file alone', () => {
  const dir = mkdir();
  try {
    writeJson(path.join(dir, 'a.json'), {
      url: 'https://x.com/a',
      duplicateOf: 'b.json',
      duplicateReason: 'url-collision-detected-at-write',
    });
    writeJson(path.join(dir, 'b.json'), { url: 'https://x.com/b' });

    const cleared = cascadeClearDuplicateRefs(dir, 'c.json');
    assert.deepStrictEqual(cleared, []);
    // a.json still references b.json — unchanged.
    const after = readJson(path.join(dir, 'a.json'));
    assert.equal(after.duplicateOf, 'b.json');
    assert.equal(after.duplicateReason, 'url-collision-detected-at-write');
    assert.equal(after.duplicateClearReason, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clears multiple siblings that all point at the deleted file', () => {
  const dir = mkdir();
  try {
    writeJson(path.join(dir, 'unknown.json'), { url: 'shared' });
    writeJson(path.join(dir, 'a.json'), { url: 'shared', duplicateOf: 'unknown.json' });
    writeJson(path.join(dir, 'b.json'), { url: 'shared', duplicateOf: 'unknown.json' });
    writeJson(path.join(dir, 'c.json'), { url: 'other', duplicateOf: 'unrelated.json' });

    const cleared = cascadeClearDuplicateRefs(dir, 'unknown.json').sort();
    assert.deepStrictEqual(cleared, ['a.json', 'b.json']);
    assert.equal(readJson(path.join(dir, 'a.json')).duplicateOf, null);
    assert.equal(readJson(path.join(dir, 'b.json')).duplicateOf, null);
    assert.equal(readJson(path.join(dir, 'c.json')).duplicateOf, 'unrelated.json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('survives missing directory and empty filename inputs', () => {
  assert.deepStrictEqual(cascadeClearDuplicateRefs('/nonexistent/path/here', 'x.json'), []);
  const dir = mkdir();
  try {
    assert.deepStrictEqual(cascadeClearDuplicateRefs(dir, ''), []);
    assert.deepStrictEqual(cascadeClearDuplicateRefs(dir, null), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ignores non-JSON files and unreadable files', () => {
  const dir = mkdir();
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), 'hello');
    fs.writeFileSync(path.join(dir, 'corrupt.json'), 'not valid json {{{');
    writeJson(path.join(dir, 'good.json'), {
      url: 'x',
      duplicateOf: 'unknown.json',
    });

    const cleared = cascadeClearDuplicateRefs(dir, 'unknown.json');
    assert.deepStrictEqual(cleared, ['good.json']);
    // Corrupt file is left as-is.
    assert.equal(fs.readFileSync(path.join(dir, 'corrupt.json'), 'utf8'), 'not valid json {{{');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('does not modify the file about to be deleted', () => {
  const dir = mkdir();
  try {
    const targetPath = path.join(dir, 'to-delete.json');
    writeJson(targetPath, { url: 'x', shouldStayUntouched: true });
    writeJson(path.join(dir, 'sibling.json'), { duplicateOf: 'to-delete.json' });

    cascadeClearDuplicateRefs(dir, 'to-delete.json');
    const target = readJson(targetPath);
    assert.equal(target.shouldStayUntouched, true);
    assert.equal(target.duplicateClearReason, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clears dangling duplicateTextOf by deleting the field (not nulling)', () => {
  const dir = mkdir();
  try {
    writeJson(path.join(dir, 'the-sun--dominic-maxwell.json'), { url: 'https://x.com/a' });
    writeJson(path.join(dir, 'the-sun--thea-jacobs.json'), {
      url: 'https://x.com/b',
      criticName: 'Thea Jacobs',
      duplicateTextOf: 'the-sun--dominic-maxwell.json',
    });

    const cleared = cascadeClearDuplicateRefs(dir, 'the-sun--dominic-maxwell.json');
    assert.deepStrictEqual(cleared, ['the-sun--thea-jacobs.json']);

    const written = readJson(path.join(dir, 'the-sun--thea-jacobs.json'));
    // Field must be ABSENT — validate-data flags `null` as "should be string, got object".
    assert.equal('duplicateTextOf' in written, false);
    assert.match(written.duplicateClearReason, /cascade-cleared: sibling the-sun--dominic-maxwell\.json was deleted/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clears both duplicateOf and duplicateTextOf when both dangle in one sibling', () => {
  const dir = mkdir();
  try {
    writeJson(path.join(dir, 'gone.json'), { url: 'shared' });
    writeJson(path.join(dir, 'both.json'), {
      url: 'shared',
      duplicateOf: 'gone.json',
      duplicateReason: 'url-collision-detected-at-write',
      duplicateTextOf: 'gone.json',
    });
    writeJson(path.join(dir, 'text-only.json'), { url: 'other', duplicateTextOf: 'gone.json' });
    writeJson(path.join(dir, 'unrelated.json'), { url: 'z', duplicateTextOf: 'other.json' });

    const cleared = cascadeClearDuplicateRefs(dir, 'gone.json').sort();
    assert.deepStrictEqual(cleared, ['both.json', 'text-only.json']);
    const both = readJson(path.join(dir, 'both.json'));
    assert.equal(both.duplicateOf, null);
    assert.equal(both.duplicateReason, null);
    assert.equal('duplicateTextOf' in both, false);
    assert.equal('duplicateTextOf' in readJson(path.join(dir, 'text-only.json')), false);
    assert.equal(readJson(path.join(dir, 'unrelated.json')).duplicateTextOf, 'other.json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('persistence injection — custom writeFile lets tests stub disk writes', () => {
  const dir = mkdir();
  try {
    writeJson(path.join(dir, 'sibling.json'), { duplicateOf: 'gone.json' });
    const writes = [];
    const cleared = cascadeClearDuplicateRefs(dir, 'gone.json', {
      writeFile: (p, json) => writes.push({ p: path.basename(p), json }),
    });
    assert.deepStrictEqual(cleared, ['sibling.json']);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].p, 'sibling.json');
    assert.equal(writes[0].json.duplicateOf, null);
    // Confirm default writer was NOT used (file on disk still has old data).
    assert.equal(readJson(path.join(dir, 'sibling.json')).duplicateOf, 'gone.json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
