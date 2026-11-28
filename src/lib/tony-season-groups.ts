/**
 * Group a season's shows the way the Tony show-level categories are shaped:
 * musical vs play, new vs revival.
 *
 * Important distinction the owner already drew (2026-08-13): whether a show is
 * ELIGIBLE in a given Tony category is an Administration Committee ruling we do
 * not have and must not invent. Whether a show is a musical or a play, and
 * whether it is a revival, are facts we store in shows.json. This groups on the
 * facts only — the "eligibility not yet determined" disclaimer on the page still
 * covers the ruling.
 *
 * Generic over the show shape so the grouping logic can be unit-tested against
 * plain objects while the page passes ShowCardShow (CLAUDE.md rule 15 — the test
 * calls the real function, it does not re-implement it).
 */

export interface TonyShapeGroup<T> {
  /** Stable key for React and for tests */
  key: string;
  /** Section heading, e.g. "New Musicals" */
  title: string;
  shows: T[];
}

interface ShapeInput {
  type?: string | null;
  isRevival?: boolean | null;
}

/**
 * Order mirrors how the Tony show-level categories are presented on the rest of
 * the site: Best Musical, Best Play, Best Revival of a Musical, Best Revival of
 * a Play. Anything that is neither a musical nor a play (type 'special',
 * 'opera', or missing) lands in a trailing bucket rather than being dropped —
 * silently losing a show from a list titled "this season's Broadway shows" would
 * be worse than showing it under a vaguer heading.
 */
const GROUPS: Array<{ key: string; title: string; match: (s: ShapeInput) => boolean }> = [
  {
    key: 'new-musical',
    title: 'New Musicals',
    match: s => normalizeType(s.type) === 'musical' && s.isRevival !== true,
  },
  {
    key: 'new-play',
    title: 'New Plays',
    match: s => normalizeType(s.type) === 'play' && s.isRevival !== true,
  },
  {
    key: 'revival-musical',
    title: 'Musical Revivals',
    match: s => normalizeType(s.type) === 'musical' && s.isRevival === true,
  },
  {
    key: 'revival-play',
    title: 'Play Revivals',
    match: s => normalizeType(s.type) === 'play' && s.isRevival === true,
  },
];

const OTHER_GROUP = { key: 'other', title: 'Other Productions' };

function normalizeType(type?: string | null): string {
  return (type ?? '').trim().toLowerCase();
}

/**
 * Returns only non-empty groups, in Tony-category order. Input order is
 * preserved inside each group, so a caller that pre-sorted by opening date
 * keeps that sort within every section.
 */
export function groupShowsByTonyShape<T extends ShapeInput>(shows: T[]): Array<TonyShapeGroup<T>> {
  const buckets = new Map<string, T[]>();
  for (const show of shows) {
    const group = GROUPS.find(g => g.match(show));
    const key = group ? group.key : OTHER_GROUP.key;
    const existing = buckets.get(key);
    if (existing) existing.push(show);
    else buckets.set(key, [show]);
  }

  const ordered: Array<TonyShapeGroup<T>> = [];
  for (const g of [...GROUPS, OTHER_GROUP as { key: string; title: string }]) {
    const bucket = buckets.get(g.key);
    if (bucket && bucket.length > 0) {
      ordered.push({ key: g.key, title: g.title, shows: bucket });
    }
  }
  return ordered;
}
