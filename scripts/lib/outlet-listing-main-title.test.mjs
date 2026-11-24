// BRO-8190: TheaterMania headlined Blue Man Group “A New Holiday Surprise” as "Review: Blue Man Group's Broadway
// Christmas Show Is a Lump of Coal". The poller's title forms had no main-title form, so neither the feed match nor
// the page-confirm path saw it and the 2026-11-17 review reached us only through a later sweep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Fixture registry (not live data/shows.json): the main-title uniqueness check reads every show title.
const BMG_FIXTURE = { id: 'blue-man-group-a-new-holiday-surprise-2026', title: 'Blue Man Group “A New Holiday Surprise”', status: 'open' };
process.on('exit', require('./shows-json-fixture.js').useShowsFixture([BMG_FIXTURE]));
require('./show-names').setPressNameShows([BMG_FIXTURE]); // show-names reads data/shows.json itself; hand it the fixture
const { titleForms, findPageConfirmCandidates } = require('./outlet-listing-helpers');

const BMG = {
  id: 'blue-man-group-a-new-holiday-surprise-2026',
  title: 'Blue Man Group “A New Holiday Surprise”',
  status: 'open', openingDate: '2026-11-17', previewsStartDate: '2026-11-12',
};
const HEADLINE = 'Review: Blue Man Group’s Broadway Christmas Show Is a Lump of Coal';
const URL_ = 'https://www.theatermania.com/news/review-blue-man-groups-broadway-christmas-show-is-a-lump-of-coal_1860029/';

test('quoted-subtitle show: main title and its possessive fold are title forms', () => {
  const forms = titleForms(BMG);
  assert.ok(forms.includes('blue man group'), forms.join('|'));
  assert.ok(forms.includes('blue man groups'), forms.join('|'));
});

test('BMG headline becomes a page-confirm candidate on a review-only feed (TheaterMania)', () => {
  const c = findPageConfirmCandidates({ url: URL_, headline: HEADLINE, publishDate: '2026-11-17', description: '' }, [BMG],
    { alreadyMatched: [], reviewOnlyFeed: true, nowMs: Date.parse('2026-11-17') });
  assert.deepEqual(c.map((x) => x.show.id), [BMG.id]);
});

test('a main title another registry show shares gets no main-title form', () => {
  // BMG is in the registry, so a second "Blue Man Group “...”" show would make "blue man group" ambiguous.
  const sibling = { id: 'blue-man-group-other-2026', title: 'Blue Man Group “Another Show”', status: 'open' };
  const forms = titleForms(sibling);
  assert.ok(!forms.includes('blue man group'), forms.join('|'));
});

test('colon-subtitle shows get no possessive fold (census title-only guard stays tight)', () => {
  const forms = titleForms({ id: 'derren-brown-only-human-off-west-end-2026', title: 'Derren Brown: Only Human', status: 'open' });
  assert.ok(!forms.some((f) => /browns$/.test(f)), forms.join('|'));
});
