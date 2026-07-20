/**
 * Shared types + source adapters for the My Shows import flow (ImportShows.tsx).
 *
 * Each import source is an adapter that turns its raw input (a Mezzanine
 * export file, a Show Score profile URL) into RawImportEntry[]; the modal owns
 * everything downstream — show matching, the preview checklist, and the
 * Supabase inserts. Adding import source #3 = one new adapter here plus an
 * input step in the modal; the pipeline doesn't change.
 */
import { getSupabaseClient } from '@/lib/supabase';
import { sanitizeRating } from '@/lib/rating';

/** One seen-show / want-to-see entry, normalized across sources. */
export interface RawImportEntry {
  title: string;
  venue: string | null;
  /** 0.5–5 half-star; null = source had no usable rating for this entry. */
  rating: number | null;
  /** Original source-scale score for preview display (Show Score 0–100). */
  sourceScore: number | null;
  date: string | null; // YYYY-MM-DD
  reviewText: string | null;
  kind: 'diary' | 'watchlist';
  listName?: string;
  /** True for diary entries rerouted to watchlist (unrated future viewings) —
   *  their auto-select rule differs from list-based watchlist entries. */
  fromDiary?: boolean;
  /** Mezzanine Show class objectId (entry.show.id in the export) — lets the
   *  unmatched-import self-heal loop look this show up directly on Mezzanine
   *  instead of falling back to a fuzzy title search. */
  mezzShowId?: string;
}

export interface ImportAcquireResult {
  entries: RawImportEntry[];
  /** Non-fatal caveats to surface in the preview ("12 reviews had no rating"). */
  notices: string[];
}

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
          merged.push({ id: p.id, title: s.title, slug: p.id, status: s.status || 'closed', venue, category: p.cat, dy: true } as unknown as T);
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

// ---------------------------------------------------------------------------
// Show Score
// ---------------------------------------------------------------------------

/** Mirror of the show-score-proxy edge function's response contract
 *  (supabase/functions/show-score-proxy/index.ts — single-channel: always
 *  HTTP 200 with ok:false for handled failures). */
interface ShowScoreProxyResponse {
  ok: boolean;
  error?: 'invalid_slug' | 'unauthorized' | 'rate_limited' | 'not_found' | 'upstream_blocked' | 'internal';
  displayName?: string | null;
  totalOnProfile?: number | null;
  reviews?: Array<{
    reviewId: string | null;
    title: string;
    venue: string | null;
    rating: number | null;
    sourceScore: number | null;
    reviewText: string | null;
    dateSeen: string | null;
  }>;
  unparsed?: number;
  truncated?: boolean;
  incomplete?: boolean;
}

export const SHOW_SCORE_ERROR_COPY: Record<string, string> = {
  invalid_slug: "That doesn't look like a Show Score profile link. Paste your profile URL, e.g. show-score.com/member/your-name.",
  unauthorized: 'Please sign in again and retry.',
  rate_limited: "You've hit the import limit for now — try again in an hour.",
  not_found: "We couldn't find that Show Score member. Check the profile link and try again.",
  upstream_blocked: 'Show Score is blocking our importer right now. Try again in a few hours.',
  internal: 'Something went wrong on our side. Try again in a few minutes.',
};

/** Extract a member slug from a pasted profile URL or bare slug. UX-level
 *  parsing only — the edge function independently validates the slug, which
 *  is the actual security boundary. */
export function extractMemberSlug(input: string): string | null {
  const s = String(input || '').trim();
  const fromUrl = s.match(/show-score\.com\/member\/([a-z0-9][a-z0-9-]{0,79})/i);
  if (fromUrl) return fromUrl[1].toLowerCase();
  if (/^[a-z0-9][a-z0-9-]{0,79}$/i.test(s)) return s.toLowerCase();
  return null;
}

/** Fetch + normalize a Show Score profile via the show-score-proxy function.
 *  Throws Error with user-ready copy on any handled failure. */
