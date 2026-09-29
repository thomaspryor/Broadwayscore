// BRO-4381: TheaterMania Off-Broadway parser, driven by a real API sample
// (scripts/lib/fixtures/theatermania-ob-sample.json, fetched 2026-09-29).
// Requires the real functions (CLAUDE.md §15), including the discovery gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const {
  parseTmDate, mapTmDates, isCurrentTmRow, categoryFromGenres, parseTmOffBroadwayRow,
} = require('./theatermania-ob.js');
const { addShowsFromPlans } = require('./pending-add-shows.js');
const { isUnconfirmedDateSource } = require('./date-source-confidence.js');
const { checkForDuplicate } = require('./deduplication.js');
const { isKnownOffBroadwayVenue } = require('./venue-classification.js');
const { isNonTheaterContent, isOneNightShow } = require('../discover-new-shows.js');

const fixture = JSON.parse(readFileSync(new URL('./fixtures/theatermania-ob-sample.json', import.meta.url), 'utf8'));
const venuesById = new Map(fixture.venues.map(v => [v.id, v]));
const genresById = new Map(fixture.genres.map(g => [g.id, g.name]));
const TODAY = '2026-09-29';
const row = (re) => {
  const r = fixture.rows.find(x => re.test(x.title.rendered));
  assert.ok(r, `fixture row ${re} missing`);
  return r;
};
const parse = (re) => parseTmOffBroadwayRow(row(re), { venuesById, genresById });

test('parseTmDate: YYYYMMDD → ISO; blank, malformed and impossible dates → null', () => {
  assert.equal(parseTmDate('20261107'), '2026-11-07');
  assert.equal(parseTmDate(''), null);
  assert.equal(parseTmDate(null), null);
  assert.equal(parseTmDate('2026-11-07'), null);
  assert.equal(parseTmDate('20260231'), null);
});

test('preview + opening → both dates, opening marked theatermania (unconfirmed)', () => {
  const r = parse(/^Fantasma$/);
  assert.equal(r.candidate.previewsStartDate, '2026-11-07');
  assert.equal(r.candidate.openingDate, '2026-11-22');
  assert.equal(r.candidate.closingDate, '2026-12-20');
  assert.equal(r.candidate.openingDateSource, 'theatermania');
  assert.equal(r.candidate.venue, '59E59 Theaters');
  assert.equal(r.candidate.category, 'off-broadway');
  assert.equal(r.candidate.provisional, undefined, '59E59 is a known OB venue: no Playbill cross-check needed');
  // data/off-broadway-venues.json grows as discovery adds shows (Judson
  // Memorial Church joined it 2026-09-29 22:35 and turned main red), so the
  // fixture's real venue can't be pinned as unknown: check the rule against
  // the live list, and prove the unknown branch with a venue no list holds.
  const judson = parse(/^Queeney Todd/);
  assert.equal(judson.candidate.venue, 'Judson Memorial Church');
  assert.equal(judson.candidate.provisional, isKnownOffBroadwayVenue(judson.candidate.venue) ? undefined : true);
  const qRow = row(/^Queeney Todd/);
  const renamed = new Map(venuesById);
  for (const [id, v] of venuesById) {
    if (v.title?.rendered === 'Judson Memorial Church') renamed.set(id, { ...v, title: { rendered: 'Zzq Nonexistent Playhouse' } });
  }
  const unknownVenue = parseTmOffBroadwayRow(qRow, { venuesById: renamed, genresById });
  assert.equal(unknownVenue.candidate.venue, 'Zzq Nonexistent Playhouse');
  assert.equal(unknownVenue.candidate.provisional, true, 'unknown venue → provisional');
  assert.equal(r.candidate.discoverySource, 'theatermania-ob');
  assert.equal(isUnconfirmedDateSource({ category: 'off-broadway', openingDateSource: 'theatermania' }), true,
    'a TheaterMania press night must stay overwritable by Playbill / review inference');
});

test('opening_date only → treated as first performance, no press night', () => {
  const r = parse(/^Queeney Todd/);
  assert.equal(r.candidate.previewsStartDate, '2026-10-22');
  assert.equal(r.candidate.openingDate, null);
  assert.equal(r.candidate.openingDateSource, null);
});

