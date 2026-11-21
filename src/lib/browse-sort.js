// Extracted from BrowseListClient.tsx (task #75 follow-up) so a real unit
// test can exercise it directly instead of only regex-matching source text.
//
// Bug this guards against: `null` (TBD / not-enough-reviews) scores must sort
// last in BOTH directions. A naive `a - b` flip for ascending order (instead
// of an explicit null check) puts unscored shows FIRST once a sort direction
// is reversible — caught by an adversarial pre-ship review (Codex) after the
// reverse-direction toggle for Critics/A-Z was added to fix the rage-click
// bug itself.
//
// CommonJS on purpose, same as src/lib/sort-toggle.js: `tsconfig.json` has
// `allowJs: true` so Next.js/webpack can import this with named imports from
// .tsx, and `tests/unit/*.test.mjs` requires plain CJS modules directly.
function compareScore(a, b, ascending) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return ascending ? a - b : b - a;
}

module.exports = { compareScore };
