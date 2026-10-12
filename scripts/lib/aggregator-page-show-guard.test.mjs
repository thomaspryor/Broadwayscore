import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { roundupExcerptsAboutShow, headlineNamesShow } = require('./aggregator-page-show-guard.js');

const TOTORO = { id: 'my-neighbour-totoro-west-end-2025', title: 'My Neighbour Totoro' };
const filler = 'The staging is inventive and the cast carries the evening with real warmth and wit throughout. ';

test('BRO-3564: a Peter Pan round-up filed under Totoro is rejected', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    excerpt: `Wendy and Peter Pan flies at the Barbican. ${filler}Row ${i}.`,
  }));
  const r = roundupExcerptsAboutShow(rows, TOTORO);
  assert.equal(r.judged, true);
  assert.equal(r.ok, false);
});

test('a round-up whose excerpts name the show passes', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    excerpt: i === 0 ? `My Neighbour Totoro returns. ${filler}` : `${filler}Row ${i}.`,
  }));
  const r = roundupExcerptsAboutShow(rows, TOTORO);
  assert.equal(r.ok, true);
  assert.equal(r.judged, true);
});

test('headline-only pages (too little text) are not judged', () => {
  const rows = [{ excerpt: 'Charming.' }, { excerpt: 'A delight.' }, { excerpt: 'Magical.' }];
  const r = roundupExcerptsAboutShow(rows, TOTORO);
  assert.equal(r.ok, true);
  assert.equal(r.judged, false);
});

test('the real archived Totoro page (if present and still the bad one) is rejected', () => {
  const fs = require('fs');
  const path = require('path');
  const f = [['data', 'aggregator-archive'], ['data', 'review-texts', 'aggregator-archive']]
    .map(p => path.join(process.cwd(), ...p, 'westendtheatre', 'my-neighbour-totoro-west-end-2025.json'))
    .find(p => fs.existsSync(p));
  if (!f) return; // private archive not attached (CI)
  const a = JSON.parse(fs.readFileSync(f, 'utf8'));
  const rows = a.reviews || a.ratings || [];
  // Only meaningful while the bad archive is still on disk.
  const r = roundupExcerptsAboutShow(rows, TOTORO);
  if (rows.some(x => /peter pan/i.test(x.excerpt || ''))) assert.equal(r.ok, false);
});

test('a headline naming the show accepts a page whose excerpts skip the title', () => {
  // Back to the Future (Adelphi): six excerpts, none says the title.
  const show = { id: 'back-to-the-future-west-end-2021', title: 'Back to the Future' };
  const rows = Array.from({ length: 6 }, (_, i) => ({ excerpt: `${filler}${filler}Row ${i}.` }));
  assert.equal(roundupExcerptsAboutShow(rows, show).ok, false);
  const r = roundupExcerptsAboutShow(rows, show, { pageTitle: 'Back To The Future Reviews Round-up at the Adelphi Theatre' });
  assert.equal(r.ok, true);
  assert.equal(r.judged, true);
});

test('a headline naming another show does not rescue the page', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ excerpt: `${filler}${filler}Row ${i}.` }));
  const r = roundupExcerptsAboutShow(rows, TOTORO, { pageTitle: 'Wendy & Peter Pan reviews at the Barbican' });
  assert.equal(r.ok, false);
});

test('short titles must lead the headline', () => {
  assert.equal(headlineNamesShow("Red reviews starring Alfred Molina – Wyndham's Theatre", 'Red'), true);
  assert.equal(headlineNamesShow('The Red Shoes reviews', 'Red'), false);
  assert.equal(headlineNamesShow('Redemption reviews', 'Red'), false);
  assert.equal(headlineNamesShow('', 'Red'), false);
  assert.equal(headlineNamesShow(undefined, 'Red'), false);
});
