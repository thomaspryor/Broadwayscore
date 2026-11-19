import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { staleFileShowId } = require('./showid-dir-mismatch.js');

// Shapes of the two real runs behind the BRO-7579 flap (fixture ids).
const RUN_2025 = { id: 'fixture-farce-west-end-2025', title: 'The Fixture Farce', previewsStartDate: '2025-04-14', openingDate: '2025-05-06', closingDate: '2025-09-05' };
const RUN_2026 = { id: 'fixture-farce-west-end-2026', title: 'The Fixture Farce', previewsStartDate: '2026-08-01', openingDate: '2026-08-06', closingDate: '2026-09-26' };

test('a 2025 review in the 2025 folder carrying the 2026 id is a stale field', () => {
  assert.equal(staleFileShowId({ data: { publishDate: 'May 14th, 2025' }, dirShow: RUN_2025, fileShow: RUN_2026 }), true);
});

test('a 2026 review placed in the 2025 folder is a misplaced file, not a stale field', () => {
  assert.equal(staleFileShowId({ data: { publishDate: '2026-08-07' }, dirShow: RUN_2025, fileShow: RUN_2026 }), false);
});

test('no usable publishDate never counts as stale (keeps the flag)', () => {
  for (const publishDate of [null, undefined, 'garbage']) {
    assert.equal(staleFileShowId({ data: { publishDate }, dirShow: RUN_2025, fileShow: RUN_2026 }), false);
  }
});

test('a different title is never treated as a stale field', () => {
  const other = { ...RUN_2026, title: 'Another Show' };
  assert.equal(staleFileShowId({ data: { publishDate: '2025-05-14' }, dirShow: RUN_2025, fileShow: other }), false);
});

test('a file id with no shows.json entry keeps the flag', () => {
  assert.equal(staleFileShowId({ data: { publishDate: '2025-05-14' }, dirShow: RUN_2025, fileShow: undefined }), false);
});

test('a date inside both windows (overlapping runs) is ambiguous and keeps the flag', () => {
  const open = { ...RUN_2026, previewsStartDate: '2025-04-01', openingDate: '2025-04-10', closingDate: null };
  assert.equal(staleFileShowId({ data: { publishDate: '2025-05-14' }, dirShow: RUN_2025, fileShow: open }), false);
});
