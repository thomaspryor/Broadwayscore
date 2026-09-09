/**
 * cross-outlet-triage.js — the single exclusion predicate for
 * audit-cross-outlet-attributions.js.
 *
 * The audit runs two independent scans (the playbill-bleed scan and the
 * default-critic-of scan). Each used to inline its own list of "already
 * triaged, do not report" checks, and they DIVERGED: the bleed scan skipped
 * files flagged wrongProduction/wrongShow, the default-critic-of scan did not.
 *
 * A file flagged wrongShow is already excluded from scoring by review-guards,
 * so re-reporting it as an untriaged cross-outlet suspect is noise that no
 * amount of cross-outlet triage can clear — the file is not a cross-outlet
 * problem at all. That divergence held the CI acceptance test
 * ('no unreviewed cross-outlet attribution suspects remain') red on exactly
 * one file: the-other-place-2026/minneapolis-star-tribune--mark-kennedy.json,
 * a January 2013 review already flagged wrongShow.
 *
 * Both scans now call this. Changing an exclusion changes both by
 * construction, which is the point.
 */

/**
 * True when a review-text record has already been triaged out and must not be
 * reported as an unreviewed cross-outlet suspect.
 *
 * @param {object} d parsed review-text JSON
 * @param {(d: object) => (string|null)} explainExclusion review-guards' canonical
 *   exclusion explainer, injected so this stays a pure function.
 * @returns {boolean}
 */
function isTriagedOut(d, explainExclusion) {
  if (!d || typeof d !== 'object') return false;
  // A human/agent checked the page byline and confirmed the pairing is legit.
  if (d.crossOutletVerified === true) return true;
  // Already recorded as a bad attribution; reporting it again is noise.
  if (d.wrongAttribution === true) return true;
  // Excluded from scoring for being the wrong production/show. Whatever outlet
  // it is credited to, it is not a cross-outlet attribution question.
  //
  // Asked through explainExclusion, NOT the raw flags. Those flags are
  // clearable — manual clear, override, human-reviewed-false, and a
  // freshness-bounded auto-clear — and 369 of 42,418 review files corpus-wide
  // carry one while still being canonically includable, i.e. scored and live on
  // the site. Testing the raw flag would hide those live files from the audit
  // that exists to check their attribution. Cleared means scored, and scored
  // means its outlet/critic pairing still matters.
  const reason = explainExclusion(d);
  if (reason === 'wrongShow' || reason === 'wrongProduction') return true;
  // NOT excluded: duplicateOf. It was added here and then removed on review.
  // Scoring's isScoreable() does group it with the wrong-show flags, but
  // duplication and attribution are INDEPENDENT dimensions: a duplicated
  // syndicated article can still carry the wrong outlet's critic, and that is
  // precisely the contamination this audit exists to surface. Skipping it would
  // hide a real misattribution merely because scoring ignores that row. The
  // wrong-show flags are different -- they say the file is not about this show
  // at all, so its outlet/critic pairing is not a question this audit can even
  // ask.
  return false;
}

module.exports = { isTriagedOut };
