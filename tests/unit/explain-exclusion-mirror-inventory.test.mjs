// BRO-3592: inventory of every review-guards.js helper that explainExclusion()
// (the MIRROR) calls directly, and whether rebuild-all-reviews.js (the REAL
// gate) runs the same helper. BRO-2282 found two escape hatches
// (hasIndependentExcerptScore, isJsonLdStarNotAReview) that the mirror honored
// and the rebuild never called. Both now sit inside isRejectedAtExclusion /
// isRejectedByReasonExclusion, which the rebuild imports, so they are shared.
//
// Every helper must be classified below. A new carve-out added to
// explainExclusion fails this test until someone decides whether the rebuild
// runs it too, which is the moment that drift used to slip in silently.
//
// Inventory (audited 2026-10-12 against the corpus and a full rebuild's
// per-show exclusion lists):
//   live              rebuild-all-reviews.js calls the helper itself.
//   live-via:<fn>     rebuild calls <fn>, and <fn> calls the helper.
//   mirror-only:<why> the rebuild does not run it; the reason says why that
//                     is accepted and what it measured. Mirror/rebuild
//                     disagreement is tracked continuously by
//                     exclusion-rule-census.js --compare-rebuild (BRO-2320).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const GUARDS_SRC = fs.readFileSync(new URL('../../scripts/lib/review-guards.js', import.meta.url), 'utf8');
const REBUILD_SRC = fs.readFileSync(new URL('../../scripts/rebuild-all-reviews.js', import.meta.url), 'utf8');

const INVENTORY = {
  cvFlagVetoedInWindow: 'live',
  getCriticRegistry: 'live',
  isBodylessAggregatorScoreUncorroborated: 'live',
  isCancelledBeforeOpeningShow: 'live',
  isLikelyStaleRoundupFlag: 'live',
  isLikelyStaleSuspectedMisattribution: 'live',
  isNamedNonReviewUrlRecord: 'live',
  isNonReviewDemotedByFreshCV: 'live',
  isPrematureReviewForUnopenedShow: 'live',
  isPreviewFirstLookPiece: 'live',
  isRejectedAtExclusion: 'live',
  isRejectedByReasonExclusion: 'live',
  isRoundupPageAsReview: 'live',
  isUnverifiableWebSearchRow: 'live',
  wrongShowCleared: 'live',
  wrongShowExplicitlyCleared: 'live',
  // The rebuild has no cvWrongArticle exclusion of its own: it promotes a
  // high-confidence CV wrongArticle verdict to isNonReview, guarded by
  // cvNonReviewHumanCleared, which honors the same manual clear.
  cvWrongArticleManuallyCleared: 'live-via:cvNonReviewHumanCleared',
  // The rebuild's wrongProduction gate honors only the manual clears; it
  // writes its own auto-clears to disk as wrongProduction=false, so a file
  // still flagged true with a fresh auto-clear stamp was re-flagged after the
  // clear. Measured 2026-10-12: 0 such files in the corpus.
  isFreshWpAutoCleared: 'mirror-only: rebuild auto-clears by writing the flag false on disk; 0 files carry flag=true with a fresh stamp (2026-10-12)',
  // The rebuild clears stale wrongShow flags through
  // shouldAutoClearWrongShow / shouldAutoClearWrongShowUkUrl and the
  // LLM-checked sweep scripts/clear-stale-wrong-show-flags.js (~75% precision
  // heuristic, too loose to un-exclude on its own). Measured 2026-10-12: 48
  // files match it, and the mirror still excludes all 48 under another rule,
  // so it changes no verdict today.
  // BRO-5130: the rebuild has no contentTier==='invalid' exclusion (it only
  // counts those files in a diagnostic), so the matching-human-clear lift of a
  // stale invalid tier exists on the mirror side alone.
  invalidTierClearedByHuman: 'mirror-only: rebuild never gates on contentTier invalid (only a diagnostic count), so the human-clear lift is mirror-side (2026-10-12)',
  evaluateDirectorGuard: 'live',
  evaluateLateDateGuard: 'live',
  evaluateUrlYearGuard: 'live',
  getMultiProdGuards: 'mirror-only: lazy shows.json cache feeding the three guards above; the rebuild builds the same maps itself with buildMultiProdYearGuard/buildMultiProdDirectorGuard (BRO-3179, 2026-10-12)',
  wrongProductionClearLiftsInvalidTier: 'mirror-only: rebuild never gates on contentTier invalid, same as invalidTierClearedByHuman; a garbage tier is no longer lifted by a wrongProduction clear (BRO-3584, 2026-10-12)',
  isLikelyStaleWrongShow: 'mirror-only: heuristic (~75% precision) deferred to clear-stale-wrong-show-flags.js; 48 matching files, 0 verdict changes (2026-10-12)',
};

function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

const calls = (body, name) => new RegExp(`\\b${name}\\s*\\(`).test(body);

const guardFunctions = new Set([...GUARDS_SRC.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]));
const mirrorBody = functionBody(GUARDS_SRC, 'explainExclusion');
const directHelpers = [...guardFunctions]
  .filter((fn) => fn !== 'explainExclusion' && calls(mirrorBody, fn))
  .sort();

describe('explainExclusion mirror inventory (BRO-3592)', () => {
  test('explainExclusion is found and calls helpers', () => {
    assert.ok(mirrorBody && mirrorBody.length > 1000);
    assert.ok(directHelpers.length >= 10, `only found ${directHelpers.length} helpers`);
  });

  test('every helper explainExclusion calls is classified (new carve-outs must be decided)', () => {
    const unclassified = directHelpers.filter((fn) => !(fn in INVENTORY));
    assert.deepEqual(unclassified, [], 'classify these in INVENTORY: live, live-via:<fn>, or mirror-only:<reason>');
    const stale = Object.keys(INVENTORY).filter((fn) => !directHelpers.includes(fn));
    assert.deepEqual(stale, [], 'explainExclusion no longer calls these; drop them from INVENTORY');
  });

  for (const [fn, status] of Object.entries(INVENTORY)) {
    test(`${fn}: ${status.split(':')[0]}`, () => {
      if (status === 'live') {
        assert.ok(calls(REBUILD_SRC, fn), `${fn} is marked live but rebuild-all-reviews.js never calls it`);
      } else if (status.startsWith('live-via:')) {
        const via = status.slice('live-via:'.length);
        assert.ok(calls(REBUILD_SRC, via), `rebuild-all-reviews.js never calls ${via}`);
        assert.ok(calls(functionBody(GUARDS_SRC, via) || '', fn), `${via} no longer calls ${fn}`);
      } else {
        assert.match(status, /^mirror-only: \S/, 'mirror-only entries need a reason');
        assert.ok(!calls(REBUILD_SRC, fn), `${fn} is now called by rebuild; mark it live`);
      }
    });
  }
});
