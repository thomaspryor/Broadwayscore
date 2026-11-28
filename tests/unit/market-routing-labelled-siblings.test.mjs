// BRO-6924: "Tosca - English National Opera" (London Coliseum, opened 2026-10-30)
// and the Met's "Tosca" (opened 2026-11-01) were never siblings: buildSiblingIndex
// grouped by exact title. London reviews naming the Coliseum stayed under the Met.
// Head-keyed siblings are read by the venue-in-URL rule only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildSiblingIndex, classifyMarketRouting, siblingVenueDecision, splitLabelledTitle, labelInitials,
} = require('../../scripts/lib/market-routing.js');

const eno = {
  id: 'tosca-english-national-opera-west-end-2026', title: 'Tosca - English National Opera',
  category: 'west-end', venue: 'London Coliseum', openingDate: '2026-10-30', closingDate: '2026-12-11',
};
const met = {
  id: 'tosca-off-broadway-2026', title: 'Tosca', category: 'off-broadway',
  venue: 'Metropolitan Opera House', openingDate: '2026-11-01', closingDate: '2027-05-27',
};
const index = buildSiblingIndex([eno, met]);
const route = (showId, url, publishDate, category) =>
  classifyMarketRouting({ showId, url, publishDate, category, siblingIndex: index });

test('splitLabelledTitle splits on a spaced dash only', () => {
  assert.deepEqual(splitLabelledTitle('Tosca - English National Opera'), { head: 'Tosca', label: 'English National Opera' });
  assert.deepEqual(splitLabelledTitle('STORIES – The Tap Dance Sensation'), { head: 'STORIES', label: 'The Tap Dance Sensation' });
  assert.equal(splitLabelledTitle('Spider-Man: Turn Off the Dark'), null);
  assert.equal(splitLabelledTitle('Tosca'), null);
});

test('labelInitials needs a 3+ word label', () => {
  assert.equal(labelInitials('English National Opera'), 'eno');
  assert.equal(labelInitials('Bridge Theatre'), null);
  assert.equal(labelInitials('Globe'), null);
});

test('the labelled show and its bare head are head-keyed siblings, not exact-title siblings', () => {
  const m = index.get(met.id);
  assert.deepEqual(m.siblings, []);
  assert.deepEqual(m.labelledSiblings.map(s => [s.id, s.labelPhrases]), [[eno.id, ['eno']]]);
  const e = index.get(eno.id);
  assert.deepEqual(e.labelledSiblings.map(s => s.id), [met.id]);
});

test('a London Coliseum URL filed under the Met moves to the ENO show (days apart, cross-market)', () => {
  // Nov 2 is nearer the Met's Nov 1 opening than the ENO's Oct 30: the old
  // nearest-opening check kept it with the Met.
  const r = route(met.id, 'https://thestage.co.uk/reviews/tosca-review-london-coliseum-puccini-annilese-miskimmon', '2026-11-02', 'off-broadway');
  assert.equal(r.action, 'reroute');
  assert.equal(r.targetShowId, eno.id);
  assert.match(r.reason, /london-coliseum/);
});

test('the label initials name the labelled sibling ("tosca-eno-review" under /opera/)', () => {
  const r = route(met.id, 'https://www.telegraph.co.uk/opera/what-to-see/tosca-eno-review/', '2026-10-31', 'off-broadway');
  assert.equal(r.action, 'reroute');
  assert.equal(r.targetShowId, eno.id);
});

test('a URL with no venue stays where it is', () => {
  const r = route(met.id, 'https://www.theguardian.com/music/2026/nov/01/tosca-review-axelle-fanyo-christopher-purves', '2026-11-01', 'off-broadway');
  assert.equal(r.action, 'accept');
});

test('a Met URL filed under the ENO show moves to the Met', () => {
  const r = route(eno.id, 'https://example.com/tosca-review-metropolitan-opera-house', '2026-11-02', 'west-end');
  assert.equal(r.action, 'reroute');
  assert.equal(r.targetShowId, met.id);
});

test('a common one-word head is never moved on dates alone (Guard A ignores head-keyed siblings)', () => {
  const stories2018 = { id: 'stories-west-end-2018', title: 'Stories', category: 'west-end', venue: 'Dorfman Theatre', openingDate: '2018-10-17', closingDate: '2019-01-10' };
  const tap = { id: 'stories-the-tap-dance-sensation-west-end-2026', title: 'STORIES – The Tap Dance Sensation', category: 'west-end', venue: 'Peacock Theatre', openingDate: '2026-07-01' };
  const idx = buildSiblingIndex([stories2018, tap]);
  // A 2026 review filed under the 2018 show, no venue in the URL: dates alone point
  // at the tap show, but the head-keyed pair must not move it.
  const r = classifyMarketRouting({ showId: stories2018.id, url: 'https://example.com/stories-review', publishDate: '2026-07-03', category: 'west-end', siblingIndex: idx });
  assert.equal(r.action, 'accept');
});

test('a transfer origin months earlier is not rescued by the cross-market relaxation', () => {
  const london = { id: 'x-west-end-2026', title: 'X', category: 'west-end', venue: 'Harold Pinter Theatre', openingDate: '2026-01-10', closingDate: '2026-12-31' };
  const bway = { id: 'x-2026', title: 'X', category: 'broadway', venue: 'Booth Theatre', openingDate: '2026-10-01' };
  const idx = buildSiblingIndex([london, bway]);
  // A Broadway review that mentions where the show came from stays on Broadway.
  const d = siblingVenueDecision(idx.get(bway.id), {
    url: 'https://example.com/x-review-transfer-from-harold-pinter', publishDate: '2026-10-02', visitedSet: new Set([bway.id]),
  });
  assert.equal(d, null);
});

test('DISABLE_LABELLED_SIBLINGS turns off the pairing only', () => {
  process.env.DISABLE_LABELLED_SIBLINGS = 'true';
  try {
    const idx = buildSiblingIndex([eno, met]);
    assert.deepEqual(idx.get(met.id)?.labelledSiblings || [], []);
  } finally { delete process.env.DISABLE_LABELLED_SIBLINGS; }
});

test('the cross-market relaxation is for head-keyed pairs only: an exact-title transfer keeps the nearest-opening rule', () => {
  const london = { id: 'y-west-end-2026', title: 'Y', category: 'west-end', venue: 'Harold Pinter Theatre', openingDate: '2026-10-01', closingDate: '2027-03-31' };
  const bway = { id: 'y-2026', title: 'Y', category: 'broadway', venue: 'Booth Theatre', openingDate: '2026-10-20' };
  const idx = buildSiblingIndex([london, bway]);
  // Oct 19 sits nearer Broadway's opening; a URL naming the London house in passing stays.
  const d = siblingVenueDecision(idx.get(bway.id), {
    url: 'https://example.com/y-review-harold-pinter-transfer', publishDate: '2026-10-19', visitedSet: new Set([bway.id]),
  });
  assert.equal(d, null);
});
