'use strict';
// Single source of the scoring-delta watchlists (BRO-5270). scripts/scoring-delta.js
// replays them, and the Stop hook .claude/hooks/verify-edits.sh requires this
// side-effect-free module (scoring-delta.js reads data/ at load) to know which
// edits need a counterfactual. Each scoring-delta.js run appends an exit stamp
// here so the hook judges the run by its real exit code, not by output text a
// pipe, 2>/dev/null or --json can drop.
const fs = require('fs');
const os = require('os');
const path = require('path');


// Phase A — inclusion decision files. Changes here can flip a review from
// included → excluded (or vice versa) in reviews.json.
const INCLUSION_FILES = [
  'scripts/lib/review-guards.js',
  // BRO-3963: the replay and rebuild share these dedup decisions.
  'scripts/lib/duplicate-of-exclusion.js',
  'scripts/lib/duplicate-cycle.js',
  'scripts/lib/canonical-duplicate-pointers.js',
  'scripts/lib/cross-outlet-cycle.js',
  'scripts/lib/syndication-pairs.js',
  'scripts/rebuild-all-reviews.js',
  // Pre-window inclusion predicate + priorRuns window logic (card 386637c5).
  // Threshold changes there flip inclusion decisions exactly like review-guards
  // edits do — before this entry, date-guard.js edits bypassed this gate entirely.
  'scripts/lib/date-guard.js',
  'scripts/lib/wrong-production-autoclear.js',
  // BRO-4855: the collected-before-previews hold (re-exported via date-guard.js).
  'scripts/lib/collected-before-previews.js',
  // BRO-4855: resolveGuardReviewDate, the rebuild pre-opening pass's effective date.
  'scripts/lib/backfill-publish-date.js',
  'src/lib/scoring.ts',
  'src/lib/engine.ts',
  'src/lib/data-core.ts',
  // Historical miss (task #947): classifyContentTier/validateShowMentioned here
  // drive contentTier and show-match rejections that rebuild-all-reviews.js and
  // recover-serp-text.js both consume for inclusion — CLAUDE.md rule 12 already
  // documented this file as "on the score-source watchlist" but it was never
  // actually added, so the Check-2 generic-idWords bug (2 wrong-show recoveries,
  // task #914 live incident) shipped without tripping this gate.
  'scripts/lib/content-quality.js',
  // Shared show-title variant matcher (2026-09-24) consumed by content-quality.js
  // validateShowMentioned/validateContentMentionsShow and by rebuild-all-reviews.js's
  // showNotMentioned auto-clear — an inclusion decision, same shape as above.
  'scripts/lib/show-title-variants.js',
  // BRO-5373: buildMultiProdDirectorGuard here builds the map the rebuild's
  // director guard excludes by (production order, earliest newer start), and
  // findPriorRunSiblings/preWindowExemptPriorRuns feed inclusion the same way.
  'scripts/lib/prior-run-sibling.js',
  // BRO-5876: isEvergreenListingUrl excludes listing/ticket pages at the rebuild's
  // skippedListingPage gate and feeds the wrongProduction auto-clear guards; its
  // review-headline exemption flipped 20+ reviews into reviews.json without
  // tripping this gate.
  'scripts/lib/cross-production-guards.js',
  // BRO-5876 what-else: the other two url gates of the same loop.
  // isBlockedReviewRecord decides skippedBlockedUrl and listingPageUrlReason
  // decides skippedListingPage (rebuild-all-reviews.js), and neither was watched.
  'scripts/lib/domain-filters.js',
  'scripts/lib/non-review-url-patterns.js',
  // Historical miss (2026-08-14): rebuild-all-reviews.js consumes
  // shouldWithholdStaleExclusionFlag from here at ten producer sites to decide
  // whether a guard may write an exclusion flag at all — an inclusion decision
  // by any reading. The file was not watched, so the 2026-08-14 rework of it
  // (deleting remediateStaleFlagAfterUrlCorrection) and an abandoned attempt to
  // narrow the detector BOTH ran this gate to "nothing to check" and had to be
  // validated by hand instead. Watch it: with this entry the same working tree
  // replays Phase A properly (verified — 42,254 reviews, 0 flips).
  'scripts/lib/stale-flag-after-url-correction.js',
  // Historical miss (2026-08-14, third of this exact shape after date-guard.js
  // and stale-flag-after-url-correction.js above): review-write-guard.js's
  // safeWriteReview consumes evaluateDatePlausibility to decide whether a NEW
  // review is quarantined as wrongProduction at ingest. A review quarantined
  // there never reaches reviews.json, so this is an inclusion decision by the
  // same reading that put date-guard.js on this list — the two files even share
  // the 180-day threshold and the priorRuns/tourLegs escape hatches. It was not
  // watched, so the dateSource: 'llm-scoring' exemption landed with this gate
  // reporting "nothing to check".
  'scripts/lib/date-plausibility.js',
  // Fourth of this exact shape (task #1678): the block in review-write-guard.js
  // that CALLS evaluateDatePlausibility/classifyClassAContamination is itself an
  // inclusion decision — whether a late-arriving implausible date on an
  // already-scored record gets stamped wrongProduction (excluded) or written
  // live. date-plausibility.js/cross-market-contamination.js were already
  // watched, but the caller wasn't, so a change to WHEN/WHETHER those checks
  // fire (not what they return) would have run this gate to "nothing to check".
  'scripts/lib/review-write-guard.js',
  // Fifth of this exact shape (BRO-3338, ship-check finding): the
  // shouldAutoClearAnticipatoryGrace replay this diff adds calls
  // isAnticipatoryPreviewPost from here to recompute its stillRejected ctx —
  // a change to its grace-period constants (e.g.
  // OFF_BROADWAY_GRACE_DAYS_BEFORE_OPENING) changes real inclusion decisions
  // at both ingest time (collect-review-texts.js) and via this auto-clear,
  // but was not watched, so this gate would report "nothing to check".
  'scripts/lib/content-filters.js',
  // Sixth (BRO-4563): isTourReviewExcerpt here is the tourContaminationInText
  // exclusion in review-guards.js and the rebuild's tour layers. Its tour-
  // production exemption changed real inclusion and this gate said "nothing
  // to check".
  'scripts/lib/excerpt-validation.js',
];

