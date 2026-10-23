import { getAllActorProfiles } from '@/lib/data-actors';

// /cast ships only the profiles the default view shows (scored >= 3) in its
// hydration payload: all ~20k profiles were 4.2MB of HTML, past Googlebot's 2MB
// fetch limit (BRO-5968). The rest load from /cast-index.json when a visitor
// picks "All" or searches.
export const CAST_DEFAULT_MIN_SCORED = 3;

export interface CastIndexProfile {
  name: string;
  slug: string;
  showCount: number;
  scoredShowCount: number;
  avgScore: number | null;
  openShowCount: number;
  roles: string[];
  obcCount: number;
  headshot: string | null | undefined;
}

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

export function splitCastIndex(all: CastIndexProfile[]) {
  const main = all.filter(p => (p.scoredShowCount ?? p.showCount) >= CAST_DEFAULT_MIN_SCORED);
  const rest = all.filter(p => (p.scoredShowCount ?? p.showCount) < CAST_DEFAULT_MIN_SCORED);
  return { main, rest };
}
