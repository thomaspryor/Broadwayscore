// Server-only: load a diary share and build its view. Shared by the page,
// its metadata and its preview image so all three agree on every count.
import { resolvePlanShowsFromCatalog } from '@/lib/shared-plans/resolve-server';
import { loadSharedDiary } from './load';
import { buildSharedDiaryView, type SharedDiaryView } from './view-model';

export type SharedDiaryPageData =
  | { status: 'ok'; view: SharedDiaryView }
  | { status: 'not-shared' }
  | { status: 'unavailable' };

export async function loadSharedDiaryView(token: string, nowMs = Date.now()): Promise<SharedDiaryPageData> {
  const loaded = await loadSharedDiary(token);
  if (loaded.status !== 'ok') return loaded;
  const shows = await resolvePlanShowsFromCatalog(loaded.payload.entries.map(e => e.show_id));
  return { status: 'ok', view: buildSharedDiaryView(loaded.payload, shows, nowMs) };
}
