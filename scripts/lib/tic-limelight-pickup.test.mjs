// LIVE-DATA-LANE: runDaily -> applyAddShow reads data/retired-show-ids.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-8454 class guards for the Theatre Limelight pickup: type filter, top-ups, remounts, ingest queue.
// Pure logic only (no live data), so it runs in test.yml.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const stage = require('./tic-stage.js');
const daily = require('./tic-daily.js');
const { getCity } = require('./tic-cities.js');

const chi = getCity('chicago');
const detailOf = (showType, extra = {}) => ({ empty: false, title: 'T', venue: 'Chicago Shakespeare Theater', address: '800 E Grand Ave Chicago', showType, closingDate: '2026-12-01', description: '', ...extra });
const pg = { title: 'T', venue: 'Chicago Shakespeare Theater' };

test('type filter: scripted plays labelled Comedy / Performance Art are accepted', () => {
  const plays = [
    detailOf('Comedy', { description: "Shakespeare's A Midsummer Night's Dream, directed by ..." }),
    detailOf('Comedy', { title: "Who's Holiday!", venue: 'Theater Wit', description: 'A one-woman holiday play by Matthew Lombardo.' }),
    detailOf('Performance Art', { title: 'The Old Man and The Old Moon', venue: '1st Stage', description: 'A new musical play.' }),
  ];
  for (const d of plays) assert.equal(stage.detailFilter(d, { title: d.title, venue: d.venue }, chi).ok, true, d.title);
});

test('type filter: stand-up, improv, sketch, magic and puppet shows stay out', () => {
  const nonPlays = [
    detailOf('Comedy', { title: 'The Second City Mainstage Revue', venue: 'The Second City', description: 'Sketch comedy and improv.' }),
    detailOf('Comedy', { title: 'Late Night Laughs', venue: 'Zanies', description: 'Stand-up comedians.' }),
    detailOf('Performance Art', { title: 'The Magic Parlour', venue: 'Theater', description: 'An evening of close-up magic and illusion.' }),
    detailOf('Performance Art', { title: 'Blood & Puppets', venue: 'Theater', description: 'A puppet spectacle.' }),
  ];
  for (const d of nonPlays) {
    const r = stage.detailFilter(d, { title: d.title, venue: d.venue }, chi);
    assert.equal(r.ok, false, d.title);
    assert.match(r.reason, /^type:/);
  }
});

test('type filter: a hard-excluded type is still dropped', () => {
  assert.equal(stage.detailFilter(detailOf('Childrens'), pg, chi).ok, false);
});

test('rules version: old type: rejections are re-queued once, other finals are not', () => {
  const listing = [{ id: 1, reviewCount: 5 }, { id: 2, reviewCount: 5 }, { id: 3, reviewCount: 5 }, { id: 4, reviewCount: 5 }];
  const seen = {
    1: { reason: 'type:Comedy', retry: false },                                  // made before the rule changed
    2: { reason: 'type:Comedy', retry: false, rv: daily.RULES_VERSION },         // already judged by the current rules
    3: { reason: 'virtual', retry: false },                                      // unrelated final
  };
  assert.deepEqual(daily.pickCandidates(listing, [], seen).map((r) => r.id).sort(), [1, 4]);
});

const showRow = (id, ticId, opening, closing) => ({ id, evidenceUrls: [`https://www.theatreinchicago.com/x/${ticId}/`], openingDate: opening, closingDate: closing });

test('top-ups run for Chicago (minOutlets 3) and compare against the listing count', () => {
  assert.ok(chi.minOutlets >= 3 || !chi.minOutlets, 'precondition: Chicago has no under-3 top-up path');
  const shows = [showRow('adirondack-regional-2026', 13363, '2026-10-01', '2026-12-01')];
  const listing = [{ id: 13363, reviewCount: 20 }];
  assert.deepEqual(daily.pickTopups(listing, shows, { 13363: { reason: 'added', reviews: 7, listed: 7 } }, chi).map((r) => r.id), [13363]);
  // After a top-up the listing count is recorded, so a link count below it does not re-queue every day.
  assert.deepEqual(daily.pickTopups(listing, shows, { 13363: { reason: 'added', reviews: 17, listed: 20 } }, chi), []);
});

test('top-up targets the newest row when a listing id has two seasons', () => {
  const shows = [showRow('a-2025', 7, '2025-11-23', '2025-12-28'), showRow('a-2026', 7, '2026-11-20', '2026-12-31')];
  assert.equal(daily.latestRowByTicId(shows, chi).get(7).id, 'a-2026');
});

