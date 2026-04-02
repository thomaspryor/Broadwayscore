// Feature flags for staggered launch
// Controlled by NEXT_PUBLIC_FEATURES env var (comma-separated list of enabled features)
// To enable a feature: add its name to the env var in Vercel project settings
// Example: NEXT_PUBLIC_FEATURES="discountTickets,criticPages,boxOffice"
// Empty string = all features hidden (launch state)

const enabledFeatures = new Set(
  (process.env.NEXT_PUBLIC_FEATURES || '').split(',').map(s => s.trim()).filter(Boolean)
);

// Features auto-enabled on demo.broadwayscorecard.com (runtime check).
// Uses getters so the check runs each time the flag is read (client-side).
const DEMO_FEATURES = new Set(['userAccounts', 'showPageRedesign', 'showtimes', 'theaterScorecard']);

function isDemo(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.hostname === 'demo.broadwayscorecard.com';
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
  get castChanges() { return has('castChanges'); },
  get boxOffice() { return true; }, // launched — flag retained for cleanup
  get goldLists() { return has('goldLists'); },
  get commercial() { return has('commercial'); },
  get awards() { return has('awards'); },
  get tonyPredictions() { return has('tonyPredictions'); },
  get castPages() { return has('castPages'); },
  get westEnd() { return has('westEnd'); },
  get offBroadway() { return has('offBroadway'); },
  get tonyPeople() { return has('tonyPeople'); },
  get sectionJumpLinks() { return has('sectionJumpLinks'); },
  get userAccounts() { return has('userAccounts'); },
  get showPageRedesign() { return has('showPageRedesign'); },
  get showtimes() { return true; }, // launched — flag retained for cleanup
  get theaterScorecard() { return has('theaterScorecard'); },
};
