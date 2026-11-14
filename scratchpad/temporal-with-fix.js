// Run the temporal-override regression from the MAIN checkout (which has the
// gitignored core data) but with the PATCHED review-guards.js from the worktree
// substituted in. The worktree cannot run this test itself: data/shows.json and
// data/review-texts are gitignored and absent there.
const path = require('path');

const MAIN_GUARDS = '/Users/tompryor/Broadwayscore/scripts/lib/review-guards.js';
const PATCHED_GUARDS =
  '/Users/tompryor/Broadwayscore/.claude/worktrees/bro-2835-temporal-date/scripts/lib/review-guards.js';

const patched = require(PATCHED_GUARDS);
const resolvedMain = require.resolve(MAIN_GUARDS);

// Prime the cache so the regression script's own require() of the main path
// receives the patched exports instead.
require.cache[resolvedMain] = {
  id: resolvedMain,
  filename: resolvedMain,
  loaded: true,
  exports: patched,
  paths: [],
};

const got = require(resolvedMain);
if (got.applyTemporalOverrides !== patched.applyTemporalOverrides) {
  console.error('INJECTION FAILED — the regression would test the UNPATCHED code');
  process.exit(2);
}
console.log('[inject] patched applyTemporalOverrides is in place');

require('/Users/tompryor/Broadwayscore/scripts/test-temporal-override-regression.js');
