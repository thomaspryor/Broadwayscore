// Prove the BRO-2835 banner fix: force suite 1 to FAIL and confirm the LAST
// line of output is the OVERALL FAIL line, not the second suite's PASS banner.
// Injects a pre-fix applyTemporalOverrides (bare new Date, the original bug).
const GUARDS = '/Users/tompryor/Broadwayscore/scripts/lib/review-guards.js';
const real = require(GUARDS);

const broken = Object.assign({}, real, {
  applyTemporalOverrides(wpFlag, filmTvFlag, wpConfidence, openingDate, publishDate, cvContext) {
    // The original implementation, verbatim in spirit: bare new Date().
    let resultWpConfidence = wpConfidence;
    let resultFilmTvFlag = filmTvFlag;
    const strongDifferent = false;
    if (!strongDifferent && openingDate && publishDate) {
      const opening = new Date(openingDate);
      const publish = new Date(publishDate);
      if (!isNaN(opening.getTime()) && !isNaN(publish.getTime())) {
        const daysDiff = Math.abs((publish.getTime() - opening.getTime()) / 86400000);
        if (daysDiff <= 30) {
          if (wpFlag) resultWpConfidence = 'low';
          if (filmTvFlag) resultFilmTvFlag = false;
        }
      }
    }
    return {
      wpConfidence: resultWpConfidence,
      filmTvFlag: resultFilmTvFlag,
      bypassedForStrongSignal: false,
    };
  },
});

const resolved = require.resolve(GUARDS);
require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: broken, paths: [] };
console.log('[inject] pre-fix (bare new Date) applyTemporalOverrides in place — suite 1 must FAIL');
require('/Users/tompryor/Broadwayscore/scripts/test-temporal-override-regression.js');