test('preview after opening (bad data) → row skipped, no guessed date', () => {
  assert.match(parse(/Jolie/).skip, /preview_date is after opening_date/);
  assert.equal(mapTmDates({ preview_date: '20270611', opening_date: '20260627' }).inconsistent, true);
  assert.equal(mapTmDates({ preview_date: '20261107', opening_date: '20261107' }).openingDate, '2026-11-07', 'same-day preview/opening is fine');
});

test('titles are entity-decoded and trimmed', () => {
  const r = parseTmOffBroadwayRow({ ...row(/^Fantasma$/), title: { rendered: '  The King&#8217;s Critique &amp; Co ' } }, { venuesById, genresById });
  assert.equal(r.candidate.title, "The King's Critique & Co");
});

test('HTML entities in titles are decoded', () => {
  const r = parseTmOffBroadwayRow(row(/Bedlam/), { venuesById, genresById });
  // skipped for its city, but the title is decoded in the skip path's input too
  assert.match(r.skip, /Quincy/);
  assert.equal(mapTmDates({ preview_date: '', opening_date: '' }).previewsStartDate, null);
});

test('rows are skipped when the venue is missing or outside NYC', () => {
  assert.match(parse(/^Heartland Marimba/).skip, /placeholder|blank/);
  assert.match(parse(/Bedlam/).skip, /outside NYC/);
});

test('multi-venue rows take the house, not the producing company', () => {
  const r = parse(/^The Heart$/);
  assert.match(r.candidate.venue, /Laura Pels/);
});

test('isCurrentTmRow: closing today+ or recent open-ended start; closed rows out', () => {
  assert.equal(isCurrentTmRow(row(/^Fantasma$/), TODAY), true);
  assert.equal(isCurrentTmRow(row(/Gazillion/), TODAY), true, 'long-runner with a future closing date');
  assert.equal(isCurrentTmRow(row(/Teatro C/), TODAY), false, 'closed row from a stale article-style listing');
  assert.equal(isCurrentTmRow({ acf: { preview_date: '', opening_date: '20070420', closing_date: '' } }, TODAY), false);
  assert.equal(isCurrentTmRow({ acf: { preview_date: '20260801', opening_date: '', closing_date: '' } }, TODAY), true);
});

test('genres → TodayTix-style category the existing gates read', () => {
  assert.equal(categoryFromGenres(['Play']), 'Plays');
  assert.equal(categoryFromGenres(['Drag', 'Musical', 'Opera']), 'Musicals');
  assert.equal(categoryFromGenres(['Concert', 'Music']), 'Concerts');
  assert.equal(categoryFromGenres(['Dance']), null);
  assert.equal(categoryFromGenres([]), null);
});

test('discovery gates: concert-only rows and one-night rows are filtered, plays pass', () => {
  const concert = parseTmOffBroadwayRow(
    { ...row(/^Fantasma$/), genre: fixture.genres.filter(g => /Concert|Music$/.test(g.name)).map(g => g.id) },
    { venuesById, genresById });
  assert.equal(isNonTheaterContent(concert.gateShape), true);

  const oneNight = parse(/^STAGE MAMMA/);
  assert.equal(oneNight.gateShape.startDate, oneNight.gateShape.endDate);
  assert.equal(isOneNightShow(oneNight.gateShape), true);

  const play = parse(/^Fantasma$/);
  assert.equal(isNonTheaterContent(play.gateShape), false);
  assert.equal(isOneNightShow(play.gateShape), false);
});

test('pending-fix add-show plans dedupe TheaterMania candidates (BRO-4377 overlap)', () => {
  const plans = [
    { issueNumber: 'bro-4377', status: 'pending', plan: { actions: [
      { type: 'add-show', show: { id: 'fantasma-off-broadway-2026', title: 'Fantasma', slug: 'fantasma', venue: '59E59 Theaters', category: 'off-broadway', openingDate: '2026-11-22' } },
      { type: 'data-edit', field: 'x' },
    ] } },
    { issueNumber: 'bro-3', status: 'validation-failed', plan: { actions: [
      { type: 'add-show', show: { id: 'y-off-broadway-2026', title: 'Failed Plan Show', venue: 'HERE' } },
    ] } },
    { issueNumber: 'bro-2', status: 'partial', plan: { actions: [
      { type: 'add-show', show: { id: 'x-off-broadway-2026', title: 'Partial Plan Show', venue: 'HERE' } },
    ] } },
    { issueNumber: 'bro-1', status: 'rejected', plan: { actions: [
      { type: 'add-show', show: { id: 'degenerates-off-broadway-2026', title: 'Degenerates', slug: 'degenerates', venue: 'Playwrights Horizons' } },
    ] } },
  ];
  const pending = addShowsFromPlans(plans);
  assert.deepEqual(pending.map(s => s.id), ['fantasma-off-broadway-2026']);
  assert.equal(pending[0]._pendingFix, 'bro-4377');
  assert.equal(pending[0].slug, 'fantasma', 'slug synthesized when a plan omits it');
  assert.equal(checkForDuplicate(parse(/^Fantasma$/).candidate, pending).isDuplicate, true);
  assert.equal(checkForDuplicate(parse(/^Degenerates$/).candidate, pending).isDuplicate, false, 'rejected plans do not count');
});

