import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findSlugDerivedDisplayNames } = require('../../scripts/audit-registry-slug-displaynames.js');

test('flags a capitalized-slug compound displayName and proposes the review label', () => {
  const rows = findSlugDerivedDisplayNames(
    { newjerseystage: { displayName: 'Newjerseystage' }, variety: { displayName: 'Variety' }, 'time-out': { displayName: 'Time Out' } },
    { newjerseystage: ['New Jersey Stage'] },
  );
  assert.deepEqual(rows, [{ outletId: 'newjerseystage', current: 'Newjerseystage', proposed: 'New Jersey Stage' }]);
});

test('no review label means proposed:null; displayNameReviewed stamp clears the row', () => {
  const rows = findSlugDerivedDisplayNames(
    { gmanetwork: { displayName: 'Gmanetwork' }, juiceph: { displayName: 'Juiceph', displayNameReviewed: true } }, {},
  );
  assert.deepEqual(rows, [{ outletId: 'gmanetwork', current: 'Gmanetwork', proposed: null }]);
});
