// BRO-3517: duplicate-value scan over the sibling aggregator maps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { findDuplicateValues } = require('../../scripts/lib/cache-collision.js');
const { mapFor, scan } = require('../../scripts/audit-aggregator-url-duplicates.js');

test('findDuplicateValues groups case/protocol/www/trailing-slash variants', () => {
  const d = findDuplicateValues({
    a: 'https://www.Example.com/x/',
    b: 'http://example.com/x',
    c: 'https://example.com/y',
    d: { notFoundAt: 'z' },
    e: { url: 'https://example.com/y' },
  });
  assert.equal(d.length, 2);
  assert.deepEqual(d.map((x) => x.keys), [['a', 'b'], ['c', 'e']]);
});

test('mapFor reads .shows or the flat map without _meta keys', () => {
  assert.deepEqual(mapFor({ _meta: {}, shows: { a: 'u' } }), { a: 'u' });
  assert.deepEqual(mapFor({ _comment: 'x', a: 'u' }), { a: 'u' });
});

test('scan flags a planted duplicate and passes a clean file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-dup-'));
  fs.writeFileSync(path.join(dir, 'dirty.json'), JSON.stringify({ shows: { a: 'https://p.com/1', b: 'https://p.com/1/' } }));
  fs.writeFileSync(path.join(dir, 'clean.json'), JSON.stringify({ _comment: 'c', a: 'https://p.com/1', b: 'https://p.com/2' }));
  const r = scan(dir, [{ file: 'dirty.json' }, { file: 'clean.json' }, { file: 'gone.json' }]);
  assert.equal(r[0].duplicates.length, 1);
  assert.equal(r[1].duplicates.length, 0);
  assert.equal(r[2].missing, true);
});

test('real sibling maps have no duplicates', () => {
  for (const r of scan()) assert.deepEqual(r.duplicates, [], r.file);
});