test('TheaterMania venue/title spellings dedupe against the catalogue spelling', () => {
  const ob = (title, venue, extra = {}) => ({ title, venue, category: 'off-broadway', ...extra });
  const cases = [
    [ob('Arias With a Twist', 'HERE'), ob('Arias with a Twist', 'HERE Arts Center', { id: 'a', slug: 'arias-with-a-twist', openingDate: '2026-09-23' })],
    [ob('The Morbs', 'Gural Theatre at A.R.T/New York'), ob('The Morbs', 'Jeffrey and Paula Gural Theatre at A.R.T./New York Theatres', { id: 'b', slug: 'the-morbs', openingDate: '2026-10-27' })],
    [ob('Going Bacharach: Songs Of An Icon', 'Marjorie S. Deane Little Theater', { previewsStartDate: '2026-09-09' }),
      ob('Going Bacharach: The Songs of an Icon', 'The Marjorie S. Deane Little Theater', { id: 'c', slug: 'going-bacharach-the-songs-of-an-icon', openingDate: '2026-09-16' })],
    [ob("Pretend It's Pretend", 'Claire Tow Theater', { previewsStartDate: '2027-01-28', openingDate: '2027-02-11' }),
      ob("Pretend It's Pretend", 'LCT3 at the Claire Tow Theater', { id: 'd-2026', slug: 'pretend-its-pretend', status: 'announced', unconfirmedStartDate: '2028-01-28' })],
  ];
  // Live 2026-09-29 (second-opinion review): TM drops the catalogue's tagline.
  cases.push(
    [ob('Copperfield!', 'Duke on 42nd Street', { previewsStartDate: '2026-09-29' }),
      ob('Copperfield! The New Musical', 'The Duke on 42nd Street', { id: 'g', slug: 'copperfield-the-new-musical', status: 'upcoming' })],
    [ob('ANON', 'The Robert W. Wilson MCC Theater Space', { previewsStartDate: '2026-09-25' }),
      ob('ANON – a tempest at our kitchen table', 'The Newman Mills Theatre at the Robert W. Wilson MCC Theatre Space', { id: 'h', slug: 'anon-a-tempest-at-our-kitchen-table', status: 'previews' })],
  );
  for (const [cand, existing] of cases) {
    assert.equal(checkForDuplicate(cand, [existing]).isDuplicate, true, `${cand.title} @ ${cand.venue}`);
  }
  // Multi-part shows at one venue still stay apart.
  assert.equal(checkForDuplicate(
    ob('The Coast of Utopia: Shipwreck', 'HERE'),
    [ob('The Coast of Utopia: Voyage', 'HERE Arts Center', { id: 'e', slug: 'the-coast-of-utopia-voyage' })]).isDuplicate, false);
  // A.R.T.'s Mezzanine is a different room from the Gural.
  assert.equal(checkForDuplicate(
    ob('The Morbs', 'Gural Theatre at A.R.T/New York', { previewsStartDate: '2026-10-27' }),
    [ob('The Morbs', 'Mezzanine Theatre – A.R.T./New York Theatres', { id: 'f', slug: 'the-morbs-2019', openingDate: '2019-03-01', status: 'closed' })]).isDuplicate, false);
});

test('curly apostrophes from TheaterMania become straight (catalogue spelling)', () => {
  const r = parseTmOffBroadwayRow(
    { ...row(/^Fantasma$/), title: { rendered: 'Pretend It&#8217;s Pretend' } }, { venuesById, genresById });
  assert.equal(r.candidate.title, "Pretend It's Pretend");
});