test('runDaily tops up a Chicago show from the listing and records `listed`', async () => {
  const shows = [showRow('adirondack-regional-2026', 13363, '2026-10-01', '2026-12-01')];
  const page = { id: 13363, empty: false, title: 'T', venue: 'V', closingDate: '2026-12-01', reviews: Array.from({ length: 9 }, (_, i) => ({ outlet: `O${i}`, critic: 'A', url: `https://e.com/${i}` })) };
  const io = { page: async () => page, detail: async () => detailOf('Play'), dates: async () => null };
  const out = await daily.runDaily({ today: '2026-11-28', listing: [{ id: 13363, reviewCount: 9 }], shows, seen: { 13363: { reason: 'added', reviews: 3, listed: 3 } }, io });
  assert.equal(out.topups.length, 1);
  assert.equal(out.topups[0].id, 'adirondack-regional-2026');
  assert.equal(out.seen[13363].listed, 9);
});

test('remount: only an old row with a much later first review counts', () => {
  const row = { openingDate: '2025-11-23' };
  const today = '2026-11-28';
  assert.equal(daily.isRemount({ row, dates: { openingDate: '2026-11-21' }, closingDate: '2026-12-31', today }), true);
  assert.equal(daily.isRemount({ row, dates: { openingDate: '2025-12-01' }, closingDate: '2026-12-31', today }), false); // same season
  assert.equal(daily.isRemount({ row, dates: { openingDate: '2026-11-21' }, closingDate: '2026-06-01', today }), false);  // already ended
  assert.equal(daily.isRemount({ row, dates: null, closingDate: '2026-12-31', today }), false);
});

test('remount checks: old rows only, throttled by remountCheckedOn', () => {
  const shows = [showRow('old', 1, '2025-11-23', '2026-12-31'), showRow('fresh', 2, '2026-10-01', '2026-12-31')];
  const listing = [{ id: 1, reviewCount: 5 }, { id: 2, reviewCount: 5 }];
  assert.deepEqual(daily.pickRemountChecks(listing, shows, {}, '2026-11-28', chi).map((r) => r.id), [1]);
  assert.deepEqual(daily.pickRemountChecks(listing, shows, { 1: { remountCheckedOn: '2026-11-20' } }, '2026-11-28', chi), []);
});

test('runDaily stages a remount as its own row with its own reviews and clamps the old season', async () => {
  const old = { ...showRow('a-christmas-carol-regional-2025', 7213, '2025-11-23', '2026-12-31'), title: 'A Christmas Carol', venue: 'Goodman Theatre', city: 'chicago-il', status: 'open' };
  const shows = [old];
  const page = { id: 7213, slug: 'a-christmas-carol', empty: false, title: 'A Christmas Carol', venue: 'Goodman Theatre', poster: null, closingDate: '2026-12-31',
    reviews: Array.from({ length: 4 }, (_, i) => ({ outlet: `Outlet ${i}`, critic: 'A', verdict: 'recommended', url: `https://e.com/2026/${i}` })) };
  const det = { empty: false, title: 'A Christmas Carol', venue: 'Goodman Theatre', address: '170 N Dearborn St Chicago', showType: 'Play', closingDate: '2026-12-31' };
  const io = { page: async () => page, detail: async () => det, dates: async () => ({ openingDate: '2026-11-21', samples: ['2026-11-21'] }), knownUrls: () => new Set(['https://e.com/2025/old']) };
  const out = await daily.runDaily({ today: '2026-11-28', listing: [{ id: 7213, reviewCount: 4 }], shows, seen: { 7213: { reason: 'added', reviews: 4, listed: 4 } }, io });
  const fresh = shows.find((s) => s !== old);
  assert.ok(fresh, 'a second row was staged');
  assert.equal(fresh.openingDate, '2026-11-21');
  assert.notEqual(fresh.id, old.id);
  assert.equal(out.added[0].remountOf, old.id);
  assert.equal(out.added[0].urls.length, 4);
  // The clamp rides with the save: nothing is closed until the new row is on disk.
  assert.equal(old.status, 'open');
  assert.deepEqual(out.added[0].clampPrior, { id: old.id, closingDate: '2026-11-20' });
  const doc = { shows };
  daily.saveAddedShows(doc, out.added, { save: () => {}, nextSeen: out.seen, today: '2026-11-28' });
  assert.ok(old.closingDate < fresh.openingDate, `old row closing ${old.closingDate} must end before the new season`);
  assert.equal(old.status, 'closed');
});

