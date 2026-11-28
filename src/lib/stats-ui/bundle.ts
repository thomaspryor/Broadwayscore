/**
 * computeStatsBundle — every number on the web Stats view, from pure inputs.
 *
 * Web port of the iOS app's hooks/useStatsData.ts (BRO-6170 prototype). The
 * maths is the shared engine (@/lib/stats) plus the ported app helpers in this
 * directory; components only render what this returns.
 *
 * Inputs on web:
 *  - diary rows: the My Shows reviews (same rows the Diary tab lists)
 *  - showMap: /data/show-lookup.json (venue, type, runtime, poster)
 *  - catalog: /data/stats-shows.json (critic score + review count, audience
 *    grade, status), a slim projection of the iOS app's mobile-shows.json
 *  - canon: /data/stats-canon.json; statsReviews: /data/stats-reviews.json
 *  - houses: theater-houses.json (slim projection of data/theater-metadata.json)
 */

import {
  alignCritics,
  buildHouseIndex,
  canonProgress,
  computeDiaryStats,
  ratingsHistogram,
  seasonWindows,
  theaterCompletion,
  type AlignCriticsResult,
  type DiaryRow,
  type HouseIndex,
  type ShowMetaIndex,
  type StatsCanon,
  type StatsReviews,
} from '@/lib/stats';
import type { ShowLookup, UserReview } from '@/types/user';
import houses from './theater-houses.json';
import { buildScopes, filterRows, type ScopeOption, ALL_TIME } from './scope';
import {
  audienceVsYou,
  goldCoverage,
  youVsCritics,
  type CriticShowIndex,
  type CriticShowMeta,
} from './critics';

/** Below this the whole view shows the ghost state. */
export const MIN_ENTRIES_FOR_STATS = 3;
export const MIN_RATED_FOR_HISTOGRAM = 5;
export const MIN_DATED_FOR_YEAR_CHART = 3;

export const THEATER_HOUSES = houses as Record<string, { capacity?: number; yearBuilt?: number; formerNames?: string[] }>;
export const HOUSE_NAMES = Object.keys(THEATER_HOUSES);

/** The ONE house index (with former names) for reducers and UI lookups alike. */
export const HOUSE_INDEX: HouseIndex = buildHouseIndex(
  HOUSE_NAMES,
  {},
  Object.fromEntries(
    Object.entries(THEATER_HOUSES)
      .filter(([, meta]) => meta.formerNames?.length)
      .map(([name, meta]) => [name, meta.formerNames as string[]]),
  ),
);

export const EMPTY_CANON: StatsCanon = { ceremonies: [], bestMusical: [], bestPlay: [] };

/** One catalog show, the union of show-lookup and stats-shows facts. */
export interface StatsShow {
  id: string;
  title: string;
  slug: string;
  venue: string;
  type: string | null;
  runtime: string | number | null;
  category: string;
  status: string;
  compositeScore: number | null;
  criticReviewCount: number | null;
  audienceGrade: string | null;
  posterUrl: string | null;
  diaryOnly: boolean;
  /** Catalog row carried its own display fields (decodeStatsShows only). */
  hasMeta?: boolean;
}

/**
 * Decode /data/stats-shows.json (scripts/lib/stats-shows.js): the slim web
 * catalog projected from the app feed. `shows` rows carry the numbers
 * ([score, reviewCount, grade, status?], trailing nulls trimmed, status
 * omitted when closed); `meta` adds display fields only for shows the My
 * Shows lookup leaves out. Tolerates any malformed input by returning [].
 */
/**
 * decodeStatsShows that refuses an empty catalog. prebuild writes an empty
 * stats-shows.json when mobile-shows.json is unreadable; without this the
 * critics/gold/audience modules would render as if the user had no matches
 * instead of showing a load error (ship-check, BRO-6170).
 */
export function decodeStatsShowsStrict(raw: unknown): StatsShow[] {
  const rows = decodeStatsShows(raw);
  if (rows.length === 0) throw new Error('stats-shows.json is empty');
  return rows;
}

export function decodeStatsShows(raw: unknown): StatsShow[] {
  const d = raw as { shows?: unknown; meta?: unknown } | null;
  const rows = d && typeof d.shows === 'object' && d.shows ? (d.shows as Record<string, unknown>) : {};
  const meta = d && typeof d.meta === 'object' && d.meta ? (d.meta as Record<string, unknown>) : {};
  const out: StatsShow[] = [];
  for (const [id, value] of Object.entries(rows)) {
    if (!Array.isArray(value)) continue;
    const [score, reviewCount, grade, status] = value as unknown[];
    const m = Array.isArray(meta[id]) ? (meta[id] as unknown[]) : null;
    out.push({
      id,
      title: typeof m?.[0] === 'string' ? m[0] : id,
      slug: typeof m?.[1] === 'string' ? m[1] : id,
      venue: typeof m?.[2] === 'string' ? m[2] : '',
      type: m ? (m[4] === 1 ? 'musical' : 'play') : null,
      runtime: null,
      category: typeof m?.[3] === 'string' ? m[3] : 'broadway',
      status: typeof status === 'string' && status ? status : 'closed',
      compositeScore: typeof score === 'number' ? score : null,
      criticReviewCount: typeof reviewCount === 'number' ? reviewCount : null,
      audienceGrade: typeof grade === 'string' ? grade : null,
      posterUrl: typeof m?.[5] === 'string' ? m[5] : null,
      diaryOnly: false,
      hasMeta: !!m,
    });
  }
  return out;
}

