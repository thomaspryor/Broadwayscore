// Pure half of cast-index.ts: no data imports, so unit tests can load it on a
// checkout without the gitignored data/cast-manifest.json (BRO-6032).

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

export function splitCastIndex(all: CastIndexProfile[]) {
  const main = all.filter(p => (p.scoredShowCount ?? p.showCount) >= CAST_DEFAULT_MIN_SCORED);
  const rest = all.filter(p => (p.scoredShowCount ?? p.showCount) < CAST_DEFAULT_MIN_SCORED);
  return { main, rest };
}
