// BRO-7291 class 1: stale closing dates after extensions. Replays the six BRO-7256 hand fixes from the values
// the records had before the fix (data/pending-fixes/bro-7256.json oldValue) and the run-date sentences in the
// stored reviews / the theatreinla listing, and checks the pipeline now reaches the hand-fixed date by itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { laterAnnouncedRunEnd, runEndCandidates } = require('./run-end-from-text.js');
const { applyRunEnd, inScope } = require('../harvest-hub-run-dates.js');

const T = (host, text, articleDate = null) => ({ url: `https://${host}/review`, text, articleDate });

// Real cases: { opening, closing before the hand fix, evidence, hand-fixed date (null = no change was right) }.
const CASES = {
  'a-case-for-the-existence-of-god-regional-2026': {
    opening: '2026-09-10', before: '2026-10-11', fixed: '2026-11-21',
    texts: [
      T('artsbeatla.com', 'presented by and at Rogue Machine Theatre through October 11, 2026 . Tickets are available'),
      T('broadwayworld.com', 'A CASE FOR THE EXISTENCE OF GOD continues through November 1 at 7657 Melrose Ave'),
      T('larchmontbuzz.com', 'A Case for the Existence of God runs through October 11 at the Matrix Theatre'),
      T('stageraw.com', 'Rogue Machine Through Nov. 21 RECOMMENDED. Fri. and Mon., 8 pm, Sat.-Sun., 5 pm; thru Nov. 21.'),
      T('stagescenela.com', '7657 Melrose Avenue, Los Angeles. Through November 21. Mondays and Fridays'),
    ],
  },
  'saint-megan-regional-2026': {
    opening: '2026-10-14', before: '2026-11-15', fixed: '2026-11-22',
    texts: [
      T('artsbeatla.com', 'by Rogue Machine at The Matrix Theatre through November 22, 2026 . Tickets are available'),
      T('discoverhollywood.com', 'The show opened on October 10 and continues through November 22. Performances are'),
      T('splashmags.com', 'SAINT MEGAN runs through November 22, 2026, with performances'),
      T('stageraw.com', 'at the Matrix Theatre Through November 15 RECOMMENDED. Mon., 8 pm; thru Nov. 15.'),
      T('stagescenela.com', '7657 Melrose Avenue, Los Angeles. Through November 15. Mondays, Fridays'),
    ],
  },
  // Every stored review quotes the original run; only the listing page carries the extension.
  'the-arsonists-regional-2026': {
    opening: '2026-09-05', before: '2026-09-20', fixed: '2026-09-27',
    texts: [
      T('larchmontbuzz.com', 'The Arsonists runs through September 20 at the Skylight Theatre'),
      T('stageraw.com', 'The Skylight Theatre Through Sept. 20 RECOMMENDED. Sun., 2 pm; thru Sept. 20.'),
    ],
    listing: { date: '2026-09-27', url: 'https://www.theatreinla.com/the-arsonists/11376/' },
  },
  'frankenstein-resurrection-regional-2026': {
    opening: '2026-09-25', before: '2026-09-30', fixed: '2026-11-01',
    texts: [
      T('broadwayworld.com', '324 N. Orange Street, in Glendale, through November 1. Tickets are available'),
      T('halloweenscenelosangeles.com', 'Glendale, CA Now thru November 1, 2026 Tickets: $27.50-$73'),
    ],
  },
  // Control: nothing later was announced, so nothing may move.
  'clown-sh-t-regional-2026': {
    opening: '2026-07-21', before: '2026-08-02', fixed: null,
    texts: [T('stageraw.com', 'Easy Rhino Productions Through August 2 RECOMMENDED')],
  },
};

// BRO-7319 (a): the Carla Hall extension was on ONE site (mdtheatreguide). The writer no longer moves a date on a
// single review's "EXTENDED through"; the audit (minSites 1) still reports it so a human or a 2nd source settles it.
test('replay carla-hall: single-site extension is held by the writer but still visible to the audit', () => {
  const texts = [
    T('broadwayworld.com', 'Please Underestimate Me runs through July 12, 2026 at Olney Theatre Center'),
    T('mdtheatreguide.com', 'Carla Hall in "Please Underestimate Me" EXTENDED through July 26, 2026 in the Mulitz-Gudelsky'),
  ];
  const show = { opening: '2026-06-14', closing: '2026-07-12' };
  assert.equal(laterAnnouncedRunEnd(show, { texts }), null);
  assert.equal(laterAnnouncedRunEnd(show, { texts }, { minSites: 1 }).date, '2026-07-26');
});

