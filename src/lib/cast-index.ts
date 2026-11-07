import { getAllActorProfiles } from '@/lib/data-actors';
import type { CastIndexProfile } from '@/lib/cast-index-split';

export { CAST_DEFAULT_MIN_SCORED, splitCastIndex } from '@/lib/cast-index-split';
export type { CastIndexProfile } from '@/lib/cast-index-split';

export function getCastIndexProfiles(): CastIndexProfile[] {
  return getAllActorProfiles().map(p => ({
    name: p.name,
    slug: p.slug,
    showCount: p.showCount,
    scoredShowCount: p.scoredShowCount,
    avgScore: p.avgScore,
    openShowCount: p.openShowCount,
    roles: [],
    obcCount: p.shows.filter(s => (s.castType === 'obc' || s.wasObc) && !s.isRevival).length,
    headshot: p.headshot,
  }));
}
