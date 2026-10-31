import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { isCoveredByPublishedDuplicate } = require('./published-duplicate-coverage');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-dup-cov-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const TEXT = 'Same review text about the show, long enough to fingerprint properly.';
const put = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
put('target.json', { fullText: TEXT });
put('chain.json', { fullText: TEXT, duplicateOf: 'other.json' });
put('back.json', { fullText: TEXT, duplicateOf: 'a.json' });
const published = new Set(['target.json', 'chain.json', 'back.json']);
const cover = (data, file = 'a.json', keys = published) => isCoveredByPublishedDuplicate(data, file, dir, keys);

test('duplicateOf a published, non-circular, non-copy target is covered', () => {
  assert.equal(cover({ duplicateOf: 'target.json' }), true);
});
test('duplicateTextOf is covered only while the text still matches', () => {
  assert.equal(cover({ duplicateTextOf: 'target.json', fullText: TEXT }), true);
  assert.equal(cover({ duplicateTextOf: 'target.json', fullText: 'A completely different review body sharing nothing.' }), false);
});
test('unpublished target, self pointer, circular pair and chained target are not covered', () => {
  assert.equal(cover({ duplicateOf: 'ghost.json' }), false);
  assert.equal(cover({ duplicateOf: 'a.json' }), false);
  assert.equal(cover({ duplicateOf: 'back.json' }), false);
  assert.equal(cover({ duplicateOf: 'chain.json' }), false);
  assert.equal(cover({}), false);
});
