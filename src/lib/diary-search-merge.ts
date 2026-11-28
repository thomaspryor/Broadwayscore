/**
 * Diary catalog merge + Add-show result ranking. Split out of show-import.ts
 * (BRO-7486): the site-wide search hook imports these two functions, and
 * pulling the whole import module (Show Score / Mezzanine / Theatr adapters)
 * into every page's first-load JS cost /show/[slug] about 7kB gzip.
 * show-import.ts re-exports them for the import flow.
 */
// ---------------------------------------------------------------------------
// Diary catalog merge (shared by ImportShows matching + the My Shows Add-show
// search dropdown — one merge implementation, two consumers).
// ---------------------------------------------------------------------------

/** Shape of an entry in public/data/diary-search.json (see generate-diary-data.js). */
export interface DiarySearchEntry {
  id: string;
  title: string;
  slug: string;
  status: string;
  dy?: boolean;
  venue?: string;
  city?: string;
  od?: string;
  category?: string;
  /** Multi-production groups (same title, distinct venues) — expanded into
   *  individual entries below rather than kept as one ambiguous row. */
  prods?: { id: string; v?: string; ci?: string; co?: string; cat?: string }[];
}

interface MergeableShow {
  id: string;
  title: string;
  venue?: string;
}

/**
 * Merge the diary-only catalog (regional/international/historical shows,
 * Mezzanine-sourced) into a base scored-shows catalog for search/import
 * matching. Expands multi-production groups into venue-distinct entries and
 * skips diary rows whose title+venue is already covered by the base catalog
 * (never shadow a scored show with an unscored diary duplicate).
 */
export function mergeDiaryShows<T extends MergeableShow>(baseShows: T[], diaryShows: DiarySearchEntry[]): T[] {
  const merged = [...baseShows];
  // Dedup key is frozen from the BASE (scored) catalog only — never shadow a
  // scored show with an unscored diary duplicate. Growing this map as diary
  // rows are accepted made later diary rows collide against EARLIER diary
  // rows instead of the base catalog, silently dropping ~35% of the diary
  // catalog from search (ship-check finding, 2026-07-14). Each diary entry
  // already has a unique Mezzanine id, so diary-vs-diary "duplicates" are
  // left in — collapsing them isn't this function's job.
  const baseVenues = new Map<string, Set<string>>();
  for (const s of baseShows) {
    const key = s.title.toLowerCase();
    if (!baseVenues.has(key)) baseVenues.set(key, new Set());
    if (s.venue) baseVenues.get(key)!.add(s.venue.toLowerCase());
  }
  for (const s of diaryShows) {
    const titleLower = s.title.toLowerCase();
    const baseSet = baseVenues.get(titleLower);
    if (s.prods) {
      for (const p of s.prods) {
        const venue = p.v || '';
        if (venue && !baseSet?.has(venue.toLowerCase())) {
          merged.push({ id: p.id, title: s.title, slug: p.id, status: s.status || 'closed', venue, category: p.cat, city: p.ci, dy: true } as unknown as T);
        }
      }
      continue;
    }
    // Skip if no venue to differentiate, and title already exists in the base catalog
    if (!s.venue && baseSet) continue;
    // Skip if same venue already covered by a scored base-catalog show
    if (s.venue && baseSet?.has(s.venue.toLowerCase())) continue;
    merged.push(s as unknown as T);
  }
  return merged;
}

// NYC (off-broadway) and London (west-end) diary shows surface before the
// deep tail (us-regional/uk-regional/international/other) — owner direction
// 2026-07-14: "typing 'Cats' should never bury the Broadway revival under 40
// regional Cats productions."
const NEAR_MARKET_CATEGORIES = new Set(['off-broadway', 'west-end']);

interface RankableDiaryResult {
  dy?: boolean;
  category?: string;
  rc?: number;
  od?: string;
}

/**
 * Re-order Fuse search results for the My Shows Add-show dropdown: scored
 * (non-diary) matches always first, regardless of fuzzy-match score; diary-
 * only matches follow, tie-broken by market (NYC/London first) → popularity
 * (audienceRatingsCount desc) → recency (openingDate desc). Header/site
 * search never calls this — only the diary-merged Add-show index does.
 */
export function tierSearchResults<T>(results: T[], limit: number): T[] {
  const scored: T[] = [];
  const diaryOnly: T[] = [];
  for (const r of results) ((r as RankableDiaryResult).dy ? diaryOnly : scored).push(r);
  diaryOnly.sort((a, b) => {
    const ra = a as RankableDiaryResult;
    const rb = b as RankableDiaryResult;
    const marketDiff = Number(!NEAR_MARKET_CATEGORIES.has(ra.category || '')) - Number(!NEAR_MARKET_CATEGORIES.has(rb.category || ''));
    if (marketDiff !== 0) return marketDiff;
    const popDiff = (rb.rc || 0) - (ra.rc || 0);
    if (popDiff !== 0) return popDiff;
    return (rb.od || '').localeCompare(ra.od || '');
  });
  return [...scored, ...diaryOnly].slice(0, limit);
}
