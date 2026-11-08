import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../../scripts/lib/outlet-listing-census.js');

const mk = (id, market, opening, closing) => ({ id, title: 'An Enemy of the People', market, status: 'closed', openingDate: opening, closingDate: closing });
const bway = mk('enemy-bway', 'broadway', '2024-03-18', '2024-06-09');
const we = mk('enemy-we', 'west-end', '2024-03-14', '2024-05-04');
const solo = { id: 'solo', title: 'Million Dollar Quartet', market: 'west-end', status: 'open', openingDate: '2024-01-10' };
const pool = [bway, we, solo];
const item = (url, date) => ({ url, headline: 'An Enemy of the People review', publishDate: date });

test('F12: shared title with two sibling productions in window is refused as title-only proof', () => {
  const it = item('https://x.com/review-an-enemy-of-the-people', '2024-03-20');
  assert.equal(C.censusTitleOnly(it, bway, pool), false);
  assert.equal(C.censusTitleOnly(it, we, pool), false);
});

test('F12: sibling out of its run window leaves the in-window show eligible', () => {
  const it = item('https://x.com/review-an-enemy-of-the-people', '2024-03-05');
  assert.equal(C.censusTitleOnly(it, we, pool), true);
});

test('F12: unique title still passes', () => {
  assert.equal(C.censusTitleOnly({ url: 'https://x.com/review-million-dollar-quartet', headline: 'Million Dollar Quartet review', publishDate: '2024-02-01' }, solo, pool), true);
});
