import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseArgs, expandKeys } = require('../../scripts/print-review-text.js');

test('parseArgs reads --no-text and --core', () => {
  const a = parseArgs(['a/b.json', 'c/', '--no-text', '--core=x,y']);
  assert.deepEqual(a.keys, ['a/b.json', 'c/']);
  assert.equal(a.noText, true);
  assert.deepEqual(a.core, ['x', 'y']);
});

test('expandKeys lists a folder key, keeps file keys and unknown folders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-'));
  fs.mkdirSync(path.join(root, 'show-a'));
  fs.writeFileSync(path.join(root, 'show-a', 'z.json'), '{}');
  fs.writeFileSync(path.join(root, 'show-a', 'a.json'), '{}');
  fs.writeFileSync(path.join(root, 'show-a', 'notes.txt'), '');
  assert.deepEqual(expandKeys(['show-a/', 'show-b/x.json', 'missing/'], root),
    ['show-a/a.json', 'show-a/z.json', 'show-b/x.json', 'missing/']);
  assert.deepEqual(expandKeys(['../'], root), ['../']);
});
