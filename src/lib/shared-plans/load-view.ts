// Server-only: load a share and build its view. Shared by the plans page,
// its metadata and its preview image so all three agree on every count.
import { loadSharedPlans } from './load';
import { resolvePlanShowsFromCatalog } from './resolve-server';
import { buildSharedPlansView, type SharedPlansView } from './view-model';

export type SharedPlansPageData =
  | { status: 'ok'; view: SharedPlansView }
  | { status: 'not-shared' }
  | { status: 'unavailable' };

export async function loadSharedPlansView(token: string, nowMs = Date.now()): Promise<SharedPlansPageData> {
  const loaded = await loadSharedPlans(token);
  if (loaded.status !== 'ok') return loaded;
  const shows = await resolvePlanShowsFromCatalog(loaded.payload.entries.map(e => e.show_id));
  return { status: 'ok', view: buildSharedPlansView(loaded.payload, shows, nowMs) };
}
