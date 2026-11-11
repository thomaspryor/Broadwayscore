/**
 * Web sign-up onboarding decisions (BRO-6917, Option A, Parts 4 and 5).
 *
 * Who gets the optional setup after signing up, how it is laid out, how its
 * steps move, which posters the Want grid offers, and when Google One Tap may
 * show. Pure functions plus a tiny injectable store: no DOM, no Supabase and
 * no imports, so tests/unit/web-signup-onboarding.test.mjs imports this file
 * directly under plain `node --test`.
 *
 * The rule (owner decision 2026-11-03): only someone who pressed a Sign in
 * button (header, menu, the My Shows sign-in card) is offered the Seen + Want
 * setup. Everyone who signed up partway through something (a rating, a
 * bookmark, a nudge, a gated page, One Tap) goes straight back to what they
 * were doing; their welcome is spent quietly so it never turns up later.
 *
 * Mounted by src/components/onboarding/WelcomeGate.tsx; the sheet is
 * src/components/onboarding/WelcomeSheet.tsx; One Tap is
 * src/components/auth/GoogleOneTap.tsx.
 */

// ─── Who is offered the setup ───────────────────────────────────────────

/**
 * Sign-in sources (the `source` passed to showSignIn / signIn) that come from
 * a plain Sign in button with nothing else in progress.
 */
export const QUIZ_SOURCES: readonly string[] = ['header', 'menu', 'my_shows'];

export const SIGNUP_SOURCE_KEY = 'bsc_signup_source';
/** A sign-in that started longer ago than this no longer names its source. */
export const SIGNUP_SOURCE_TTL_MS = 30 * 60 * 1000;

export function isQuizSource(source: string | null | undefined): boolean {
  return !!source && QUIZ_SOURCES.includes(source);
}

/** The slice of Storage this module uses; tests pass a plain object. */
export interface SignupStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStore(): SignupStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

interface StoredSource {
  source: string;
  ts: number;
  /** Set once the sign-in finishes, so another account on this device never inherits it. */
  userId?: string;
}