test('ingest queue: waits for a slot instead of starving later cities, then defers the rest', async () => {
  const q = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  let slots = 0; const sent = []; let slept = 0;
  const out = await daily.drainIngestQueue({
    queue: q,
    check: () => (slots > 0 ? { ok: true } : { ok: false, reason: 'cap' }),
    dispatchOne: (a) => { sent.push(a.id); slots--; },
    sleep: async () => { slept++; slots = slept === 1 ? 2 : 0; }, // a slot frees up after the first wait
    maxWaitMs: 3000, pollMs: 1000,
  });
  assert.deepEqual(sent, ['a', 'b']);
  assert.deepEqual(out.left.map((x) => x.id), ['c']);
});

test('ingest queue: a failed dispatch is kept for tomorrow, not dropped', async () => {
  const out = await daily.drainIngestQueue({ queue: [{ id: 'a' }, { id: 'b' }], check: () => ({ ok: true }), dispatchOne: (a) => { if (a.id === 'a') throw new Error('x'); }, maxWaitMs: 0 });
  assert.deepEqual(out.left.map((x) => x.id), ['a']);
  assert.deepEqual(out.dispatched.map((x) => x.id), ['b']);
});

// BRO-8454 item 4: every venueCities entry of a launched Limelight city must resolve to that city's metro,
// otherwise the venue is dropped as "not local" (Atwater Village, Venice, Topanga, Tysons, Lorton were).
test('wiring: each tic venueCities entry resolves to its own hub metro', () => {
  const hubs = require('../../data/city-hubs.json').hubs;
  const { resolveMetro } = require('./venue-metro.js');
  const bad = [];
  for (const [slug, hub] of Object.entries(hubs)) {
    for (const [city, st] of (hub.tic && hub.tic.venueCities) || []) {
      if (resolveMetro(`Some Theater, ${city}, ${st}`) !== slug) bad.push(`${city}, ${st} -> ${resolveMetro(`Some Theater, ${city}, ${st}`)} (want ${slug})`);
    }
  }
  assert.deepEqual(bad, []);
});

test('wiring: the BRO-8454 gap towns are listed', () => {
  const hubs = require('../../data/city-hubs.json').hubs;
  const has = (slug, c) => hubs[slug].tic.venueCities.some(([x]) => x === c);
  for (const c of ['Atwater Village', 'Venice', 'Topanga']) assert.ok(has('los-angeles-ca', c), c);
  for (const c of ['Tysons', 'Lorton']) assert.ok(has('washington-dc', c), c);
});

test('backfill ids join the listing once and never duplicate a live row', () => {
  const out = daily.withBackfill([{ id: 1, reviewCount: 4 }], [1, 2, 2]);
  assert.deepEqual(out.map((r) => r.id), [1, 2]);
  assert.equal(out[1].backfill, true);
});

test('rules version: outside-metro rejections made before the metro towns were added are re-queued', () => {
  const seen = { 7: { reason: 'outside-metro', retry: false }, 8: { reason: 'outside-metro', retry: false, rv: daily.RULES_VERSION } };
  assert.deepEqual(daily.pickCandidates([{ id: 7, reviewCount: 5 }, { id: 8, reviewCount: 5 }], [], seen).map((r) => r.id), [7]);
});

test('remount: a refused save leaves the prior season untouched', async () => {
  const old = { ...showRow('a-2025', 7, '2025-11-23', '2026-12-31'), status: 'open' };
  const fresh = { id: 'a-2026', openingDate: '2026-11-21' };
  const shows = [old, fresh];
  const seen = { 7: { reason: 'added', id: 'a-2026', reviews: 4, listed: 4 } };
  const landed = daily.saveAddedShows({ shows }, [{ id: 'a-2026', remountOf: 'a-2025', clampPrior: { id: 'a-2025', closingDate: '2026-11-20' } }],
    { save: () => { throw new Error('duplicate of x'); }, nextSeen: seen, today: '2026-11-28' });
  assert.deepEqual(landed, []);
  assert.equal(old.closingDate, '2026-12-31');
  assert.equal(old.status, 'open');
  assert.equal(seen[7].id, 'a-2025');
});

