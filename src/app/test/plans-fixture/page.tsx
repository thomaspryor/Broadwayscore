import { getAllShows } from '@/lib/data-core';
import { resolvePlanShowsFromCatalog } from '@/lib/shared-plans/resolve-server';
import { buildSharedPlansView } from '@/lib/shared-plans/view-model';
import SharedPlansView from '../../plans/[token]/SharedPlansView';

/**
 * Visual/E2E fixture for the Shared Plans page (BRO-4481): the real view and
 * real catalog shows, with a made-up share so no database is needed.
 * ?state=empty renders the nothing-planned state. Guarded by /test's TestGuard.
 */
export const dynamic = 'force-dynamic';

function addDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default async function PlansFixturePage({ searchParams }: { searchParams: { state?: string } }) {
  const open = getAllShows()
    .filter(s => s.status === 'open' && s.images?.poster)
    .slice(0, 7)
    .map(s => s.id);
  const entries = searchParams.state === 'empty' ? [] : [
    { show_id: open[0], planned_date: addDays(40), logged: false },
    { show_id: open[1], planned_date: addDays(3), logged: false },
    { show_id: open[2], planned_date: addDays(12), logged: false },
    ...open.slice(3).map(id => ({ show_id: id, planned_date: null, logged: false })),
  ].filter(e => e.show_id);
  const shows = await resolvePlanShowsFromCatalog(entries.map(e => e.show_id));
  const view = buildSharedPlansView({ name: 'Tom', showBooked: true, showUnbooked: true, entries }, shows, Date.now());
  return <SharedPlansView view={view} />;
}
