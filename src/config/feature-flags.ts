// Feature flags for staggered launch
// Controlled by NEXT_PUBLIC_FEATURES env var (comma-separated list of enabled features)
// To enable a feature: add its name to the env var in Vercel project settings
// Example: NEXT_PUBLIC_FEATURES="discountTickets,criticPages,boxOffice"
// Empty string = all features hidden (launch state)

const enabledFeatures = new Set(
  (process.env.NEXT_PUBLIC_FEATURES || '').split(',').map(s => s.trim()).filter(Boolean)
);

export const featureFlags = {
  discountTickets: enabledFeatures.has('discountTickets'),
  criticPages: enabledFeatures.has('criticPages'),
  creativePages: enabledFeatures.has('creativePages'),
  castChanges: enabledFeatures.has('castChanges'),
  boxOffice: enabledFeatures.has('boxOffice'),
  goldLists: enabledFeatures.has('goldLists'),
  commercial: enabledFeatures.has('commercial'),
  awards: enabledFeatures.has('awards'),
  tonyPredictions: enabledFeatures.has('tonyPredictions'),
  castPages: enabledFeatures.has('castPages'),
  westEnd: enabledFeatures.has('westEnd'),
  tonyPeople: enabledFeatures.has('tonyPeople'),
} as const;
