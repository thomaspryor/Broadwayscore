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
// userAccounts and showPageRedesign launched 2026-10-02 (BRO-4525) and left this set.
const DEMO_FEATURES = new Set(['showtimes']);

// Features the owner has held back from production. Both prod deploy paths
// (vercel-deploy.yml, scripts/deploy-now.js) run scripts/lib/prod-held-flags-guard.js
// and refuse to build while NEXT_PUBLIC_FEATURES enables one of these.
// Releasing one means removing it here. commercial (the Profitability Scorecard) was
// released 2026-10-26 (BRO-6192); to pull it again, restore its has() getter
// and add it back here. BRO-5007: boxOfficeV2 is not public yet
// (owner, 2026-10-10). vercel-demo.yml also leaves held flags off the public
// demo build unless DEMO_HELD_ALLOWLIST names them.
export const PROD_HELD_FEATURES = new Set(['boxOfficeV2']);

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
  get commercial() { return true; }, // Profitability Scorecard (/biz) launched 2026-10-26 (BRO-6192) — flag retained for cleanup
  // Box Office Scorecard v2 (BRO-5007): status vs weekly cost. Needs commercial
  // too (always on since BRO-6192). Held from prod (PROD_HELD_FEATURES) and from
  // the public demo build.
  get boxOfficeV2() { return has('boxOfficeV2'); },
  // Public Broadway Season Report (BRO-5777): season pace, mix, who recoups (aggregates only).
  get seasonReport() { return true; }, // launched 2026-10-20 (owner go after demo preview) — flag retained for cleanup
  // Path to Broadway (BRO-5842): routes and source material of new productions, with recoupment (aggregates only).
  get pathToBroadway() { return has('pathToBroadway'); },
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
  /** National tours of Broadway shows (category:'tour', BRO-4211). Gates the same
   *  surfaces as `regional` plus the public/data app feed (see src/config/markets.json).
   *  Launched 2026-09-28 in code (owner has no Vercel env access); keep in step with
   *  `launched: true` on the tour row of src/config/markets.json. The iOS app feed
   *  still needs NEXT_PUBLIC_FEATURES=tour (BRO-4254). */
  get tour() { return true; }, // launched 2026-09-28 — flag retained for cleanup
  get tonyPeople() { return has('tonyPeople'); },
  get sectionJumpLinks() { return has('sectionJumpLinks'); },
  get userAccounts() { return true; }, // launched 2026-10-02 (BRO-4525), flag retained for cleanup
  get showPageRedesign() { return true; }, // launched 2026-10-02 with userAccounts (BRO-4525), flag retained for cleanup
  get showtimes() { return true; }, // launched — flag retained for cleanup
  get theaterScorecard() { return true; }, // launched — flag retained for cleanup
  get fantasyLeague() { return true; }, // launched 2026-09-29 (BRO-4324, 2026-27 season) — flag retained for cleanup
  get videoReviews() { return true; }, // launched 2026-10-06 (BRO-4775), flag retained for cleanup
  get homepageExplainer() { return true; }, // launched — flag retained for cleanup
  get awardScoreV2() { return true; }, // launched 2026-05-17 — flag retained for cleanup
  /** Show-page rank surfaces: hero rank line ("Ranks #3 of 28 open Broadway · ...")
   *  and bottom "Where it ranks" card. Off by default — flip on per-market after
   *  smoke test. Enable via NEXT_PUBLIC_FEATURES=showRanks. */
  get showRanks() { return has('showRanks'); },
  /**
   * Add-to-Calendar and the showtime picker on diary entries.
   *
   * Deliberately its OWN flag rather than riding `userAccounts`. The sibling
   * split for `diarySharing` was made so a decision to hold sharing could not
   * hold the calendar hostage; without this one the reverse is unprotected —
   * a timezone bug in .ics export would leave "turn off every user account" as
   * the only kill switch, taking ratings, watchlist and lists down with it.
   *
   * CLIENT-SIDE ONLY. `GET /api/calendar.ics` is a server route and cannot read
   * this (see the isDemo note at the top of this file — it returns false during
   * SSR by design), so the route gates on the CALENDAR_EXPORT_ENABLED env var
   * instead. Both must be on for the feature to work end to end.
   */
  get calendarExport() { return has('calendarExport'); },
};
