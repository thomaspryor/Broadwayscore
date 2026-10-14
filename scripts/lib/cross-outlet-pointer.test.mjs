/**
 * Tests for scripts/lib/cross-outlet-pointer.js (BRO-5348).
 * Run: node --test scripts/lib/cross-outlet-pointer.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { crossOutletPointer, skipAsAlreadyFlagged } = require('./cross-outlet-pointer.js');

// the-lion-king-1997 shape: the real Variety row points at a Vulture misfetch.
const files = {
  'vulture--john-simon.json': { outletId: 'vulture', criticName: 'John Simon' },
  'variety--greg-evans-2.json': { outletId: 'variety', criticName: 'Greg Evans' },
};
const read = (f) => files[f] || null;
const variety = { outletId: 'variety', criticName: 'Greg Evans', duplicateTextOf: 'vulture--john-simon.json' };

test('a pointer to another outlet is found and the row is compared, not skipped', () => {
  assert.deepEqual(crossOutletPointer(variety, 'variety--greg-evans.json', read),
    { field: 'duplicateTextOf', target: 'vulture--john-simon.json', targetOutlet: 'vulture' });
  assert.equal(skipAsAlreadyFlagged(variety, 'variety--greg-evans.json', read), false);
});

test('same-outlet and dangling pointers, and syndication flags, stay skipped', () => {
  assert.equal(skipAsAlreadyFlagged({ outletId: 'variety', duplicateOf: 'variety--greg-evans-2.json' }, 'variety--x.json', read), true);
  assert.equal(skipAsAlreadyFlagged({ outletId: 'variety', duplicateTextOf: 'gone.json' }, 'variety--x.json', read), true);
  assert.equal(skipAsAlreadyFlagged({ outletId: 'variety', isSyndicatedDuplicate: true }, 'variety--x.json', read), true);
});

test('an unflagged row is never skipped', () => {
  assert.equal(skipAsAlreadyFlagged({ outletId: 'variety' }, 'variety--x.json', read), false);
  assert.equal(crossOutletPointer({ outletId: 'variety' }, 'variety--x.json', read), null);
});

test('detect-cross-outlet-duplicates: a pointer row never becomes the Layer 1 primary', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../detect-cross-outlet-duplicates.js', import.meta.url), 'utf8');
  // The primary is picked from rows without a cross-outlet pointer.
  assert.match(src, /const plain = group\.filter\(r => !r\.pointerAcross\);\s*const primary = plain\[0\];/);
});
