'use strict';
/**
 * Newer-scoring-wins reconciliation for review-text files (BRO-4770).
 *
 * Incident: slam-frank-off-broadway-2026/one-minute-critic--matthew-wexler.json
 * had an anchored rescore committed at 00:16 UTC (scoreSource=anchored-v6,
 * llmScore.band, new llmMetadata.scoredAt). A 67-minute gather-reviews run that
 * checked out BEFORE that commit then pushed at 00:30 with a whole-file copy of
 * its stale snapshot, reverting llmScore/llmMetadata/scoreSource to the old
 * unanchored llm-v6 result. Two whole-file choosers in
 * .github/actions/push-review-texts/action.yml caused it: the autostash-pop
 * conflict path (`checkout --theirs` = the stale stash) and the rebase
 * conflict resolver (keeps the side with the longer fullText, scores and all).
 * restore-protected-fields.js only restored scoring fields when LOCAL HAD NONE,
 * so a present-but-stale score sailed through.
 *
 * Rule: scoring fields travel as one group, stamped by llmMetadata.scoredAt /
 * rescoreCompletedAt. Whichever side carries the newer stamp supplies the whole
 * group, regardless of which side won the file for other reasons (fullText).
 */

// The group a rescore rewrites together. originalScore* is NOT here: a later
// star extraction legitimately changes it (gather owns that), and humanReviewScore
// is protected elsewhere.
const SCORING_GROUP = [
  'llmScore',
  'llmMetadata',
  'ensembleData',
  'assignedScore',
  'scoreSource',
  'llmPullQuote',
  'needsRescore',
  'rescoreReason',
  'rescoreCompletedAt',
];

function ms(v) {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? t : 0;
}

/** Latest scoring stamp on a review record (0 = never LLM-scored). */
function scoringStamp(d) {
  if (!d || typeof d !== 'object') return 0;
  return Math.max(ms(d.llmMetadata && d.llmMetadata.scoredAt), ms(d.rescoreCompletedAt));
}

/**
 * If `other` carries a strictly newer scoring stamp than `winner`, copy the
 * whole scoring group from `other` onto `winner` (deleting fields `other`
 * lacks). Mutates `winner`. A winner with no LLM stamp and a non-LLM
 * scoreSource (a fresh star extraction) is left alone: that is a legitimate
 * newer non-LLM score, not a stale LLM revert.
 * @returns {{ changed: boolean, from: number, to: number }}
 */
function carryNewerScoring(winner, other) {
  const a = scoringStamp(winner);
  const b = scoringStamp(other);
  if (!(b > a)) return { changed: false, from: a, to: b };
  // A requeue raised AFTER the other side's last score is deliberate, not a stale
  // revert: flaggers delete rescoreCompletedAt so the drain sees the file, which
  // drops the winner's stamp below HEAD's and would carry HEAD's group back over
  // the flag at push time (BRO-4804). A stale snapshot's flag predates HEAD's
  // rescore stamp, so it still loses; flags without rescoreFlaggedAt keep the old rule.
  if (winner.needsRescore === true && ms(winner.rescoreFlaggedAt) > b) {
    return { changed: false, from: a, to: b };
  }
  // Deliberate clears (strip-stale-single-model-scores, stale-text parks,
  // _urlChangedClear, flag-combined-reviews) null llmScore/llmMetadata and leave
  // no stamp: never resurrect those.
  if (winner.llmScore === null || winner.llmMetadata === null) return { changed: false, from: a, to: b };
  // A score belongs to the article it read. A winner holding a different
  // article at the same path (a flagged record retired and the real review
  // written in its place, BRO-4956) must never inherit the old article's score:
  // the 2026 LBO Blood of my Blood review took the 2025 Juniper Blood 76 here.
  if (winner.url && other.url && require('./url-change-invariant').urlCanonicallyChanged(other.url, winner.url)) {
    return { changed: false, from: a, to: b };
  }
  // A fresh non-LLM score (star extraction) is legitimate, not a stale revert.
  if (a === 0 && winner.scoreSource && !/^(llm|anchored)/.test(String(winner.scoreSource))
      && winner.assignedScore != null) {
    return { changed: false, from: a, to: b };
  }
  // The star the winner carries must be the star the newer score was computed
  // against, or the record turns internally inconsistent.
  if (winner.originalScore !== other.originalScore
      || winner.originalScoreNormalized !== other.originalScoreNormalized) {
    return { changed: false, from: a, to: b };
  }
  const bodyChanged = (winner.fullText || '') !== (other.fullText || '');
  let changed = false;
  for (const f of SCORING_GROUP) {
    if (other[f] !== undefined) {
      if (JSON.stringify(winner[f]) !== JSON.stringify(other[f])) { winner[f] = other[f]; changed = true; }
    } else if (winner[f] !== undefined) {
      delete winner[f];
      changed = true;
    }
  }
  // Scores travel with their body: if the winner holds a different body than the
  // one the newer score read, keep the newer (band-anchored) score but queue a
  // re-check so it is re-verified against the new text.
  if (changed && bodyChanged) {
    winner.needsRescore = true;
    winner.rescoreReason = 'text-changed-after-rescore';
    delete winner.rescoreCompletedAt;
  }
  return { changed, from: a, to: b, bodyChanged };
}

module.exports = { SCORING_GROUP, scoringStamp, carryNewerScoring };
