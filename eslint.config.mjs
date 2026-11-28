import nextVitals from 'eslint-config-next/core-web-vitals';

// Keep the existing Hooks checks during the framework upgrade. React Compiler
// is not enabled in this app; adopting its additional rules is a separate change.
const existingHooksRules = new Set(['react-hooks/rules-of-hooks', 'react-hooks/exhaustive-deps']);
const compilerRules = Object.fromEntries(nextVitals.flatMap(config =>
  Object.keys(config.rules || {})
    .filter(rule => rule.startsWith('react-hooks/') && !existingHooksRules.has(rule))
    .map(rule => [rule, 'off'])
));

export const SHOW_PAGE_FILES = ['src/app/show/**', 'src/components/show-page/**'];
const viaSeam = 'Read this show through getShowForRender() from @/lib/show-render (BRO-8056).';
// Patterns (not a list of paths) so every relative depth and the @/lib/data
// barrel are covered. Other-show getters (getShowById, ...) stay allowed.
const lib = (mod) => `^(@/lib/|(\\.\\./)+lib/)${mod}$`;
const THIS_SHOW = {
  'data-core': ['getShowBySlug'],
  'data-consensus': ['getCriticConsensus'],
  'data-audience': ['getAudienceBuzz', 'getAudienceBuzzBySlug'],
  data: ['getShowBySlug', 'getCriticConsensus', 'getAudienceBuzz', 'getAudienceBuzzBySlug'],
};
export const SHOW_PAGE_RESTRICTED_PATTERNS = Object.entries(THIS_SHOW).map(([mod, importNames]) => ({ regex: lib(mod), importNames, message: viaSeam }));

export default [...nextVitals, {
  rules: {
    ...compilerRules,
    // Next 16 adds this navigation preference; retain the existing lint policy.
    '@next/next/no-location-assign-relative-destination': 'off',
    // BRO-7494: code between import lines that reads an imported binding throws
    // "Cannot access 'X_1' before initialization" under ts-node's CommonJS
    // transpile (unit tests), though webpack hoists it. Zero violations at landing.
    'import/first': 'error',
  },
  linterOptions: { reportUnusedDisableDirectives: false },
}, {
  // BRO-8056: a show page reads ITS show only through getShowForRender()
  // (src/lib/show-render.ts), so a show-refresh overlay reaches the body,
  // metadata, JSON-LD and reviews.json together. Other shows' lookups
  // (getShowById for a tour parent, related shows) are allowed.
  files: SHOW_PAGE_FILES,
  rules: { 'no-restricted-imports': ['error', { patterns: SHOW_PAGE_RESTRICTED_PATTERNS }] },
}];