for (const [id, c] of Object.entries(CASES)) {
  test(`replay ${id}: ${c.before} -> ${c.fixed || 'unchanged'}`, () => {
    const r = laterAnnouncedRunEnd({ opening: c.opening, closing: c.before }, { texts: c.texts, listing: c.listing || null });
    assert.equal(r ? r.date : null, c.fixed);
    if (!c.fixed) return;
    // The writer path: unpinned record, run as of the day before the old date (the show was still running).
    const show = { id, status: 'open', openingDate: c.opening, closingDate: c.before };
    assert.equal(applyRunEnd(show, r, c.before), 'written');
    assert.equal(show.closingDate, c.fixed);
  });
}

test('the arsonists without the listing stays put (reviews alone never knew of the extension)', () => {
  const c = CASES['the-arsonists-regional-2026'];
  assert.equal(laterAnnouncedRunEnd({ opening: c.opening, closing: c.before }, { texts: c.texts }), null);
});

test('a pinned date moves only for a listing or "extended" source, never for plain review text', () => {
  const pinned = () => ({ id: 'x', status: 'open', openingDate: '2026-10-14', closingDate: '2026-11-15', humanCorrectedClosingDate: true });
  const text = laterAnnouncedRunEnd({ opening: '2026-10-14', closing: '2026-11-15' }, { texts: CASES['saint-megan-regional-2026'].texts });
  const s1 = pinned();
  assert.equal(applyRunEnd(s1, text, '2026-11-10'), 'pinned');
  assert.equal(s1.closingDate, '2026-11-15');
  const s2 = pinned();
  const listing = laterAnnouncedRunEnd({ opening: '2026-10-14', closing: '2026-11-15' }, { texts: [], listing: { date: '2026-11-29', url: 'https://www.theatreinla.com/saint-megan/1/' } });
  assert.equal(applyRunEnd(s2, listing, '2026-11-10'), 'written');
  assert.equal(s2.closingDate, '2026-11-29');
  assert.equal(s2.humanCorrectedClosingDate, true);
});

test('a show auto-closed on its stale date reopens when the later end is still ahead', () => {
  const show = { id: 'y', status: 'closed', openingDate: '2026-10-14', closingDate: '2026-11-08' };
  const r = laterAnnouncedRunEnd({ opening: '2026-10-14', closing: '2026-11-08' }, { texts: [], listing: { date: '2026-11-22', url: 'https://www.theatreinla.com/y/2/' } });
  assert.equal(applyRunEnd(show, r, '2026-11-10'), 'written');
  assert.equal(show.status, 'open');
});

test('"Extended to January 2027" in a sidebar is not read as January 20 (real 1972 false positive)', () => {
  assert.deepEqual(runEndCandidates('Slam Frank Extended to January 2027 with Added Saturday shows', { opening: '2026-10-27' }), []);
  assert.deepEqual(runEndCandidates('Tickets Now on Sale Through April 2027', { opening: '2026-10-27' }), []);
});

test('scope: launched-hub running shows and shows closed in the last 21 days', () => {
  const L = new Set(['los-angeles-ca']);
  const base = { localOnly: true, city: 'los-angeles-ca', openingDate: '2026-09-01' };
  assert.equal(inScope({ ...base, status: 'open' }, L, '2026-11-10'), true);
  assert.equal(inScope({ ...base, status: 'closed', closingDate: '2026-11-01' }, L, '2026-11-10'), true);
  assert.equal(inScope({ ...base, status: 'closed', closingDate: '2026-09-01' }, L, '2026-11-10'), false);
  assert.equal(inScope({ ...base, city: 'denver-co', status: 'open' }, L, '2026-11-10'), false);
});

test('a hoped-for extension is not an announcement (real misery-regional-2024: one blog vs seven sites)', () => {
  const texts = [
    T('letsplaytheatricalreview.com', 'Hopefully, it will get extended to October 31 for a good Halloween'),
    T('chicagotribune.com', 'When: Through Oct. 26 Where: American Blues Theater'),
    T('suntimes.com', 'When: Through Oct. 26 Where: American Blues Theater'),
  ];
  assert.equal(laterAnnouncedRunEnd({ opening: '2024-09-27', closing: '2024-10-26' }, { texts }), null);
});

