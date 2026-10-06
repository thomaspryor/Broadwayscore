/**
 * Welcome step after a brand-new account's first sign-in (BRO-4619).
 *
 * Pure decisions only (no DOM, no Supabase) so tests/unit/welcome-onboarding.test.ts
 * can require them. The sheet is src/components/onboarding/WelcomeSheet.tsx,
 * mounted by WelcomeGate.tsx; the poster list is served by
 * src/app/welcome-shows.json/route.ts.
 *
 * Never twice: the server column profiles.onboarding_seen_at (NULL = not yet)
 * is claimed atomically by claim_onboarding() before the sheet opens
 * (supabase/migrations/20261005_profile_onboarding.sql). localStorage is only
 * a fast path that saves the claim call on later page loads.
 */

/** Only accounts this young get the welcome; older ones (e.g. made on iOS) never do. */
export const WELCOME_ACCOUNT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A device clock a little behind the server still counts a just-made account as new. */
export const WELCOME_CLOCK_SKEW_MS = 2 * 60 * 1000;

export const WELCOME_STEPS = ['shows', 'import', 'done'] as const;
export type WelcomeStep = typeof WELCOME_STEPS[number];

export function welcomeSeenKey(userId: string): string {
  return `bsc_welcome_seen:${userId}`;
}

export interface WelcomeProfileState {
  /** undefined = the column is not in this database yet: treat as "do not show". */
  onboarding_seen_at?: string | null;
  created_at?: string | null;
}

/**
 * Whether to try claiming the welcome for this account. A true answer still
 * needs claim_onboarding() to return true before the sheet opens.
 */
export function shouldOfferWelcome(input: {
  profile: WelcomeProfileState | null;
  now: number;
  locallySeen: boolean;
}): boolean {
  const { profile, now, locallySeen } = input;
  if (!profile || locallySeen) return false;
  // Strictly null: undefined means the migration has not been applied.
  if (profile.onboarding_seen_at !== null) return false;
  const created = profile.created_at ? Date.parse(profile.created_at) : NaN;
  if (!Number.isFinite(created)) return false;
  const age = now - created;
  return age >= -WELCOME_CLOCK_SKEW_MS && age <= WELCOME_ACCOUNT_MAX_AGE_MS;
}

export function nextWelcomeStep(step: WelcomeStep): WelcomeStep {
  const i = WELCOME_STEPS.indexOf(step);
  return WELCOME_STEPS[Math.min(i + 1, WELCOME_STEPS.length - 1)];
}

// ─── Which posters to show ──────────────────────────────────────────────

export interface WelcomeShowSource {
  id: string;
  title: string;
  slug: string;
  status: string;
  category?: string;
  openingDate?: string | null;
  closingDate?: string | null;
  images?: { poster?: string; thumbnail?: string };
  reviewCount: number;
}

export interface WelcomeShow {
  id: string;
  title: string;
  slug: string;
  image: string;
  /** YYYY-MM-DD for a closed show, else null. Caps the date a "seen" pick gets. */
  closingDate: string | null;
}

/** Grid size: 18 posters = 6 rows of 3 on a phone, 3 rows of 6 on desktop. */
export const WELCOME_OPEN_COUNT = 15;
export const WELCOME_CLOSED_COUNT = 3;
/** The markets the welcome grid has a list for. Everything else uses Broadway's. */
export const WELCOME_MARKETS = ['broadway', 'west-end'] as const;
export type WelcomeMarket = typeof WELCOME_MARKETS[number];
/** A show running at least this long counts as a long-runner. */
export const WELCOME_LONG_RUNNER_YEARS = 3;
/**
 * A show must have been open this long to make the grid: a show that opened
 * last month has a big review count but almost no audience yet.
 */
export const WELCOME_MIN_RUN_DAYS = 180;
/**
 * Floors that keep stub rows out. Long-runners get a low one: Chicago and
 * The Lion King opened before most of our critic coverage, yet they are the
 * shows the most people have seen.
 */
export const WELCOME_MIN_REVIEWS_LONG_RUNNER = 5;
export const WELCOME_MIN_REVIEWS_RECENT = 20;
export const WELCOME_MIN_REVIEWS_CLOSED = 30;
/** "Recent" closings: within this many days of today. */
export const WELCOME_CLOSED_WINDOW_DAYS = 730;

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const byReviewsThenTitle = (a: WelcomeShowSource, b: WelcomeShowSource) =>
  b.reviewCount - a.reviewCount || a.title.localeCompare(b.title);
const byOpeningThenTitle = (a: WelcomeShowSource, b: WelcomeShowSource) =>
  (a.openingDate || '').localeCompare(b.openingDate || '') || a.title.localeCompare(b.title);

/**
 * The shows a new member of one market is most likely to have seen: the
 * open shows that have run longest (oldest first: Chicago, The Lion King,
 * Wicked... and on to the recent hits that have run at least six months),
 * then the biggest recent closings. Running time stands in for audience
 * size, which we don't have. One poster per title, so a revival never shows
 * twice.
 */