test('coverage diff: queued + live matches are covered, a closed-only match is a gap', () => {
  const { findTmCoverageGaps, decideTmCoverageOutcome } = require('./theatermania-ob.js');
  const rows = fixture.rows.filter(r => isCurrentTmRow(r, TODAY));
  const shows = [
    { id: 'degenerates-off-broadway-2026', slug: 'degenerates', title: 'Degenerates', venue: 'Playwrights Horizons', category: 'off-broadway', status: 'open' },
    // Only a decades-old closed run of this title: still a gap.
    { id: 'the-heart-off-broadway-1999', slug: 'the-heart', title: 'The Heart', venue: 'Laura Pels Theatre', category: 'off-broadway', status: 'closed', closingDate: '1999-06-01' },
  ];
  const pendingShows = [{ id: 'fantasma-off-broadway-2026', slug: 'fantasma', title: 'Fantasma', venue: '59E59 Theaters', category: 'off-broadway' }];
  const { gaps } = findTmCoverageGaps({
    rows, venuesById, genresById, shows, pendingShows, gates: { isNonTheaterContent, isOneNightShow },
  });
  const titles = gaps.map(g => g.title);
  assert.ok(!titles.includes('Fantasma'), 'queued by a pending-fix plan');
  assert.ok(!titles.includes('Degenerates'), 'live catalogue row');
  assert.ok(titles.includes('The Heart'), 'closed-only match is a gap');
  assert.ok(!titles.includes('STAGE MAMMA: From Child Star to Leading Lady'), 'one-night rows are gated out');
  assert.ok(!titles.some(t => /Teatro C/.test(t)), 'closed TheaterMania rows are not current');

  assert.equal(decideTmCoverageOutcome({ rawCount: 0, currentCount: 0 }).blind, true);
  assert.equal(decideTmCoverageOutcome({ rawCount: 300, currentCount: 0 }).blind, true);
  assert.equal(decideTmCoverageOutcome({ rawCount: 300, currentCount: 91 }).blind, false);
});

test('TheaterMania same-title fallback catches coarse venue names, not old revivals', () => {
  const { findTmSameTitleShow } = require('./theatermania-ob.js');
  const shows = [
    { id: 'night-of-january-16th-off-broadway-2026', title: 'Night of January 16th', venue: 'Theatre Row, Theatre 5', category: 'off-broadway', status: 'upcoming' },
    { id: 'hamlet-off-broadway-1999', title: 'Hamlet', venue: 'Theatre Row', category: 'off-broadway', status: 'closed', openingDate: '1999-03-01' },
    { id: 'truly-howard-hughes-off-broadway-2026', title: 'Truly, Howard Hughes', venue: 'Theater at St. Jean', category: 'off-broadway', status: 'closed', openingDate: '2026-09-17', closingDate: '2026-09-20' },
    { id: 'london-x', title: 'Drunk Dracula', venue: 'Soho', category: 'west-end', status: 'open' },
  ];
  const c = (title, openingDate) => ({ title, venue: 'Theatre Row', category: 'off-broadway', openingDate });
  assert.equal(findTmSameTitleShow(c('Night of January 16th', '2026-10-11'), shows)?.id, 'night-of-january-16th-off-broadway-2026');
  assert.equal(findTmSameTitleShow(c('Truly Howard Hughes', '2026-09-17'), shows)?.id, 'truly-howard-hughes-off-broadway-2026', 'punctuation-insensitive, closed but same dates');
  assert.equal(findTmSameTitleShow(c('Hamlet', '2026-11-01'), shows), null, 'a 1999 closed run is a different production');
  assert.equal(findTmSameTitleShow(c('Drunk Dracula', '2026-10-01'), shows), null, 'London rows never match');
});

test('HERE alias keeps a room qualifier', () => {
  const r = checkForDuplicate({ title: 'Arias With a Twist', venue: 'HERE', category: 'off-broadway' },
    [{ id: 'a', slug: 'arias-with-a-twist', title: 'Arias with a Twist', venue: 'HERE Arts Center (Mainstage)', category: 'off-broadway', openingDate: '2026-09-23' }]);
  assert.equal(r.isDuplicate, true);
});
