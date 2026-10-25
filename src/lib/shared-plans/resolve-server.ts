// Server-only: wires resolvePlanShows to the real catalog. data-core and
// diary-show read data files with fs; never import this from a client component.
import { getShowById } from '@/lib/data-core';
import { getDiaryShowById, getShowStubsByIds } from '@/lib/diary-show';
import { resolvePlanShows, type PlanShow } from './resolve';

export function resolvePlanShowsFromCatalog(ids: readonly string[]): Promise<Map<string, PlanShow>> {
  return resolvePlanShows(ids, {
    getShow: getShowById,
    getDiaryShow: getDiaryShowById,
    getStubs: missing => getShowStubsByIds(missing),
  });
}
