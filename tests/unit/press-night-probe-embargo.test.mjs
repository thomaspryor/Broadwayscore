// BRO-6657: shows with openingDate but no reviewEmbargoAt must get an inferred market embargo
// (West End market default 21:00 UK) and a probe target, never be skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { probeDue } = require('../../scripts/lib/press-night-record.js');

const lives = {
  id: 'the-lives-of-others-west-end-2026',
  category: 'west-end',
  status: 'previews',
  openingDate: '2026-10-29',
  previewsStartDate: '2026-10-14',
  openingDateSource: 'theatremonkey',
};

test('no reviewEmbargoAt: probeDue infers the West End market-default embargo (21:00 UK, GMT)', () => {
  assert.equal(lives.reviewEmbargoAt, undefined);
  const due = probeDue(lives, Date.parse('2026-10-29T22:37:53Z'));
  assert.equal(due.embargoAt, '2026-10-29T21:00:00.000Z');
  assert.equal(due.night, '2026-10-29');
});

test('no reviewEmbargoAt: BST night shifts the inferred embargo to 20:00Z', () => {
  const s = { ...lives, id: 'x-west-end-2026', openingDate: '2026-10-20' };
  assert.equal(probeDue(s, Date.parse('2026-10-20T19:00:00Z')).embargoAt, '2026-10-20T20:00:00.000Z');
});

test('Lives of Others has a probe record for 2026-10-29 with the inferred embargo (digest no longer reads "overnight check did not run")', () => {
  const f = new URL('../../data/audit/press-night/the-lives-of-others-west-end-2026-2026-10-29.json', import.meta.url);
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(rec.showId, lives.id);
  assert.equal(rec.night, '2026-10-29');
  assert.equal(rec.embargoAt, '2026-10-29T21:00:00.000Z');
});
