import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ticIdOf, pickCandidates, runDaily } = require('./tic-daily.js');

const mkPage = (id, title, outlets = 3, venue = 'Steppenwolf Theatre') => ({
  id, slug: 'slug', empty: false, title, venue, poster: null, closingDate: '2026-12-01',
  reviews: Array.from({ length: outlets }, (_, i) => ({ outlet: `Outlet ${i}`, critic: 'A', verdict: 'recommended', url: `https://example.com/${id}/${i}` })),
});
const detail = { empty: false, title: 'x', venue: 'Steppenwolf Theatre', address: '1650 N Halsted St Chicago', showType: 'Play', closingDate: '2026-12-01' };
const mkIo = (pages, dates = { openingDate: '2026-10-20', samples: ['2026-10-20'] }, det = detail) => ({
  page: async (id) => pages[id], detail: async () => det, dates: async () => dates,
});
const row = (id, n = 3) => ({ id, reviewCount: n });
const base = { today: '2026-10-29' };

test('ticIdOf reads the id from evidenceUrls', () => {
  assert.equal(ticIdOf({ evidenceUrls: ['https://www.theatreinchicago.com/foo/13601/'] }), 13601);
  assert.equal(ticIdOf({ evidenceUrls: [] }), null);
});

test('pickCandidates skips known, finally-rejected and thin listings but keeps retries', () => {
  const shows = [{ evidenceUrls: ['https://www.theatreinchicago.com/a/1/'] }];
  const seen = { 2: { reason: 'virtual', retry: false }, 3: { reason: 'under-3-outlets', retry: true } };
  const got = pickCandidates([row(1), row(2), row(3), row(4), row(5, 2)], shows, seen).map((r) => r.id);
  assert.deepEqual(got, [3, 4]);
});

test('runDaily adds an accepted show with the Chicago fields and remembers it', async () => {
  const shows = [];
  const out = await runDaily({ ...base, listing: [row(10)], shows, seen: {}, io: mkIo({ 10: mkPage(10, 'Fresh Play') }) });
  assert.equal(out.added.length, 1);
  const s = shows[0];
  assert.equal(s.id, 'fresh-play-regional-2026');
  assert.equal(s.city, 'chicago-il');
  assert.equal(s.localOnly, true);
  assert.equal(out.seen[10].reason, 'added');
  assert.equal(out.added[0].urls.length, 3);
});

test('thin pages are retried tomorrow, virtual venues are final', async () => {
  const shows = [];
  const pages = { 11: mkPage(11, 'Thin', 2), 12: mkPage(12, 'Online', 3, 'Online Stream') };
  const out = await runDaily({ ...base, listing: [row(11), row(12)], shows, seen: {}, io: mkIo(pages) });
  assert.equal(out.added.length, 0);
  assert.equal(out.seen[11].retry, true);
  assert.equal(out.seen[12].retry, false);
  const again = await runDaily({ ...base, listing: [row(11), row(12)], shows, seen: out.seen, io: mkIo({ ...pages, 11: mkPage(11, 'Thin', 4) }) });
  assert.equal(again.added.length, 1);
});

test('a fetch error is not remembered', async () => {
  const io = { page: async () => { throw new Error('boom'); }, detail: async () => detail, dates: async () => null };
  const out = await runDaily({ ...base, listing: [row(20)], shows: [], seen: {}, io });
  assert.equal(out.seen[20], undefined);
});

test('rerunning does not add the same show twice', async () => {
  const shows = [];
  const io = mkIo({ 30: mkPage(30, 'Once Only') });
  await runDaily({ ...base, listing: [row(30)], shows, seen: {}, io });
  const second = await runDaily({ ...base, listing: [row(30)], shows, seen: {}, io });
  assert.equal(second.added.length, 0);
  assert.equal(shows.length, 1);
});
