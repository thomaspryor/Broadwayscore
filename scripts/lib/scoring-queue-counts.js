/**
 * scoring-queue-counts.js — canonical depth of each LLM scoring-cascade phase.
 *
 * WHY THIS EXISTS (2026-08-02, task #652 / Notion 3ad637c5-416f-81d0):
 * llm-ensemble-score.yml gates phases 2-4 behind a STRICT cascade: rescore only
 * runs when UNSCORED == 0, stale only when RESCORE == 0, emergency retry only
 * when STALE == 0. Each of those four counters was a separate hand-rolled
 * `node -e` block inlined in the workflow, and each was LOOSER than the
 * selection filter scripts/llm-scoring/index.ts actually applies. Measured on
 * the live corpus 2026-08-02, the UNSCORED counter read 147 while the scorer
 * could only ever act on 1 of those files:
 *
 *   97  excluded by the canonical isScoreable() gate the counter didn't call
 *   33  already carrying a terminal rescoreBlockedReason stamp (body_too_short)
 *   16  no scoreable text at all — never attempted, so never stamped either
 *    1  genuinely scoreable
 *
 * The 16 are the nastiest class: the scorer skips them before the LLM call, so
 * nothing is ever written to disk, so no stamp can ever retire them. They pin
 * the counter above zero permanently. Consequence: Phase 4 has never executed
 * — 38 reviews sat flagged singleModelEmergency with
 * singleModelEmergencyRetryCount === 0 across every run since the phase shipped.
 *
 * The fix is not a looser gate, it is ONE predicate per phase shared by the
 * counter and the scorer (memory/feedback_includability_predicates_must_be_canonical.md).
 * "Known-unrecoverable" work is excluded from the count by construction, so
 * UNSCORED reaches 0 and the cascade advances — while staying automatically
 * self-healing: isBlockedFromRescore() unblocks the moment fullText grows or an
 * excerpt appears, and selectScorableText() starts returning text the moment a
 * producer recovers the body.
 */

const fs = require('fs');
const path = require('path');

const { isScoreable } = require('./is-scoreable');
const { isBlockedFromRescore } = require('./rescore-lifecycle');
const { selectScorableText } = require('./scorable-text');
const { hasExcerpt } = require('./excerpt-fields');

/**
 * Why a file that looks unscored is not actionable work. Returned instead of a
 * bare boolean so the workflow can PRINT the residue rather than silently drop
 * it — a gate that hides what it excluded is how this bug survived.
 */
const UNSCORED_SKIP = {
  ALREADY_SCORED: 'already_scored',
  NOT_SCOREABLE: 'not_scoreable',
  TERMINAL_TEXT_GATE: 'terminal_text_gate_block',
  NO_SCORABLE_TEXT: 'no_scorable_text',
  STAR_RATING_AUTHORITATIVE: 'star_rating_authoritative',
};

/**
 * @param {Object} data - review-text record
 * @param {Object} [ctx]
 * @param {Object} [ctx.show] - `{ title }`, for isScoreable's wrongShow stale-flag override
 * @param {string} [ctx.showTitle] - show title, for content-quality's show-mention check
 * @param {string} [ctx.filePath]
 * @returns {string|null} a UNSCORED_SKIP reason, or null when this IS actionable work
 */
function unscoredSkipReason(data, ctx) {
  const c = ctx || {};
  if (data.assignedScore != null || data.llmScore || data.humanReviewScore) {
    return UNSCORED_SKIP.ALREADY_SCORED;
  }
  if (!isScoreable(data, c.show, c.filePath)) return UNSCORED_SKIP.NOT_SCOREABLE;
  // A deterministic text-gate rejection (body_too_short / nav_chrome_majority)
  // reproduces identically until the text itself changes. Counting it forever
  // is exactly what pinned this cascade. See rescore-lifecycle.js.
  if (isBlockedFromRescore(data)) return UNSCORED_SKIP.TERMINAL_TEXT_GATE;
  if (!selectScorableText(data, { showTitle: c.showTitle })) {
    return UNSCORED_SKIP.NO_SCORABLE_TEXT;
  }
  return null;
}

/** True when this unscored review is work the scorer can actually pick up. */
function isActionableUnscored(data, ctx) {
  return unscoredSkipReason(data, ctx) === null;
}

