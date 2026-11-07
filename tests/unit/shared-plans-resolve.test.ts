/**
 * Shared Plans show resolution (src/lib/shared-plans/resolve.ts, BRO-4481).
 * Lookups are injected, so this needs neither the private data clone nor
 * Supabase.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlanShows, type CatalogShow } from '../../src/lib/shared-plans/resolve';
import type { DiaryShowDetail } from '../../src/lib/diary-show-types';

const catalog: Record<string, CatalogShow> = {
  'wicked-2003': {
    id: 'wicked-2003', slug: 'wicked', title: 'Wicked', venue: 'Gershwin Theatre', category: 'broadway',
    status: 'open', images: { poster: 'https://img/wicked.jpg' }, theaterAddress: '222 W 51st St', runtime: '2h 45m',
    openingDate: '2003-10-30',
  },
  'hamlet-west-end-2026': {
    id: 'hamlet-west-end-2026', slug: 'hamlet-west-end-2026', title: 'Hamlet', venue: 'Theatre Royal', category: 'west-end',
    status: 'upcoming', images: { thumbnail: 'https://img/hamlet-thumb.jpg' }, previewsStartDate: '2026-11-02', ticketLinks: [{ url: 'x' }],
  },
};
const diary: Record<string, DiaryShowDetail> = {
  'small-play-ob-2019': {
    id: 'small-play-ob-2019', title: 'Small Play', slug: 'small-play-ob-2019', venue: 'Black Box', city: 'New York',
    country: 'US', category: 'off-broadway', openingDate: '2019-03-01', posterUrl: null,
  },
};
const stubs: Record<string, DiaryShowDetail> = {
  'fresh-import-mz1234': {
    id: 'fresh-import-mz1234', title: 'Fresh Import', slug: 'fresh-import-mz1234', venue: 'Somewhere', city: null,
    country: null, category: 'us-regional', openingDate: null, posterUrl: 'https://img/fresh.jpg',
  },
};

const deps = {
  getShow: (id: string) => catalog[id],
  getDiaryShow: (id: string) => diary[id] ?? null,
  getStubs: async (ids: readonly string[]) => new Map(ids.filter(id => stubs[id]).map(id => [id, stubs[id]] as const)),
};

test('resolves each source and drops unknown ids', async () => {
  const out = await resolvePlanShows(
    ['wicked-2003', 'hamlet-west-end-2026', 'small-play-ob-2019', 'fresh-import-mz1234', 'deleted-show-1999'],
    deps,
  );
  assert.deepEqual(Array.from(out.keys()).sort(), ['fresh-import-mz1234', 'hamlet-west-end-2026', 'small-play-ob-2019', 'wicked-2003']);
});

test('main-catalog show: show-page href, poster, status for the badge, calendar source', async () => {
  const w = (await resolvePlanShows(['wicked-2003'], deps)).get('wicked-2003')!;
  assert.equal(w.href, '/show/wicked');
  assert.equal(w.posterUrl, 'https://img/wicked.jpg');
  assert.deepEqual(w.bookability, { status: 'open', previewDate: null, openingDate: '2003-10-30', ticketsOnSale: false });
  assert.equal(w.status, 'open');
  assert.deepEqual(w.calendar, {
    id: 'wicked-2003', title: 'Wicked', slug: 'wicked', category: 'broadway',
    venue: 'Gershwin Theatre', theaterAddress: '222 W 51st St', runtime: '2h 45m',
  });
});

test('poster falls back to thumbnail', async () => {
  const h = (await resolvePlanShows(['hamlet-west-end-2026'], deps)).get('hamlet-west-end-2026')!;
  assert.equal(h.posterUrl, 'https://img/hamlet-thumb.jpg');
  assert.equal(h.category, 'west-end');
  assert.equal(h.bookability?.ticketsOnSale, true, 'upcoming + ticket links = tix on sale (same rule as show-lookup tx)');
  assert.equal(h.bookability?.previewDate, '2026-11-02');
});

test('catalog-only shows link to the diary page and have no status badge', async () => {
  const out = await resolvePlanShows(['small-play-ob-2019', 'fresh-import-mz1234'], deps);
  const s = out.get('small-play-ob-2019')!;
  assert.equal(s.href, '/diary-show/small-play-ob-2019');
  assert.equal(s.bookability, null);
  assert.equal(s.status, null);
  assert.equal(s.calendar.diaryOnly, true);
  assert.equal(out.get('fresh-import-mz1234')!.posterUrl, 'https://img/fresh.jpg');
});

test('duplicate ids resolve once', async () => {
  let calls = 0;
  const out = await resolvePlanShows(['wicked-2003', 'wicked-2003'], { ...deps, getShow: (id: string) => { calls++; return catalog[id]; } });
  assert.equal(out.size, 1);
  assert.equal(calls, 1);
});

test('stub lookups are one batched call for every id the catalog missed, and a failure drops only those', async () => {
  const calls: string[][] = [];
  const out = await resolvePlanShows(
    ['wicked-2003', 'fresh-import-mz1234', 'small-play-ob-2019', 'gone-mz1', 'gone-mz2'],
    { ...deps, getStubs: async ids => { calls.push([...ids]); return deps.getStubs(ids); } },
  );
  assert.deepEqual(calls, [['fresh-import-mz1234', 'gone-mz1', 'gone-mz2']]);
  assert.ok(out.has('fresh-import-mz1234'));
  const down = await resolvePlanShows(['wicked-2003', 'fresh-import-mz1234'], { ...deps, getStubs: async () => { throw new Error('supabase down'); } });
  assert.deepEqual(Array.from(down.keys()), ['wicked-2003']);
});

test('no stub call when the catalog knows every id', async () => {
  let called = false;
  await resolvePlanShows(['wicked-2003', 'small-play-ob-2019'], { ...deps, getStubs: async () => { called = true; return new Map(); } });
  assert.equal(called, false);
});