test('one site alone cannot move a date with plain "through" text (needs two sites)', () => {
  const texts = [T('stageraw.com', 'Through Aug. 9 RECOMMENDED')];
  assert.equal(laterAnnouncedRunEnd({ opening: '2026-06-20', closing: '2026-07-19' }, { texts }), null);
  assert.equal(laterAnnouncedRunEnd({ opening: '2026-06-20', closing: '2026-07-19' }, { texts }, { minSites: 1 }).date, '2026-08-09');
});

test('replay hayward-regional-2026: a hand-entered date with no source moves, but is not logged as a later-announced extension', () => {
  const show = { id: 'hayward-regional-2026', status: 'open', openingDate: '2026-10-14', closingDate: '2026-11-15' };
  const r = laterAnnouncedRunEnd({ opening: '2026-10-14', closing: '2026-11-15' }, { texts: [], listing: { date: '2026-11-22', url: 'https://www.theatreinla.com/hayward/3/' } });
  assert.equal(applyRunEnd(show, r, '2026-11-10'), 'written');
  assert.equal(show.closingDate, '2026-11-22');
  assert.ok(!(show.closingExtensions || []).length, 'no recorded source: the old date was never announced, so this is a correction');
  const sourced = { ...show, closingDate: '2026-11-15', closingDateSource: 'theatreinla listing' };
  delete sourced.closingExtensions;
  applyRunEnd(sourced, r, '2026-11-10');
  assert.equal((sourced.closingExtensions || []).length, 1, 'a sourced date moving later is an extension');
});

// BRO-7291 recurrence (weekly audit 2026-W47, chicago-il): Hayward extended to Nov 22 on Steppenwolf's own page
// (header + schema.org Event list) while theatreinchicago still printed "Thru - Nov 15, 2026". Excerpts are the
// real pages fetched 2026-11-17; the record before the fix had closingDate 2026-11-15, status closed.
const { runEndFromTheatrePage } = require('./run-end-from-text.js');
const { theatrePageUrl } = require('../harvest-hub-run-dates.js');
const STEPPENWOLF_HEADER = `<p class="production-header__tag"><span>The Gift Theatre Presents</span></p>
<h1 id="page-header__title" class="production-header__title">\t\t\tHayward\t</h1>
<p class="production-header__subtitle">A World Premiere</p>
<time datetime="2026-10-14T00:00:00-05:00" class="production-header__date">Oct 14 &ndash; Nov 22, 2026</time>`;
const STEPPENWOLF_LD = `<script type="application/ld+json">[{"@context":"https://schema.org","@type":"Event","name":"Hayward - Sunday, November 15, 2026 3:00 PM","startDate":"2026-11-15T15:00:00-06:00"},{"@context":"https://schema.org","@type":"Event","name":"Hayward - Sunday, November 22, 2026 3:00 PM","startDate":"2026-11-22T15:00:00-06:00"}]</script>`;
const HAYWARD = { title: 'Hayward', firstPerformance: '2026-10-14' };

test('replay hayward-regional-2026 W47: the theatre page (range + Event list) beats the lagging listing', () => {
  for (const html of [STEPPENWOLF_HEADER, STEPPENWOLF_LD + STEPPENWOLF_HEADER]) {
    assert.equal(runEndFromTheatrePage(html, HAYWARD).date, '2026-11-22');
  }
  assert.equal(runEndFromTheatrePage(STEPPENWOLF_LD + '<h1>Hayward</h1>', HAYWARD).how, 'jsonld');
  const d = laterAnnouncedRunEnd({ opening: '2026-10-20', closing: '2026-11-15' }, {
    texts: [],
    listing: { date: '2026-11-15', url: 'https://www.theatreinchicago.com/hayward/13552/' },
    theatrePage: { date: '2026-11-22', url: 'https://www.steppenwolf.org/whats-on/2026-2027/hayward' },
  });
  assert.equal(d.date, '2026-11-22');
  assert.equal(d.kind, 'theatre-page');
  // without the theatre page the listing alone keeps the stale date (the miss this replays)
  assert.equal(laterAnnouncedRunEnd({ opening: '2026-10-20', closing: '2026-11-15' }, { texts: [], listing: { date: '2026-11-15', url: 'x' } }), null);
  // the stale auto-closed record reopens (today 2026-11-17 is before the new end)
  const show = { id: 'hayward-regional-2026', openingDate: '2026-10-20', closingDate: '2026-11-15', status: 'closed' };
  assert.equal(applyRunEnd(show, d, '2026-11-17'), 'written');
  assert.equal(show.closingDate, '2026-11-22');
  assert.equal(show.status, 'open');
});

