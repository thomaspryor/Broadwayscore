// BRO-6872: the lane held no multi-show critic column back. The 10-22 Washington Post column covered three shows and the
// lane scored the whole page as The Imaginary Invalid (74). A column on a column host that names two or more other New
// York shows opening the same weeks is now held unscored for the regular pipeline (its verifier and BRO-6880 isolation).
// Synthetic text only: no review text in this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const g = require('../../scripts/lib/opening-night-lane/lane-guards.js');
const inl = require('../../scripts/lib/opening-night-lane/inline-score.js');

const II = { id: 'the-imaginary-invalid-2026', title: 'The Imaginary Invalid', category: 'broadway', openingDate: '2026-10-22' };
const SHOWS = [
  II,
  { id: 'other-desert-cities-2026', title: 'Other Desert Cities', category: 'broadway', openingDate: '2026-10-18' },
  { id: 'benjamin-button-ob-2026', title: 'The Curious Case of Benjamin Button', category: 'off-broadway', openingDate: '2026-10-21' },
  { id: 'company-2026', title: 'Company', category: 'broadway', openingDate: '2026-10-20' }, // one word: everyday prose
  { id: 'the-heart-2026', title: 'The Heart', category: 'off-broadway', openingDate: '2026-10-19' }, // one word after the article
  { id: 'the-ask-2026', title: 'The Ask', category: 'off-broadway', openingDate: '2026-10-24' },
  { id: 'two-strangers-2026', title: 'Two Strangers (Carry a Cake Across New York)', category: 'broadway', openingDate: '2026-10-26' },
  { id: 'old-show-2011', title: 'Long Ago Musical', category: 'broadway', openingDate: '2011-03-01' }, // other season
  { id: 'london-2026', title: 'London Only Play', category: 'west-end', openingDate: '2026-10-21' }, // other market
  { id: 'the-imaginary-invalid-west-end', title: 'The Imaginary Invalid', category: 'west-end', openingDate: '2026-10-25' },
];
const WAPO = 'https://www.washingtonpost.com/entertainment/theater/2026/10/23/three-new-shows/';
const filler = 'The cast is strong and the staging is brisk. '.repeat(40);
const column = `${filler} Other Desert Cities returns. ${filler} The Curious Case of Benjamin Button sails. ${filler} The Imaginary Invalid. ${filler}`;
const single = `${filler} The Imaginary Invalid recalls Other Desert Cities in its family fights. ${filler}`;

test('nearby titles: same weeks, New York, two words or more, never the show itself', () => {
  const t = g.nearbyShowTitles(II, SHOWS).sort();
  assert.deepEqual(t, ['Curious Case of Benjamin Button', 'Other Desert Cities', 'Two Strangers']);
  assert.deepEqual(g.nearbyShowTitles({ ...II, openingDate: undefined }, SHOWS), []);
  assert.deepEqual(g.nearbyShowTitles(II, undefined), []);
});

test('a column-host page naming two other same-weeks shows is a multi-show column; one comparison is not', () => {
  const titles = g.nearbyShowTitles(II, SHOWS);
  assert.match(g.multiShowColumnReason({ url: WAPO, fullText: column }, titles) || '', /multi-show column .*Other Desert Cities.*Benjamin Button/);
  // Ordinary prose that happens to spell two-word titles in lower case is one review, not a column.
  const prose = `${filler} At the heart of the play is the conversation. The ask is simple: other desert cities, two strangers. ${filler}`;
  assert.equal(g.multiShowColumnReason({ url: WAPO, fullText: prose }, titles), null, 'lower-case prose is not a title');
  // A parenthetical subtitle is matched by its short name, as critics write it.
  assert.match(g.multiShowColumnReason({ url: WAPO, fullText: `${single} Two Strangers charms.` }, titles) || '', /Other Desert Cities, Two Strangers/);
  assert.equal(g.multiShowColumnReason({ url: WAPO, fullText: single }, titles), null, 'a review comparing one other show stays scorable');
  assert.equal(g.multiShowColumnReason({ url: 'https://www.theguardian.com/stage/2026/oct/23/x', fullText: column }, titles), null, 'only column hosts');
  assert.equal(g.multiShowColumnReason({ url: WAPO, fullText: '' }, titles), null);
  assert.equal(g.multiShowColumnReason({ url: WAPO, fullText: column }, []), null);
});

test('scoreReview holds the column for good and pays no model; a single review still scores', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6872-column-'));
  try {
    let calls = 0;
    const scoring = inl.createInlineScoring({
      show: II, night: '2026-10-22', ledgerDir: path.join(dir, 'ledger'), now: () => Date.parse('2026-10-23T03:00:00Z'),
      fetchPage: async () => { throw new Error('unused'); }, extractArticle: () => null, extractMeta: () => ({}), aggregatorFor: () => ({}),
      scoreText: async () => { calls++; return { score: 74 }; }, allShows: SHOWS,
    });
    const row = { showId: II.id, url: WAPO, outletId: 'washpost', criticName: 'Thomas Floyd', fullText: column };
    await assert.rejects(scoring.scoreReview(row, {}), (e) => e instanceof inl.LanePermanentError && /multi-show column/.test(e.message));
    await assert.rejects(scoring.scoreReview(row, {}), inl.LanePermanentError, 'a later pass does not retry it');
    assert.equal(calls, 0);
    const one = await scoring.scoreReview({ ...row, url: `${WAPO}single/`, fullText: single }, {});
    assert.ok(one, 'single-show review scored');
    assert.equal(calls, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the copied column hosts match the collector (column-section-extract.js)', () => {
  const { COLUMN_POST_HOSTS } = require('../../scripts/lib/column-section-extract.js');
  assert.deepEqual(g.COLUMN_POST_HOSTS.map(String), COLUMN_POST_HOSTS.map(String));
});

test('the lane never requires the collector column module (it would join the lane code hash)', () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../../scripts/lib/opening-night-lane/lane-guards.js'), 'utf8');
  assert.doesNotMatch(src, /require\([^)]*column-section-extract/);
});
