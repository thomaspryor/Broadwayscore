// Which metro a reviewing outlet is local to (BRO-6517). An outlet's own
// `metro` in data/outlet-registry.json wins; otherwise its `region` maps
// through REGION_METRO. Slugs equal citySlug() of "<City>, <ST>" (tour-cities.ts)
// and the `city` field on regional shows (venue->metro table, BRO-6515).
// Not the venue table: this answers "is this critic local to the city".

export interface OutletMetroEntry {
  metro?: string | null;
  region?: string | null;
}

/** Registry `region` values that name one US metro. */
export const REGION_METRO: Record<string, string> = {
  chicago: 'chicago-il',
  'washington-dc': 'washington-dc',
  'los-angeles': 'los-angeles-ca',
};

export function outletMetro(entry: OutletMetroEntry | null | undefined): string | null {
  if (!entry) return null;
  if (entry.metro) return entry.metro;
  return (entry.region && REGION_METRO[entry.region]) || null;
}

export interface LocalCriticStat {
  count: number;
  average: number | null;
}

/** Reviews whose outlet is local to `metro`, and their plain average score. */
export function localCriticStat(
  reviews: Array<{ outletId: string; reviewScore: number }>,
  registry: Record<string, OutletMetroEntry>,
  metro: string,
): LocalCriticStat {
  // One vote per outlet (multi-critic outlets would otherwise reach the minimum alone).
  const byOutlet = new Map<string, { outletId: string; reviewScore: number }[]>();
  for (const r of reviews) {
    if (outletMetro(registry[r.outletId]) !== metro) continue;
    byOutlet.set(r.outletId, [...(byOutlet.get(r.outletId) ?? []), r]);
  }
  const local = Array.from(byOutlet.values()).map(rs => ({
    outletId: rs[0].outletId,
    reviewScore: rs.reduce((t, r) => t + r.reviewScore, 0) / rs.length,
  }));
  if (!local.length) return { count: 0, average: null };
  const sum = local.reduce((t, r) => t + r.reviewScore, 0);
  return { count: local.length, average: Math.round(sum / local.length) };
}

/** A "Chicago critics" line needs at least this many local reviews. */
export const LOCAL_CRITICS_MIN = 3;