export function pickWelcomeShows(
  shows: WelcomeShowSource[],
  today: string,
  opts: { openCount?: number; closedCount?: number; category?: WelcomeMarket } = {},
): WelcomeShow[] {
  const openCount = opts.openCount ?? WELCOME_OPEN_COUNT;
  const closedCount = opts.closedCount ?? WELCOME_CLOSED_COUNT;
  const category = opts.category ?? 'broadway';
  const longRunnerSince = addDays(today, -Math.round(WELCOME_LONG_RUNNER_YEARS * 365.25));
  const runSince = addDays(today, -WELCOME_MIN_RUN_DAYS);
  const closedSince = addDays(today, -WELCOME_CLOSED_WINDOW_DAYS);
  const eligible = shows.filter(s =>
    s.category === category && !!(s.images?.poster || s.images?.thumbnail));

  const open = eligible
    .filter(s => s.status === 'open' && !!s.openingDate && s.openingDate <= runSince
      && s.reviewCount >= ((s.openingDate as string) <= longRunnerSince ? WELCOME_MIN_REVIEWS_LONG_RUNNER : WELCOME_MIN_REVIEWS_RECENT))
    .sort(byOpeningThenTitle);
  const closed = eligible
    .filter(s => s.status === 'closed' && s.reviewCount >= WELCOME_MIN_REVIEWS_CLOSED
      && !!s.closingDate && s.closingDate >= closedSince && s.closingDate <= today)
    .sort(byReviewsThenTitle);

  const seen = new Set<string>();
  const take = (list: WelcomeShowSource[], n: number) => {
    const out: WelcomeShowSource[] = [];
    for (const s of list) {
      if (out.length >= n) break;
      const k = titleKey(s.title);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
    return out;
  };

  return [
    ...take(open, openCount),
    ...take(closed, closedCount),
  ].map(s => ({
    id: s.id,
    title: s.title,
    slug: s.slug,
    image: (s.images?.poster || s.images?.thumbnail) as string,
    closingDate: s.status === 'closed' && s.closingDate ? s.closingDate : null,
  }));
}

// ─── Saving a pick ──────────────────────────────────────────────────────

export interface WelcomePick {
  showId: string;
  /** 0.5–5 half stars, or null when they only said "seen it". */
  rating: number | null;
}

export type WelcomeWrite =
  | { table: 'reviews'; row: { show_id: string; rating: number; date_seen: null } }
  | { table: 'seen_unrated'; row: { show_id: string } };

/**
 * A rated pick is a diary entry with no date. An unrated pick is "seen, date
 * not set": a seen_unrated row, which My Shows lists under To Be Rated as
 * "Date not set". No seen date is ever made up for either.
 */
export function welcomeWriteFor(pick: WelcomePick): WelcomeWrite {
  if (pick.rating !== null && pick.rating >= 0.5 && pick.rating <= 5) {
    return { table: 'reviews', row: { show_id: pick.showId, rating: pick.rating, date_seen: null } };
  }
  return { table: 'seen_unrated', row: { show_id: pick.showId } };
}

/**
 * Saving one pick, given where the show already is. Already seen (a review or
 * an earlier pick): nothing to write. On the watchlist only (e.g. a bookmark
 * saved during sign-in): it is written all the same, stars kept, and the
 * watchlist row goes, as rating a show anywhere else does (owner rule
 * 2026-07-12), so it is not listed as both seen and still to see.
 */
export function welcomeSaveStep(pick: WelcomePick, where: { seen: boolean; watchlisted: boolean }): { write: WelcomeWrite | null; clearWatchlist: boolean } {
  if (where.seen) return { write: null, clearWatchlist: false };
  return { write: welcomeWriteFor(pick), clearWatchlist: where.watchlisted };
}

/**
 * Where "Done" takes them: My Shows when they now have something there to
 * look at, otherwise back to the page they were on.
 */
export function welcomeFinishDestination(input: { showsAdded: number; imported: number }): 'my-shows' | 'stay' {
  return input.showsAdded + input.imported > 0 ? 'my-shows' : 'stay';
}

/**
 * The last step's summary. To Be Rated is mentioned only when some of the
 * picks went in without stars (seen_unrated); picks with stars are already
 * in the diary.
 */
export function welcomeDoneMessage(input: { showsAdded: number; imported: number; unratedAdded: number }): string {
  const { showsAdded, imported } = input;
  if (showsAdded + imported <= 0) return 'Rate a show from its page any time, and it lands in your diary.';
  const counts = [
    showsAdded > 0 ? `${showsAdded} ${showsAdded === 1 ? 'show' : 'shows'} added` : null,
    imported > 0 ? `${imported} imported` : null,
  ].filter(Boolean).join(', ');
  const unrated = Math.min(Math.max(input.unratedAdded, 0), Math.max(showsAdded, 0));
  // Imports can be watchlist rows as well as diary entries.
  if (unrated === 0) return `${counts} to ${imported > 0 ? 'My Shows' : 'your diary'}.`;
  // "They" would take in the imports too, so name the unrated picks then.
  const who = unrated === showsAdded && imported === 0
    ? (showsAdded === 1 ? 'It waits' : 'They wait')
    : (unrated === 1 ? 'The one without stars waits' : `The ${unrated} without stars wait`);
  return `${counts}. ${who} for you under To Be Rated, where you can add the date and stars.`;
}

// ─── Where and when it opens ────────────────────────────────────────────

/** London pages get the West End grid; every other market gets Broadway's. */
export function welcomeMarketFor(market: string): WelcomeMarket {
  return market === 'west-end' || market === 'off-west-end' ? 'west-end' : 'broadway';
}

/** Pages with nothing in particular to read, where the sheet may open at once. */
export const WELCOME_HUB_PATHS = ['/', '/my-shows', '/west-end', '/off-broadway', '/off-west-end'] as const;

/**
 * The sheet never covers the page someone signed up from (a show page they
 * came to read). It opens on a hub page, or once they move on to another page.
 * landingPath: the first non-sign-in page this visit, null until known.
 */
export function welcomeCanOpenOn(input: { pathname: string; landingPath: string | null }): boolean {
  const path = input.pathname.replace(/\/$/, '') || '/';
  if ((WELCOME_HUB_PATHS as readonly string[]).includes(path)) return true;
  if (input.landingPath === null) return false;
  return path !== (input.landingPath.replace(/\/$/, '') || '/');
}