/**
 * Merge show-lookup (authoritative for display AND status: it is rebuilt with
 * today's date on every build) over the catalog's numbers. Catalog rows with
 * no lookup entry and no meta are number-only (no title) and are dropped, so
 * a list never renders a raw show id.
 */
export function mergeShows(showMap: Record<string, ShowLookup>, catalog: StatsShow[]): Record<string, StatsShow> {
  const out: Record<string, StatsShow> = {};
  for (const c of catalog) if (c.hasMeta) out[c.id] = c;
  const byId = new Map(catalog.map((c) => [c.id, c]));
  for (const [id, s] of Object.entries(showMap)) {
    const c = byId.get(id);
    out[id] = {
      id,
      title: s.title || c?.title || id,
      slug: s.slug || c?.slug || id,
      venue: s.venue || c?.venue || '',
      type: s.type ?? c?.type ?? null,
      runtime: s.runtimeMin ?? c?.runtime ?? null,
      category: s.category || c?.category || 'broadway',
      status: s.status || c?.status || 'closed',
      compositeScore: c?.compositeScore ?? s.compositeScore ?? null,
      criticReviewCount: c?.criticReviewCount ?? null,
      audienceGrade: c?.audienceGrade ?? null,
      posterUrl: s.posterUrl || c?.posterUrl || null,
      diaryOnly: !!s.diaryOnly,
    };
  }
  return out;
}

function toCriticMeta(s: StatsShow): CriticShowMeta {
  return {
    id: s.id,
    title: s.title,
    slug: s.slug,
    compositeScore: s.compositeScore,
    criticReviewCount: s.criticReviewCount,
    category: s.category,
    status: s.status,
    poster: s.posterUrl,
    venue: s.venue,
    audienceGrade: s.audienceGrade,
  };
}

export function toDiaryRows(reviews: UserReview[]): DiaryRow[] {
  return reviews.map((r) => ({ show_id: r.show_id, rating: r.rating, date_seen: r.date_seen }));
}

/** NYC market for the Gold to-see list (the web My Shows has no market pick). */
const GOLD_CATEGORIES = new Set(['broadway', 'off-broadway']);

export interface StatsBundleInput {
  reviews: UserReview[];
  shows: Record<string, StatsShow>;
  canon: StatsCanon;
  statsReviews: StatsReviews | null;
  scope: ScopeOption | null;
  today: string;
}

export function computeStatsBundle({ reviews, shows, canon, statsReviews, scope, today }: StatsBundleInput) {
  const showMeta: ShowMetaIndex = {};
  const criticIndex: CriticShowIndex = {};
  for (const s of Object.values(shows)) {
    showMeta[s.id] = { type: s.type, runtime: s.runtime, venue: s.venue, category: s.category, title: s.title };
    criticIndex[s.id] = toCriticMeta(s);
  }

  const allRows = toDiaryRows(reviews);
  const scopes = buildScopes(allRows, canon, { today });
  const active = scope ?? ALL_TIME;
  const reviewsInScope = filterRows(reviews, active);
  const rows = toDiaryRows(reviewsInScope);

  const diary = computeDiaryStats(rows, showMeta, { houseIndex: HOUSE_INDEX, today });
  // Lifetime modules: theaters, canon, gold, audience, Aisle Mates. Under a
  // dated scope their captions say "all time" (iOS build-61 lesson).
  const theaters = theaterCompletion(allRows, showMeta, THEATER_HOUSES, { houseIndex: HOUSE_INDEX });
  const windows = seasonWindows(canon, { today });
  const canonStats = canonProgress(allRows, canon, { windows });
  const histogram = ratingsHistogram(rows);
  const critics = youVsCritics(rows, criticIndex);
  const audience = audienceVsYou(allRows, criticIndex);
  const distinctShows = new Set(rows.map((r) => r.show_id)).size;
  const openShows = Object.values(shows)
    .filter((s) => (s.status === 'open' || s.status === 'previews') && GOLD_CATEGORIES.has(s.category))
    .map(toCriticMeta);
  const gold = goldCoverage(allRows, openShows);
  const aisleMates: AlignCriticsResult | null = statsReviews ? alignCritics(allRows, statsReviews) : null;

  return {
    allRows,
    rows,
    reviewsInScope,
    showMeta,
    scopes,
    scope: active,
    diary,
    theaters,
    canonStats,
    histogram,
    critics,
    audience,
    gold,
    aisleMates,
    distinctShows,
    /** >25% of entries used the type-default runtime. */
    hoursEstimated: diary.runtimeFallbackShare > 0.25,
  };
}

export type StatsBundle = ReturnType<typeof computeStatsBundle>;
