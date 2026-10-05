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

/** Grid size per group: 18 posters = 6 rows of 3 on a phone, 3 rows of 6 on desktop. */
export const WELCOME_LONG_RUNNER_COUNT = 8;
export const WELCOME_RECENT_COUNT = 7;
export const WELCOME_CLOSED_COUNT = 3;
/** A show running at least this long counts as a long-runner. */
export const WELCOME_LONG_RUNNER_YEARS = 3;
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
 * The Broadway shows a new member is most likely to have seen: the longest
 * running ones still open (oldest first: Chicago, The Lion King, Wicked...),
 * then the recent hits by critic review count, then the biggest recent
 * closings. One poster per title, so a revival never shows twice.
 */
export function pickWelcomeShows(
  shows: WelcomeShowSource[],
  today: string,
  opts: { longRunnerCount?: number; recentCount?: number; closedCount?: number } = {},
): WelcomeShow[] {
  const longRunnerCount = opts.longRunnerCount ?? WELCOME_LONG_RUNNER_COUNT;
  const recentCount = opts.recentCount ?? WELCOME_RECENT_COUNT;
  const closedCount = opts.closedCount ?? WELCOME_CLOSED_COUNT;
  const longRunnerSince = addDays(today, -Math.round(WELCOME_LONG_RUNNER_YEARS * 365.25));
  const closedSince = addDays(today, -WELCOME_CLOSED_WINDOW_DAYS);
  const eligible = shows.filter(s =>
    s.category === 'broadway' && !!(s.images?.poster || s.images?.thumbnail));
  const open = eligible.filter(s => s.status === 'open' && !!s.openingDate && s.openingDate <= today);

  const longRunners = open
    .filter(s => (s.openingDate as string) <= longRunnerSince && s.reviewCount >= WELCOME_MIN_REVIEWS_LONG_RUNNER)
    .sort(byOpeningThenTitle);
  const recent = open
    .filter(s => (s.openingDate as string) > longRunnerSince && s.reviewCount >= WELCOME_MIN_REVIEWS_RECENT)
    .sort(byReviewsThenTitle);
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
    ...take(longRunners, longRunnerCount),
    ...take(recent, recentCount),
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
 * Where "Done" takes them: My Shows when they now have something there to
 * look at, otherwise back to the page they were on.
 */
export function welcomeFinishDestination(input: { showsAdded: number; imported: number }): 'my-shows' | 'stay' {
  return input.showsAdded + input.imported > 0 ? 'my-shows' : 'stay';
}