// Files that shape the TEXT handed to the LLM scorer. Phase B replays
// getBestScore over stored scores, so it cannot see what a re-score would
// return: when one of these changes, main() says so instead of implying the
// replay measured it.
const LLM_INPUT_FILES = [
  // Prompt framing changes need a paid A/B; stored scores cannot replay them.
  'scripts/llm-scoring/config.ts',
  'scripts/lib/llm-review-prompt.js',
  'scripts/lib/comparative-band.js',
  'scripts/lib/text-quality.js',
  // BRO-2610: text-quality.js strips and judges text with content-quality.js's
  // TRUNCATION_SIGNALS; a loose pattern there cut real reviews short before
  // scoring. input-builder.ts assembles the prompt; text-cleaning.js is the
  // shared HTML/entity cleanup text-quality.js calls.
  'scripts/lib/content-quality.js',
  'scripts/lib/text-cleaning.js',
  'scripts/llm-scoring/input-builder.ts',
  'scripts/lib/prior-runs-note.js',
  // BRO-6000: prompt note for multi-show split sections, assembled by input-builder.ts.
  'scripts/lib/split-excerpt-note.js',
  // text-quality.js requires EXCERPT_FIELDS from here: it decides which
  // excerpt fields getBestTextForScoring() falls back to.
  'scripts/lib/excerpt-fields.js',
];

// Phase B — score-source files. Changes here can keep a review included but
// change its assignedScore or scoreSource — silently moving a composite.
// Historical miss: scripts/lib/rebuild-helpers.js (getBestScore) wasn't in
// the watchlist; the NY Post stars fix 2026-04-22 slipped past this gate.
const SCORE_VALUE_FILES = [
  'scripts/lib/rebuild-helpers.js',
  'scripts/lib/score-extractors.js',
  'scripts/lib/score-parsers.js',
  'scripts/lib/review-normalization.js',
  'scripts/lib/score-routing.js',
  // BRO-6078: picks the same-URL twin whose rating the star-band clamp uses.
  'scripts/lib/sibling-rating-inherit.js',
  // BRO-2609: getBestTextForScoring() here builds the text the LLM scorer
  // receives (scripts/llm-scoring/input-builder.ts). An edit changes every
  // future llmScore, yet BRO-36's two edits here ran this gate to "nothing to
  // check". Watching it forces the replay and the LLM-input note below.
  ...LLM_INPUT_FILES,
];

const stampFile = (sessionId, kind = '') => path.join(process.env.SCORING_DELTA_STAMP_DIR || path.join(os.tmpdir(), 'scoring-delta-stamps'),
  `${String(sessionId || 'nosession').replace(/[^\w.-]/g, '_')}${kind ? '.' + kind.replace(/[^\w.-]/g, '_') : ''}.jsonl`);

function writeStamp(stamp, sessionId = process.env.CLAUDE_CODE_SESSION_ID, kind = '') {
  try {
    fs.mkdirSync(path.dirname(stampFile(sessionId, kind)), { recursive: true });
    fs.appendFileSync(stampFile(sessionId, kind), JSON.stringify({ ts: new Date().toISOString(), ...stamp }) + '\n');
  } catch { /* a stamp is evidence for the Stop hook, never a reason to fail the run */ }
}

function readStamps(sessionId, kind = '') {
  try {
    return fs.readFileSync(stampFile(sessionId, kind), 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

module.exports = { INCLUSION_FILES, LLM_INPUT_FILES, SCORE_VALUE_FILES, stampFile, writeStamp, readStamps };
