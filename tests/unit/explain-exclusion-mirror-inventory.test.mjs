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
  hasIncludableSyndicationPrimary: 'live',
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
  isCombinedReviewOfOtherMemberOnly: 'live',
  // BRO-5795: rebuild and explainExclusion both call this stale-flag check.
  isFullTextWrongAuthorActive: 'live',
  isRejectedAtExclusion: 'live',
  getBodyStubExclusionReason: 'live-via:isRegistrationWallStubExclusion',
  isRejectedByReasonExclusion: 'live',
  // BRO-6225: the rebuild reaches the head-of-article advisory through the CV-promoted nonReview demotion.
  isCvPartialWindowAdvisory: 'live-via:isNonReviewDemotedByFreshCV',
  isRoundupPageAsReview: 'live',
  isUnverifiableWebSearchRow: 'live',
  // BRO-5501: the rebuild decides duplicateOf inheritance through duplicateOfInheritedFlag, which runs this text test.
  textsConfirmedDifferent: 'live-via:duplicateOfInheritedFlag',
  // BRO-5129: the census-path duplicateOf branch asks it directly, same as the rebuild's refInheritedFlag.
  duplicateOfInheritedFlag: 'live',
  // BRO-5909: the rebuild asks duplicateOfRefIsCopy, which decides through this verdict; the mirror calls it directly.
  duplicateOfCopyRefVerdict: 'live-via:duplicateOfRefIsCopy',
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
  // BRO-5129: opt-in (opts.rebuildExclusions) read of the rebuild's own per-show list,
  // for the cross-file dedup and score-state passes a per-file mirror cannot derive.
  rebuildOnlyPassExclusion: 'mirror-only: reads the rebuild\'s own output, so the rebuild must never call it; only the census passes the list (BRO-5129, 2026-10-22)',
};

// BRO-5129: rules where the mirror excludes and the rebuild includes, after the
// census consults the rebuild lists (local full rebuild + census, 2026-10-22:
// 372/57,667 disagree = 0.65%, 117 of them mirror-only). Each is a deliberate
// carve-out, or a known gap with its cause, plus up to 3 live example files
// (fewer only when fewer exist). Re-measure with
// `node scripts/exclusion-rule-census.js --compare-rebuild --no-diff`.
const MIRROR_ONLY_RULES = {
  cvWrongArticleHighConfidence: {
    count: 59,
    why: 'carve-out: the rebuild treats a high-confidence CV wrongArticle as advisory once the ensemble scored the text as a review (hasHighConfidenceLlmScore), on a partial-window verdict (BRO-4429) or a deferred outlet style; the mirror stays strict so the scorer does not spend on CV-flagged non-reviews',
    examples: [
      'a-beautiful-noise-the-neil-diamond-musical-tour-2024/broadwayworld--scott-rawson.json',
      'a-midsummer-nights-dream-west-end-2026/london-box-office--eve-jawara.json',
      'after-midnight-2013/timeout--adam-feldman.json',
    ],
  },
  contentTierInvalid: {
    count: 36,
    why: 'carve-out: the rebuild never gates on contentTier invalid (diagnostic count only, see invalidTierClearedByHuman); these ship on an llm or star score',
    examples: [
      'american-buffalo-2022/nysr--frank-scheck.json',
      'bad-cinderella-2023/thestage--lane-williamson.json',
      'bandstand-2017/talkinbroadway--matthew-murray.json',
    ],
  },
  noTextOrScoreSignal: {
    count: 10,
    why: 'carve-out: stub files whose only score is an aggregator fallback the rebuild\'s getBestScore uses (bwwScore, dtliThumb, adjudication) and the mirror\'s signal check does not count',
    examples: [
      'a-beautiful-noise-the-neil-diamond-musical-2022/timeout--adam-feldman.json',
      'caroline-or-change-west-end-2018/a-younger-theatre--unknown.json',
      'come-fly-away-2010/backstage--david-sheward.json',
    ],
  },
  previewPlaceholder: {
    count: 3,
    why: 'carve-out: the rebuild\'s inline loop has no isPreviewPlaceholder gate; the mirror keeps BRO-931\'s guard so the scorer skips uncleared placeholders',
    examples: [
      'a-midsummer-nights-dream-globe-west-end-2026/timeout-london--andrzej-lukowski.json',
      'pride-west-end-2026/broadwayworld--jay-irwin.json',
      'thelma-and-louise-a-new-musical-off-west-end-2026/times-uk--susannah-butter.json',
    ],
  },
  wrongProduction: {
    count: 2,
    why: 'known gap: the rebuild honors any truthy wrongProductionManualClear (a dated note string); the mirror\'s clears require === true',
    examples: [
      'oliver-west-end-2024/thestage--sam-marlowe.json',
      'the-holy-rosenbergs-west-end-2026/london-theatre--matt-wolf.json',
    ],
  },
  rejectionReason: {
    count: 1,
    why: 'known gap: a not_a_review rejection on an aggregator-relay row the rebuild ships on aggregatorStars (the only live case)',
    examples: ['krapps-last-tape-godots-todo-list-west-end-2026/london-box-office--stuart-king.json'],
  },
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

describe('rebuild-only passes and mirror-only rules (BRO-5129)', () => {
  test('every REBUILD_ONLY_PASS_REASONS name is a reason the rebuild really logs', async () => {
    const { REBUILD_ONLY_PASS_REASONS } = (await import('../../scripts/lib/review-guards.js')).default;
    assert.ok(REBUILD_ONLY_PASS_REASONS.size >= 10);
    for (const reason of REBUILD_ONLY_PASS_REASONS) {
      assert.match(REBUILD_SRC, new RegExp(`log(?:PostDedup)?Exclusion\\(\\s*['"]${reason}['"]`), `${reason} is not a rebuild exclusion reason`);
    }
  });

  test('per-file rules never ride the rebuild list (they are real mirror gaps the census must count)', async () => {
    const { REBUILD_ONLY_PASS_REASONS } = (await import('../../scripts/lib/review-guards.js')).default;
    for (const perFile of ['skippedCrossMarket', 'skippedInvalidUrl', 'skippedPreOpening', 'skippedShowNotMentioned', 'skippedWrongProduction', 'skippedWrongShow', 'skippedDuplicateOf']) {
      assert.ok(!REBUILD_ONLY_PASS_REASONS.has(perFile), `${perFile} must stay a measured disagreement`);
    }
  });

  for (const [rule, entry] of Object.entries(MIRROR_ONLY_RULES)) {
    test(`mirror-only rule ${rule} is documented with its live examples`, () => {
      assert.match(entry.why, /^(carve-out|known gap): \S/);
      assert.ok(entry.examples.length === Math.min(3, entry.count), `${rule}: list min(3, count) examples`);
      assert.ok(entry.examples.every((f) => /^[a-z0-9-]+\/[^/]+\.json$/.test(f)));
    });
  }
});
