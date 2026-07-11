// Regional→Broadway transfer auto-detection (2026-07-11). Tests the REAL
// exported function per CLAUDE.md §15.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectTransferPairs } = require('../../scripts/lib/transfer-detection.js');

const REGIONAL = { id: 'fakeshow-regional-2024', title: 'Fakeshow', category: 'regional', openingDate: '2024-06-01' };

test('exact-title Broadway show opening after the tryout is paired', () => {
  const pairs = detectTransferPairs([
    REGIONAL,
    { id: 'fakeshow-2025', title: 'Fakeshow', category: 'broadway', openingDate: '2025-10-01' },
  ]);
  assert.deepEqual(pairs.map(p => [p.regionalId, p.broadwayId]), [['fakeshow-regional-2024', 'fakeshow-2025']]);
});

test('default-category (undefined) counts as Broadway', () => {
  const pairs = detectTransferPairs([
    REGIONAL,
    { id: 'fakeshow-2025', title: 'Fakeshow', openingDate: '2025-10-01' },
  ]);
  assert.equal(pairs[0]?.broadwayId, 'fakeshow-2025');
});

test('date direction: a regional revival of an OLD Broadway title is never linked backwards', () => {
  const pairs = detectTransferPairs([
    { id: 'rent-regional-2026', title: 'Rent', category: 'regional', openingDate: '2026-05-01' },
    { id: 'rent-1996', title: 'Rent', category: 'broadway', openingDate: '1996-04-29' },
  ]);
  assert.equal(pairs.length, 0, 'Broadway opening predates the regional run — not a transfer');
});

test('title variants pair via jaccard ("Fakeshow: The Musical")', () => {
  const pairs = detectTransferPairs([
    { ...REGIONAL, title: 'Fakeshow: The Musical' },
    { id: 'fakeshow-2025', title: 'Fakeshow The Musical', category: 'broadway', openingDate: '2025-10-01' },
  ]);
  assert.equal(pairs[0]?.broadwayId, 'fakeshow-2025');
});

test('ambiguity (two post-dating Broadway matches) is reported, not applied', () => {
  const pairs = detectTransferPairs([
    REGIONAL,
    { id: 'fakeshow-2025', title: 'Fakeshow', category: 'broadway', openingDate: '2025-10-01' },
    { id: 'fakeshow-2026', title: 'Fakeshow', category: 'broadway', openingDate: '2026-03-01' },
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].broadwayId, null);
  assert.match(pairs[0].reason, /ambiguous/);
});

test('already-linked shows are skipped on both sides', () => {
  const linked = detectTransferPairs([
    { ...REGIONAL, transferredTo: 'fakeshow-2025' },
    { id: 'fakeshow-2025', title: 'Fakeshow', category: 'broadway', openingDate: '2025-10-01', transferOf: 'fakeshow-regional-2024' },
  ]);
  assert.equal(linked.length, 0);
});

test('previews-only Broadway show (no openingDate yet) still pairs via previewsStartDate', () => {
  const pairs = detectTransferPairs([
    REGIONAL,
    { id: 'fakeshow-2025', title: 'Fakeshow', category: 'broadway', openingDate: null, previewsStartDate: '2025-09-15' },
  ]);
  assert.equal(pairs[0]?.broadwayId, 'fakeshow-2025');
});

test('non-Broadway categories (west-end, off-broadway) never pair', () => {
  const pairs = detectTransferPairs([
    REGIONAL,
    { id: 'fakeshow-we-2025', title: 'Fakeshow', category: 'west-end', openingDate: '2025-10-01' },
    { id: 'fakeshow-ob-2025', title: 'Fakeshow', category: 'off-broadway', openingDate: '2025-10-01' },
  ]);
  assert.equal(pairs.length, 0);
});

test('regional show without any date anchor is skipped (direction check impossible)', () => {
  const pairs = detectTransferPairs([
    { id: 'x-regional-2024', title: 'Fakeshow', category: 'regional', openingDate: null, previewsStartDate: null },
    { id: 'fakeshow-2025', title: 'Fakeshow', category: 'broadway', openingDate: '2025-10-01' },
  ]);
  assert.equal(pairs.length, 0);
});

test('real-world regression: the LBRR pair would have been auto-detected', () => {
  const pairs = detectTransferPairs([
    { id: 'little-bear-ridge-road-regional-2024', title: 'Little Bear Ridge Road', category: 'regional', openingDate: '2024-06-24' },
    { id: 'little-bear-ridge-road-2025', title: 'Little Bear Ridge Road', category: 'broadway', openingDate: '2025-10-30' },
  ]);
  assert.equal(pairs[0]?.broadwayId, 'little-bear-ridge-road-2025');
});