test('theatre page: other productions on the page never supply the date', () => {
  // a season sidebar lists another show whose run does not start near ours
  const sidebar = '<h1>Hayward</h1><p>Also this season: Fen, Jan 8 – Feb 22, 2027</p><script type="application/ld+json">{"@type":"Event","name":"Fen","endDate":"2027-02-22"}</script>';
  assert.equal(runEndFromTheatrePage(sidebar, HAYWARD), null);
  // a page that never names the production is not its page
  assert.equal(runEndFromTheatrePage('<h1>Fen</h1><time>Oct 14 – Nov 22, 2026</time>', HAYWARD), null);
});

test('theatre page url: officialUrl or the venue box-office link, never a reseller or the listing site', () => {
  assert.equal(theatrePageUrl({ ticketLinks: [{ platform: 'Venue Box Office', url: 'https://www.steppenwolf.org/whats-on/2026-2027/hayward' }] }), 'https://www.steppenwolf.org/whats-on/2026-2027/hayward');
  assert.equal(theatrePageUrl({ officialUrl: 'https://www.todaytix.com/x', ticketLinks: [{ platform: 'TodayTix', url: 'https://www.todaytix.com/y' }] }), null);
  assert.equal(theatrePageUrl({ ticketLinks: [{ platform: 'Official site', url: 'https://www.theatreinchicago.com/hayward/13552/' }] }), null);
});

// Failing inputs from the ship-check reviewers (Claude + Codex): each would have moved a date wrongly.
test('theatre page: an "Up next" range starting inside the window is not our run', () => {
  const html = '<h1>Hayward</h1><time>Oct 14 &ndash; Nov 15, 2026</time><aside>Up next: Fen Nov 1 &ndash; Dec 20, 2026</aside><aside>Up next: A Christmas Carol Nov 27 &ndash; Dec 28, 2026</aside>';
  assert.equal(runEndFromTheatrePage(html, HAYWARD).date, '2026-11-15');
});
test('theatre page: EventSeries, cancelled performances and substring titles are ignored', () => {
  const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
  assert.equal(runEndFromTheatrePage('<h1>Hayward</h1>' + ld({ '@type': 'EventSeries', name: '2026-27 Season: Hayward, Fen and more', startDate: '2026-09-01', endDate: '2027-04-30' }), HAYWARD), null);
  assert.equal(runEndFromTheatrePage('<h1>Hayward</h1>' + ld({ '@type': 'TheaterEvent', name: 'Hayward', startDate: '2026-11-22T15:00:00-06:00', eventStatus: 'https://schema.org/EventCancelled' }), HAYWARD), null);
  assert.equal(runEndFromTheatrePage('<h1>Fences</h1><time>Oct 14 &ndash; Nov 22, 2026</time>', { title: 'Fen', firstPerformance: '2026-10-14' }), null);
  // ItemList nesting is read (schema the shared ob-listing-platforms reader also handles)
  const list = ld({ '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', item: { '@type': 'TheaterEvent', name: 'Hayward', startDate: '2026-11-22T15:00:00-06:00' } }] });
  assert.equal(runEndFromTheatrePage('<h1>Hayward</h1>' + list, HAYWARD).date, '2026-11-22');
});
test('theatre page: a UTC evening timestamp is the US local day', () => {
  const html = '<h1>Hayward</h1><script type="application/ld+json">{"@type":"TheaterEvent","name":"Hayward","startDate":"2026-11-16T01:30:00Z"}</script>';
  assert.equal(runEndFromTheatrePage(html, HAYWARD).date, '2026-11-15');
});
test('theatre page never overrides a hand-pinned date alone, and a stale one never hides two agreeing reviews', () => {
  const pinned = { openingDate: '2026-10-20', closingDate: '2026-11-15', humanCorrectedClosingDate: '2026-11-15', status: 'open' };
  const d = laterAnnouncedRunEnd({ opening: '2026-10-20', closing: '2026-11-15' }, { texts: [], theatrePage: { date: '2026-11-22', url: 'https://www.steppenwolf.org/x' } });
  assert.equal(applyRunEnd(pinned, d, '2026-11-17'), 'pinned');
  assert.equal(pinned.closingDate, '2026-11-15');
  const two = [T('a.com', 'Hayward runs through December 20, 2026.'), T('b.com', 'Hayward runs through December 20, 2026.')];
  const r = laterAnnouncedRunEnd({ opening: '2026-10-20', closing: '2026-11-15' }, { texts: two, theatrePage: { date: '2026-11-15', url: 'x' } });
  assert.equal(r && r.date, '2026-12-20');
});