/**
 * Phase 2 (--needs-rescore). Mirrors index.ts's needsRescore filter.
 *
 * NOTE the deliberate difference from the old inline counter, which had
 * `if (!r.needsRescore || r.rescoreCompletedAt) return false;`. markRescoreComplete()
 * DELETES needsRescore when it stamps rescoreCompletedAt, so a file carrying
 * BOTH was re-flagged after an earlier completion — legitimately queued work
 * that the old counter hid (11 such files on 2026-07-30). The scorer picks
 * them up; the counter must agree, or the gate under-reports the queue.
 */
function isActionableRescore(data, ctx) {
  const c = ctx || {};
  if (data.needsRescore !== true) return false;
  if (!isScoreable(data, c.show, c.filePath)) return false;
  if (isBlockedFromRescore(data)) return false;
  return true;
}

/** Phase 3 (--stale-scores). Mirrors index.ts's staleScores filter. */
function isActionableStale(data, ctx) {
  const c = ctx || {};
  if (!data.fullText || data.fullText.length < 1000) return false;
  if (!data.llmScore || !data.llmScore.score) return false;
  if (data.needsRescore || data.ensembleData || data.rescoreCompletedAt) return false;
  const textSource = data.llmMetadata && data.llmMetadata.textSource;
  if (textSource && textSource.type === 'fullText') return false;
  if (!hasExcerpt(data)) return false;
  if (!isScoreable(data, c.show, c.filePath)) return false;
  return true;
}

/** Phase 4 (--retry-emergency). Mirrors index.ts's retryEmergency filter. */
function isActionableEmergencyRetry(data, ctx) {
  const c = ctx || {};
  const ed = data.ensembleData;
  if (!ed || !ed.singleModelEmergency) return false;
  if ((ed.singleModelEmergencyRetryCount || 0) >= 1) return false;
  if (!isScoreable(data, c.show, c.filePath)) return false;
  return true;
}

/**
 * Walk a review-texts tree and count every cascade phase in ONE pass.
 *
 * @param {string} baseDir - path to data/review-texts
 * @param {Object} [options]
 * @param {Map<string,string>} [options.showTitles] - showId -> title
 * @returns {{unscored:number, rescore:number, stale:number, emergency:number,
 *            scanned:number, unscoredResidue:Object<string,number>,
 *            unrecoverableSamples:string[]}}
 */
function countScoringQueues(baseDir, options) {
  const opts = options || {};
  const showTitles = opts.showTitles || new Map();
  const counts = {
    unscored: 0,
    rescore: 0,
    stale: 0,
    emergency: 0,
    scanned: 0,
    unscoredResidue: {},
    unrecoverableSamples: [],
  };

  let dirs = [];
  try {
    dirs = fs.readdirSync(baseDir).filter(d => {
      try { return fs.statSync(path.join(baseDir, d)).isDirectory(); } catch { return false; }
    });
  } catch {
    return counts;
  }

  for (const dir of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(baseDir, dir))
        .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    } catch { continue; }

    for (const file of files) {
      const filePath = path.join(baseDir, dir, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
      counts.scanned++;

      const title = data.showId ? showTitles.get(data.showId) : undefined;
      const ctx = { show: title ? { title } : undefined, showTitle: title, filePath };

      const skip = unscoredSkipReason(data, ctx);
      if (skip === null) {
        counts.unscored++;
      } else if (skip !== UNSCORED_SKIP.ALREADY_SCORED) {
        counts.unscoredResidue[skip] = (counts.unscoredResidue[skip] || 0) + 1;
        // The two classes that can never self-report a failure on disk are the
        // ones worth naming in the run log.
        if (
          (skip === UNSCORED_SKIP.NO_SCORABLE_TEXT || skip === UNSCORED_SKIP.TERMINAL_TEXT_GATE) &&
          counts.unrecoverableSamples.length < 20
        ) {
          counts.unrecoverableSamples.push(`${dir}/${file} (${skip})`);
        }
      }

      if (isActionableRescore(data, ctx)) counts.rescore++;
      if (isActionableStale(data, ctx)) counts.stale++;
      if (isActionableEmergencyRetry(data, ctx)) counts.emergency++;
    }
  }

  return counts;
}

module.exports = {
  UNSCORED_SKIP,
  unscoredSkipReason,
  isActionableUnscored,
  isActionableRescore,
  isActionableStale,
  isActionableEmergencyRetry,
  countScoringQueues,
};
