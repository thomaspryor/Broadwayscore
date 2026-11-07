/**
 * Signed-out ratings (BRO-6917, "save first, ask later" for ratings).
 *
 * A signed-out Save used to open the sign-in modal and keep the rating only as
 * a one-hour draft behind it; closing the modal and leaving the page lost it
 * (44 dismissed rating prompts in 30 days, PostHog). Now the rating is stored
 * on this device straight away, like bookmarks (local-watchlist.ts), and
 * LocalRatingsMigrator moves it into the account on the next sign-in.
 *
 * One entry per show (the latest rating wins). Pure helpers are exported for
 * tests (CLAUDE.md §15); the storage wrappers swallow storage errors (private
 * mode, blocked site data) and fall back to memory for the life of the page.
 */

export const RATINGS_KEY = 'bsc_local_ratings';
export const LOCAL_RATINGS_SYNC = 'local-ratings-sync';
/** Bound the list so a runaway loop can't fill storage. */
export const MAX_LOCAL_RATINGS = 100;

export interface LocalRating {
  showId: string;
  /** 0.5 to 5 in half steps. */
  rating: number;
  reviewText?: string;
  dateSeen?: string;
  timeSlot?: 'matinee' | 'evening' | 'custom';
  curtainTime?: string;
  seat?: string;
  savedAt: number;
}

export type LocalRatingInput = Omit<LocalRating, 'savedAt'>;

const TIME_SLOTS = new Set(['matinee', 'evening', 'custom']);

function isValidRating(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0.5 && n <= 5 && Math.round(n * 2) === n * 2;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** Parse whatever is in storage; anything malformed counts as empty. */
export function parseLocalRatings(raw: string | null): LocalRating[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: LocalRating[] = [];
    for (const e of parsed) {
      if (!e || typeof e !== 'object') continue;
      const r = e as Record<string, unknown>;
      const showId = str(r.showId);
      if (!showId || seen.has(showId) || !isValidRating(r.rating)) continue;
      seen.add(showId);
      const timeSlot = typeof r.timeSlot === 'string' && TIME_SLOTS.has(r.timeSlot)
        ? (r.timeSlot as LocalRating['timeSlot'])
        : undefined;
      out.push({
        showId,
        rating: r.rating,
        ...(str(r.reviewText) ? { reviewText: str(r.reviewText) } : {}),
        ...(str(r.dateSeen) ? { dateSeen: str(r.dateSeen) } : {}),
        ...(timeSlot ? { timeSlot } : {}),
        ...(str(r.curtainTime) ? { curtainTime: str(r.curtainTime) } : {}),
        ...(str(r.seat) ? { seat: str(r.seat) } : {}),
        savedAt: typeof r.savedAt === 'number' ? r.savedAt : 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Newest first; rating a show again replaces its earlier entry. Invalid ratings are ignored. */
export function upsertRating(list: LocalRating[], input: LocalRatingInput, now: number): LocalRating[] {
  if (!input.showId || !isValidRating(input.rating)) return list;
  const rest = list.filter(e => e.showId !== input.showId);
  return [{ ...input, savedAt: now }, ...rest].slice(0, MAX_LOCAL_RATINGS);
}

export function removeRatingEntry(list: LocalRating[], showId: string): LocalRating[] {
  return list.filter(e => e.showId !== showId);
}

/**
 * Ratings to copy into the account, oldest first. A local rating is skipped
 * only when the account already holds the same star rating for that show
 * (a retry after a lost response). A different rating is a new viewing
 * (the product supports several per show), so it is kept.
 */
export function ratingsToMigrate(
  local: LocalRating[],
  accountRatings: Iterable<{ showId: string; rating: number }>,
): LocalRating[] {
  const have = new Set<string>();
  for (const a of accountRatings) have.add(`${a.showId}|${a.rating}`);
  return [...local].reverse().filter(e => !have.has(`${e.showId}|${e.rating}`));
}

// ─── storage wrappers ────────────────────────────────────────────────────

let memoryList: LocalRating[] | null = null;

export function getLocalRatings(): LocalRating[] {
  // A failed write (full or blocked storage) leaves the newest list in memory; it wins over stale storage.
  if (memoryList !== null) return memoryList;
  try {
    return parseLocalRatings(localStorage.getItem(RATINGS_KEY));
  } catch {
    return [];
  }
}

function writeLocalRatings(list: LocalRating[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(RATINGS_KEY);
    else localStorage.setItem(RATINGS_KEY, JSON.stringify(list));
    memoryList = null;
  } catch {
    memoryList = list;
  }
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent(LOCAL_RATINGS_SYNC, { detail: list }));
  }
}

export function saveLocalRating(input: LocalRatingInput): LocalRating[] {
  const next = upsertRating(getLocalRatings(), input, Date.now());
  writeLocalRatings(next);
  return next;
}

export function removeLocalRating(showId: string): LocalRating[] {
  const next = removeRatingEntry(getLocalRatings(), showId);
  writeLocalRatings(next);
  return next;
}