test('remount: reviews already ingested for the prior row mean a late review, not a new season', async () => {
  const old = { ...showRow('a-2025', 7213, '2025-11-23', '2026-12-31'), title: 'A', venue: 'Goodman Theatre', city: 'chicago-il', status: 'open' };
  const shows = [old];
  const page = { id: 7213, slug: 'a', empty: false, title: 'A', venue: 'Goodman Theatre', closingDate: '2026-12-31', reviews: Array.from({ length: 4 }, (_, i) => ({ outlet: `O${i}`, critic: 'A', verdict: 'recommended', url: `https://e.com/same/${i}` })) };
  const known = new Set(page.reviews.map((r) => r.url));
  const io = { page: async () => page, detail: async () => detailOf('Play'), dates: async () => ({ openingDate: '2026-11-21', samples: ['2026-11-21'] }), knownUrls: () => known };
  const out = await daily.runDaily({ today: '2026-11-28', listing: [{ id: 7213, reviewCount: 4 }], shows, seen: { 7213: { reason: 'added', reviews: 4, listed: 4 } }, io });
  assert.equal(out.added.length, 0);
  assert.equal(shows.length, 1);
});

test('backfill rows are never topped up and record listed 0', () => {
  const shows = [showRow('x', 5, '2026-01-01', '2026-02-01')];
  assert.deepEqual(daily.pickTopups([{ id: 5, reviewCount: 99, backfill: true }], shows, {}, chi), []);
});

test('annual-return page: last season row closes, next season closing date is not borrowed (A Noise Within)', () => {
  assert.equal(stage.isAnnualReturn('2025-12-01', '2026-12-24'), true);
  assert.equal(stage.isAnnualReturn('2025-12-01', '2026-01-18'), false); // ordinary 7-week run
  assert.equal(stage.isAnnualReturn('2025-03-01', '2026-09-30'), false); // long run off the anniversary
  const la = getCity('la');
  const page = { id: 8297, slug: 'a-christmas-carol', title: 'A Christmas Carol', venue: 'A Noise Within', closingDate: '2026-12-24', reviews: [] };
  const e = stage.buildShowEntry({ page, detail: { ...detailOf('Play', { venue: 'A Noise Within', address: '3352 E Foothill Blvd Pasadena' }), closingDate: '2026-12-24' }, dates: { openingDate: '2025-12-01' }, discoveredAt: '2026-11-28', city: la });
  assert.equal(e.status, 'closed');
  assert.equal(e.closingDate, undefined);
  const live = stage.buildShowEntry({ page, detail: { ...detailOf('Play', { venue: 'A Noise Within', address: '3352 E Foothill Blvd Pasadena' }), closingDate: '2026-12-24' }, dates: { openingDate: '2026-11-20' }, discoveredAt: '2026-11-28', city: la });
  assert.equal(live.status, 'open');
  assert.equal(live.closingDate, '2026-12-24');
});

test('annual-return listing set aside as before-since is re-evaluated when the listing credits more reviews', async () => {
  const la = getCity('la');
  const mk = (n) => ({ id: 8297, slug: 'a-christmas-carol', empty: false, title: 'A Christmas Carol', venue: 'A Noise Within', closingDate: '2026-12-24', reviews: Array.from({ length: n }, (_, i) => ({ outlet: `O${i}`, critic: 'C', verdict: 'recommended', url: `https://e.com/${i}` })) });
  const io = { page: async () => mk(3), detail: async () => detailOf('Play', { venue: 'A Noise Within', address: '3352 E Foothill Blvd Pasadena', closingDate: '2026-12-24' }), dates: async () => ({ openingDate: '2025-12-01', samples: ['2025-12-01'] }) };
  const out = await daily.runDaily({ today: '2026-11-28', listing: [{ id: 8297, reviewCount: 3 }], shows: [], seen: {}, io, city: la });
  assert.equal(out.added.length, 0);
  assert.equal(out.seen[8297].reason, 'before-since');
  assert.equal(out.seen[8297].annual, true);
  assert.deepEqual(daily.pickCandidates([{ id: 8297, reviewCount: 3 }], [], out.seen, la), []);
  assert.equal(daily.pickCandidates([{ id: 8297, reviewCount: 5 }], [], out.seen, la).length, 1);
  // The new season's reviews now date from this year: the row is added open with the printed closing date.
  const io2 = { ...io, page: async () => mk(5), dates: async () => ({ openingDate: '2026-11-20', samples: ['2026-11-20'] }) };
  const again = await daily.runDaily({ today: '2026-11-29', listing: [{ id: 8297, reviewCount: 5 }], shows: [], seen: out.seen, io: io2, city: la });
  assert.equal(again.added.length, 1);
  assert.equal(again.added[0].status, 'open');
});
