// BRO-7436 class guard: the rolling LSA /news/ index only holds the last ~2 days,
// so discovery must also read the CURRENT month's archive or reviews posted 3+
// days after press night are missed by the first pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { discoverLightingSoundAmerica } = require('./lighting-sound-america-discovery');

const now = new Date();
const ym = now.toISOString().slice(0, 7);
const [y, m] = ym.split('-').map(Number);
const day = d => `${ym}-${String(d).padStart(2, '0')}`;
const us = d => `${m}/${d}/${y}`;
const card = (id, title, d) => `<table><tr><td><p><a href="story.asp?ID=${id}"><b>Theatre in Review: <i>${title}</i> (Some Theatre)</b></a></p> (${us(d)})</td></tr></table>`;
const page = body => `<html><body>${body}<a href="story.asp?ID=ZZZ">x</a></body></html>`;

// Rolling index: only recent news. Month archive: the full month, including the review.
const ROLLING = page(card('NEWS01', 'Other Show', 2));
const ARCHIVE = page(card('NEWS01', 'Other Show', 2) + card('REV001', 'Tristan & Yseult', 1));

test('review dropped off the rolling index is found via the current-month archive', async () => {
  const show = { previewsStartDate: day(1), openingDate: day(1), category: 'off-broadway' };
  const fetched = [];
  const found = await discoverLightingSoundAmerica('Tristan and Yseult', show, async url => {
    fetched.push(url);
    return url.includes('archive.asp') ? ARCHIVE : ROLLING;
  });
  assert.ok(fetched.some(u => u.includes(`archive.asp?m=${m}&y=${y}`)), `current-month archive not fetched: ${fetched}`);
  assert.deepEqual(found.map(r => r.url.split('ID=')[1]), ['REV001']);
});

test('future-month archives are never fetched', async () => {
  const nextOpening = new Date(Date.UTC(y, m + 1, 5)).toISOString().slice(0, 10);
  const fetched = [];
  await discoverLightingSoundAmerica('X', { previewsStartDate: nextOpening, openingDate: nextOpening }, async url => { fetched.push(url); return ROLLING; });
  assert.ok(!fetched.some(u => u.includes(`m=${m + 2}`)), String(fetched));
});