function readStored(store: SignupStore): StoredSource | null {
  try {
    const raw = store.getItem(SIGNUP_SOURCE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredSource>;
    if (typeof v?.source !== 'string' || typeof v.ts !== 'number' || !Number.isFinite(v.ts)) return null;
    return { source: v.source, ts: v.ts, ...(typeof v.userId === 'string' ? { userId: v.userId } : {}) };
  } catch {
    return null;
  }
}

/**
 * Called whenever a sign-in starts (Google redirects the page, so the source
 * must survive in localStorage). Each start replaces the previous one.
 */
export function recordSignUpSource(source: string, now: number = Date.now(), store: SignupStore | null = defaultStore()): void {
  if (!store || !source) return;
  try {
    store.setItem(SIGNUP_SOURCE_KEY, JSON.stringify({ source, ts: now }));
  } catch {
    // private mode: no setup is offered, which is the quiet default
  }
}

/**
 * Where this signed-in account's sign-in started, or null when unknown.
 * The first read after sign-in ties a fresh marker to the account, so the
 * answer holds on later pages (the setup may wait until they leave the page
 * they landed on). A marker tied to another account, or too old to have been
 * this sign-in, counts as unknown.
 */
export function signUpSourceFor(userId: string, now: number = Date.now(), store: SignupStore | null = defaultStore()): string | null {
  if (!store || !userId) return null;
  const v = readStored(store);
  if (!v) return null;
  if (v.userId !== undefined) return v.userId === userId ? v.source : null;
  if (!(now - v.ts >= -60_000 && now - v.ts <= SIGNUP_SOURCE_TTL_MS)) return null;
  try {
    store.setItem(SIGNUP_SOURCE_KEY, JSON.stringify({ ...v, userId }));
  } catch {
    // ignore: the answer below still holds for this page
  }
  return v.source;
}

export function clearSignUpSource(store: SignupStore | null = defaultStore()): void {
  try {
    store?.removeItem(SIGNUP_SOURCE_KEY);
  } catch {
    // ignore
  }
}

export type SignupOnboarding = 'quiz' | 'quiet' | 'none';

/**
 * What a signed-in account gets. 'none': not a new account that is still
 * owed a welcome (shouldOfferWelcome said no). 'quiz': offer the Seen + Want
 * setup. 'quiet': spend the welcome without showing anything. A Sign in
 * button wins over a mid-task mark: the menu's Sign in passes the bookmark
 * context when there are local saves, but the person still pressed Sign in.
 */
export function signupOnboardingFor(input: { owedWelcome: boolean; source: string | null }): SignupOnboarding {
  if (!input.owedWelcome) return 'none';
  return isQuizSource(input.source) ? 'quiz' : 'quiet';
}

// ─── How it is laid out ─────────────────────────────────────────────────

/** Tailwind `lg`: from here up the setup is a side panel beside the page. */
export const QUIZ_SIDE_PANEL_MIN_WIDTH = 1024;

export type QuizLayout = 'side-panel' | 'full-screen';

/** Desktop gets a side panel; phones and small tablets get the whole screen. */
export function quizLayoutFor(viewportWidth: number | null | undefined): QuizLayout {
  return typeof viewportWidth === 'number' && viewportWidth >= QUIZ_SIDE_PANEL_MIN_WIDTH ? 'side-panel' : 'full-screen';
}

// ─── How the steps move ─────────────────────────────────────────────────

/** Seen (with stars), then Want, then a short done screen. No import step. */
export const QUIZ_STEPS = ['shows', 'want', 'done'] as const;
export type QuizStep = typeof QUIZ_STEPS[number];

export type QuizAction = 'continue' | 'skip' | 'close';

/**
 * Next screen, or 'closed'. Continue and Skip both move on one step (Skip
 * only writes nothing); Close leaves from anywhere. Nothing follows done.
 */
export function nextQuizStep(step: QuizStep, action: QuizAction): QuizStep | 'closed' {
  if (action === 'close' || step === 'done') return 'closed';
  return QUIZ_STEPS[QUIZ_STEPS.indexOf(step) + 1];
}

export const QUIZ_STEP_COUNT = QUIZ_STEPS.length;

export function quizStepNumber(step: QuizStep): number {
  return QUIZ_STEPS.indexOf(step) + 1;
}

/**
 * Shows the Want grid offers, minus anything already placed: seen (a review,
 * a seen_unrated row or a Seen pick just made) or already on the watchlist.
 */
export function wantCandidates<T extends { id: string }>(
  shows: T[],
  exclude: { seen: Iterable<string>; watchlist: Iterable<string> },
): T[] {
  const out = new Set<string>([...Array.from(exclude.seen), ...Array.from(exclude.watchlist)]);
  return shows.filter(s => !out.has(s.id));
}

/** The done screen's line. */
export function quizDoneMessage(input: { seenAdded: number; unratedAdded: number; wantAdded: number }): string {
  const seen = Math.max(0, input.seenAdded);
  const want = Math.max(0, input.wantAdded);
  const unrated = Math.min(Math.max(0, input.unratedAdded), seen);
  if (seen + want === 0) return 'Rate a show from its page any time, and it lands in Seen.';
  const parts = [
    seen > 0 ? `${seen} ${seen === 1 ? 'show' : 'shows'} in Seen` : null,
    want > 0 ? `${want} in Want to See` : null,
  ].filter(Boolean).join(' and ');
  if (unrated === 0) return `${parts}.`;
  const who = unrated === 1 ? 'The one without stars waits' : `The ${unrated} without stars wait`;
  return `${parts}. ${who} under To Be Rated, where you can add the date and stars.`;
}

// ─── Which posters the Want grid offers ─────────────────────────────────

export interface WantShowSource {
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

export interface WantShow {
  id: string;
  title: string;
  slug: string;
  image: string;
  closingDate: string | null;
}

export const WANT_COUNT = 18;

/**
 * Shows someone could still book: open (not closing before today) or in
 * previews, with a poster. Most-reviewed open shows first, then previews by
 * opening date. One poster per title.
 */
export function pickWantShows(
  shows: WantShowSource[],
  today: string,
  opts: { category?: string; count?: number } = {},
): WantShow[] {
  const category = opts.category ?? 'broadway';
  const count = opts.count ?? WANT_COUNT;
  const bookable = shows.filter(s => s.category === category
    && !!(s.images?.poster || s.images?.thumbnail)
    && (s.status === 'open' || s.status === 'previews')
    && !(s.closingDate && s.closingDate < today));
  const open = bookable.filter(s => s.status === 'open')
    .sort((a, b) => b.reviewCount - a.reviewCount || a.title.localeCompare(b.title));
  const previews = bookable.filter(s => s.status === 'previews')
    .sort((a, b) => (a.openingDate || '9999').localeCompare(b.openingDate || '9999') || a.title.localeCompare(b.title));
  const seen = new Set<string>();
  const out: WantShow[] = [];
  for (const s of [...open, ...previews]) {
    if (out.length >= count) break;
    const key = s.title.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: s.id,
      title: s.title,
      slug: s.slug,
      image: (s.images?.poster || s.images?.thumbnail) as string,
      closingDate: s.closingDate ?? null,
    });
  }
  return out;
}

// ─── Google One Tap (Part 5) ────────────────────────────────────────────

/** One Tap is a desktop corner card; phones keep the normal sign-in. */
export const ONE_TAP_MIN_WIDTH = 1024;

/** Analytics and sign-up source for a One Tap sign-in. Not a quiz source. */
export const ONE_TAP_SOURCE = 'one_tap';

/**
 * Whether to ask Google for the One Tap card. Dormant unless a client id is
 * configured; never for a signed-in visitor, on the sign-in screens, on a
 * phone or touch-only device, or while auth is still loading.
 */
export function shouldShowOneTap(input: {
  clientId: string | null | undefined;
  signedIn: boolean;
  authLoading: boolean;
  pathname: string | null | undefined;
  viewportWidth: number;
  finePointer: boolean;
}): boolean {
  if (!input.clientId || !input.clientId.trim()) return false;
  if (input.signedIn || input.authLoading) return false;
  if (input.pathname && input.pathname.startsWith('/auth')) return false;
  return input.viewportWidth >= ONE_TAP_MIN_WIDTH && input.finePointer;
}