export async function acquireFromShowScore(profileInput: string): Promise<ImportAcquireResult> {
  const slug = extractMemberSlug(profileInput);
  if (!slug) throw new Error(SHOW_SCORE_ERROR_COPY.invalid_slug);

  const supabase = getSupabaseClient();
  if (!supabase) throw new Error(SHOW_SCORE_ERROR_COPY.unauthorized);

  const { data, error } = await supabase.functions.invoke<ShowScoreProxyResponse>('show-score-proxy', {
    body: { slug },
  });
  if (error || !data) throw new Error(SHOW_SCORE_ERROR_COPY.internal);
  if (!data.ok) throw new Error(SHOW_SCORE_ERROR_COPY[data.error || 'internal'] || SHOW_SCORE_ERROR_COPY.internal);

  // Rows with an unreadable score are excluded here — the `unparsed` notice
  // tells the user how many were skipped (never silently guess a rating).
  const entries: RawImportEntry[] = (data.reviews || [])
    .filter((r) => r.rating !== null)
    .map((r) => ({
      title: r.title,
      venue: r.venue,
      // The function already returns half-star ratings; sanitize anyway so a
      // proxy regression can never write an off-scale value.
      rating: sanitizeRating(r.rating as number) || null,
      sourceScore: r.sourceScore,
      date: r.dateSeen,
      reviewText: r.reviewText,
      kind: 'diary',
    }));

  const notices: string[] = [];
  if (data.unparsed) notices.push(`${data.unparsed} review(s) had no readable rating and were skipped.`);
  if (data.truncated) notices.push('This profile has more than 1,000 reviews — only the most recent 1,000 were fetched.');
  if (data.incomplete) notices.push(`Show Score stopped responding partway — only ${entries.length} review(s) were fetched. You can re-run the import later to pick up the rest.`);
  return { entries, notices };
}

// ---------------------------------------------------------------------------
// Mezzanine
// ---------------------------------------------------------------------------

interface MezzEntry {
  show: { name: string; id: string };
  rating: number | null;
  date: string | null;
  review: string | null;
  production?: { theater?: { name: string; location?: string } };
}

interface MezzExport {
  appVersion?: string;
  data: {
    diaryEntries: MezzEntry[];
    // `id` is optional here defensively — list-derived shows are the same
    // underlying Mezzanine Show objects as diaryEntries' `show.id`, but
    // unconfirmed against a real list export, so this must degrade to the
    // pre-existing title-only behavior (undefined) rather than assume shape.
    lists: { name: string; shows: { name: string; id?: string }[] }[];
  };
}

/** Parse a Mezzanine JSON export (Settings → Export Data → JSON). */
export async function acquireFromMezzanine(file: File): Promise<ImportAcquireResult> {
  const parsed: MezzExport = JSON.parse(await file.text());
  if (!parsed.data?.diaryEntries) {
    throw new Error('Invalid Mezzanine export — missing data.diaryEntries');
  }

  const entries: RawImportEntry[] = [];
  const today = new Date().toISOString().split('T')[0];

  for (const entry of parsed.data.diaryEntries) {
    const date = entry.date ? entry.date.split('T')[0] : null;
    const hasRating = !!(entry.rating && entry.rating > 0);
    // Unrated future entries are plans, not viewings → watchlist.
    const isFuture = date !== null && date > today;
    entries.push({
      title: entry.show.name,
      venue: entry.production?.theater?.name || null,
      // Mezzanine ratings are already 1–5 half-star; sanitize defensively.
      rating: hasRating ? sanitizeRating(entry.rating as number) || null : null,
      sourceScore: null,
      date,
      reviewText: entry.review || null,
      kind: !hasRating && isFuture ? 'watchlist' : 'diary',
      ...(!hasRating && isFuture ? { listName: 'Upcoming', fromDiary: true } : {}),
      ...(entry.show.id ? { mezzShowId: entry.show.id } : {}),
    });
  }

  for (const list of parsed.data.lists || []) {
    for (const show of list.shows) {
      entries.push({
        title: show.name,
        venue: null,
        rating: null,
        sourceScore: null,
        date: null,
        reviewText: null,
        kind: 'watchlist',
        listName: list.name,
        ...(show.id ? { mezzShowId: show.id } : {}),
      });
    }
  }

  return { entries, notices: [] };
}
