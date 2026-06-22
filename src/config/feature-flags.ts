// Feature flags for staggered launch
// Controlled by NEXT_PUBLIC_FEATURES env var (comma-separated list of enabled features)
// To enable a feature: add its name to the env var in Vercel project settings
// Example: NEXT_PUBLIC_FEATURES="discountTickets,criticPages,boxOffice"
// Empty string = all features hidden (launch state)
//
// ⚠️  DEMO_FEATURES require `window` — they MUST be checked inside 'use client'
// components, never in server components or page.tsx files. isDemo() returns false
// during SSR/static generation, so the flag silently evaluates to false and the
// feature is invisible. CI enforces this (lint-feature-flags in test.yml).

const enabledFeatures = new Set(
  (process.env.NEXT_PUBLIC_FEATURES || '').split(',').map(s => s.trim()).filter(Boolean)
);

// Features auto-enabled on demo.broadwayscorecard.com (runtime check).
// Uses getters so the check runs each time the flag is read (client-side).
// CI: lint-feature-flags checks these are never referenced in server components.
const DEMO_FEATURES = new Set(['userAccounts', 'showPageRedesign', 'showtimes']);

function isDemo(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.hostname === 'demo.broadwayscorecard.com';
}

/**
 * Detect whether the user is in an "opera context" — either visiting the
 * operascorecard.com domain OR currently on the /opera path (which is where
 * operascorecard.com lands after its 308 redirect).
 *
 * Why we check BOTH hostname AND pathname:
 *   - operascorecard.com → 308 → broadwayscorecard.com/opera. After the redirect
 *     the browser's hostname is broadwayscorecard.com, so a hostname-only check
 *     would never fire for users who entered via the opera domain.
 *   - Direct visitors to broadwayscorecard.com/opera also belong in the opera
 *     context — same page, same intent.
 *
 * Runtime-only (window-dependent). Returns false during SSR / static export so
 * server-rendered HTML defaults to the Broadway brand; components must call
 * this in a `useEffect` + `useState` pattern to avoid hydration mismatch.
 */
export function isOperaDomain(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  if (host === 'operascorecard.com' || host === 'www.operascorecard.com') return true;
  const path = window.location.pathname;
  return path === '/opera' || path.startsWith('/opera/');
}

function has(name: string): boolean {
  if (enabledFeatures.has(name)) return true;
  if (DEMO_FEATURES.has(name) && isDemo()) return true;
  return false;
}

export const featureFlags = {
  get discountTickets() { return true; }, // launched — flag retained for cleanup
  get criticPages() { return has('criticPages'); },
  get creativePages() { return has('creativePages'); },
  get castChanges() { return true; }, // launched — flag retained for cleanup
  get boxOffice() { return true; }, // launched — flag retained for cleanup
  get goldLists() { return has('goldLists'); },
  get commercial() { return has('commercial'); },
  get awards() { return true; }, // launched 2026-05-17 — flag retained for cleanup
  get tonyPredictions() { return has('tonyPredictions'); },
  /** Reveals Our Pick % column and Predicted Winner badge on the predictions page.
   *  Enable after the Tony Awards Center Reddit launch, for the follow-up predictions reveal. */
  get tonyPredictionsOurPick() { return has('tonyPredictionsOurPick'); },
  get castPages() { return has('castPages'); },
  get westEnd() { return has('westEnd'); },
  get offBroadway() { return has('offBroadway'); },
  /** Regional (non-NYC US) shows, e.g. pre-Broadway tryouts at A.R.T. Gates the
   *  detail page static params, OG, sitemap, and search index (see data-core
   *  regionalSlugAllowed + generate-search-shows.js). Enable via
   *  NEXT_PUBLIC_FEATURES=regional. */
  get regional() { return has('regional'); },
  get tonyPeople() { return has('tonyPeople'); },
  get sectionJumpLinks() { return has('sectionJumpLinks'); },
  get userAccounts() { return has('userAccounts'); },
  get showPageRedesign() { return has('showPageRedesign'); },
  get showtimes() { return true; }, // launched — flag retained for cleanup
  get theaterScorecard() { return true; }, // launched — flag retained for cleanup
  get fantasyLeague() { return has('fantasyLeague'); },
  get videoReviews() { return has('videoReviews'); },
  get homepageExplainer() { return true; }, // launched — flag retained for cleanup
  get awardScoreV2() { return true; }, // launched 2026-05-17 — flag retained for cleanup
  /** Show-page rank surfaces: hero rank line ("Ranks #3 of 28 open Broadway · ...")
   *  and bottom "Where it ranks" card. Off by default — flip on per-market after
   *  smoke test. Enable via NEXT_PUBLIC_FEATURES=showRanks. */
  get showRanks() { return has('showRanks'); },
};
