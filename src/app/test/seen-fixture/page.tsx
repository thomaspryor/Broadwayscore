import { getAllShows } from '@/lib/data-core';
import { resolvePlanShowsFromCatalog } from '@/lib/shared-plans/resolve-server';
import type { SharedDiaryEntry } from '@/lib/shared-diary/select';
import { buildSharedDiaryView } from '@/lib/shared-diary/view-model';
import SeenView from '../../seen/[token]/SeenView';

/**
 * Visual/E2E fixture for the Shared Diary page (BRO-4566): the real view and
 * real catalog shows, with a made-up share so no database is needed.
 * ?state=empty → nothing logged; ?state=capped → the 1,000-entry note;
 * ?name=long → a 30-character name. Covers undated entries, a show with no
 * poster and a future-dated entry (which must not appear). Guarded by /test's
 * TestGuard.
 */
export const dynamic = 'force-dynamic';

function addDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default async function SeenFixturePage({ searchParams }: { searchParams: { state?: string; name?: string } }) {
  const all = getAllShows();
  const posters = all.filter(s => s.status === 'closed' && s.images?.poster).slice(0, 8).map(s => s.id);
  const noPoster = all.find(s => !s.images?.poster && !s.images?.thumbnail)?.id;
  const thisYear = new Date().getUTCFullYear();
  const entries: SharedDiaryEntry[] = searchParams.state === 'empty' ? [] : [
    { show_id: posters[0], date_seen: addDays(30), rating: 5 },            // a plan: never shown
    { show_id: posters[1], date_seen: addDays(-3), rating: 4.5 },
    { show_id: posters[2], date_seen: addDays(-40), rating: 3 },
    { show_id: posters[3], date_seen: `${thisYear - 1}-11-15`, rating: 5 },
    { show_id: posters[4], date_seen: `${thisYear - 1}-03-02`, rating: 2.5 },
    { show_id: posters[1], date_seen: `${thisYear - 1}-01-20`, rating: 4 },  // seen twice
    { show_id: posters[5], date_seen: `${thisYear - 3}-06-10`, rating: 0 },  // no rating
    ...(noPoster ? [{ show_id: noPoster, date_seen: `${thisYear - 3}-05-01`, rating: 3.5 }] : []),
    { show_id: posters[6], date_seen: null, rating: 4 },
    { show_id: posters[7], date_seen: null, rating: 1 },
  ].filter(e => e.show_id);
  const shows = await resolvePlanShowsFromCatalog(entries.map(e => e.show_id));
  const name = searchParams.name === 'long' ? 'Bartholomew Montgomery-Smythe'.slice(0, 30) : 'Tom';
  const view = buildSharedDiaryView({ name, showText: false, capped: searchParams.state === 'capped', entries }, shows, Date.now());
  return <SeenView view={view} />;
}
