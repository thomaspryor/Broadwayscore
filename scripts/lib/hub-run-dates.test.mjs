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
  'carla-hall-please-underestimate-me-regional-2026': {
    opening: '2026-06-14', before: '2026-07-12', fixed: '2026-07-26',
    texts: [
      T('broadwayworld.com', 'Please Underestimate Me runs through July 12, 2026 at Olney Theatre Center'),
      T('mdtheatreguide.com', 'Carla Hall in "Please Underestimate Me" EXTENDED through July 26, 2026 in the Mulitz-Gudelsky'),
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
