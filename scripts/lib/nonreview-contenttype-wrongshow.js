/**
 * nonReviewType==='review' + wrongShow gap detector (BRO-3862).
 *
 * classify-non-reviews.js's LLM prompt asks two independent questions:
 *   isReview   — is this a review OF THE TARGET SHOW?
 *   contentType — what KIND of article is this, from
 *                 review|profile|interview|preview|feature|news|obituary?
 * When the scraped fullText is a genuine review of a DIFFERENT show (a
 * cross-outlet/cross-content misattribution — wrong URL, wrong scrape, wrong
 * page), the correct LLM answer is `isReview:false, contentType:'review'`:
 * the content really is a review, just not of this show. classify-non-
 * reviews.js stamps that as `isNonReview:true, nonReviewType:'review'` and
 * stops there — it never promotes the finding to `wrongShow:true`, the field
 * every other part of the pipeline (isScoreable, the cross-attribution
 * audits, fix-cross-outlet-attributions.js) reads to know a file's score
 * doesn't belong to its show directory.
 *
 * `isNonReview:true` alone happens to keep the file out of reviews.json, so
 * the symptom (wrong score counted for this show) never manifests — but the
 * file is invisible to every wrongShow-keyed monitor, and a future clear of
 * isNonReview (the essay-intro-fp sweep's exact shape, scripts/lib/essay-
 * intro-nonreview-fp.js) would reactivate a review that was NEVER a false
 * positive for isNonReview in the first place: it's real content, just
 * misattributed. That's a materially different failure mode than the
 * essay-intro class this ticket also covers, so it gets its own predicate
 * and its own audit (audit-review-type-wrong-show.js) rather than being
 * folded into detectEssayIntroFalsePositive.
 *
 * Verified corpus-wide 2026-09-20: 7 files match `nonReviewType:'review'` and
 * no `wrongShow`/`wrongProduction`. Two are NOT genuine cross-show content —
 * they're extraction failures the classifier mislabeled 'review' by accident:
 *   - hamilton-west-end-2021/whatsonstage--rachel-agyekum.json carries
 *     wrongProduction:true (a separate audit already caught it; fullText is
 *     null, so this predicate must check wrongProduction too, not just
 *     wrongShow, or it re-flags an already-resolved file).
 *   - la-cage-aux-folles-2010/broadwayworld--michael-dale.json's fullText is
 *     BroadwayWorld site chrome (nav menu, language picker, ticket ads) —
 *     zero review prose. It carries `rejectionReason: 'garbage_text'`, the
 *     review-guards.js signal for exactly this ("scraped the wrong thing
 *     entirely"), which is why isRejectedNonReview() must also be excluded:
 *     without it, this predicate would stamp a wrongShowReason claiming
 *     "classify-non-reviews.js identified this content as a genuine review"
 *     on a file that has no review content of ANY show, which is simply
 *     false and would corrupt the audit trail for the next person who reads
 *     wrongShowReason.
 * The remaining 5 (bloody-bloody-andrew-jackson-2010/variety--marilyn-
 * stasio.json, book-of-mormon-2011/variety--david-rooney.json,
 * book-of-mormon-2011/variety--marilyn-stasio.json, the-play-that-goes-
 * wrong-west-end-2021/londontheatre1--terry-eastham.json, wicked-2003/
 * nytimes--ben-brantley.json) are genuine gaps: real Variety/NYT/
 * londontheatre1 reviews of an unrelated film or play, scored (llmScore
 * present) as if they were reviews of the show they're filed under, with no
 * wrongShow/wrongProduction flag at all. wicked-2003's case was already
 * known — classify-non-reviews.js's RECLASSIFY_EXCLUDE list has carried a
 * comment since 2026-04-26 saying it "Needs wrongShow=true via cross-
 * attribution audit instead" — but no such audit existed until this one.
 * `detectCrossShowUrlMismatch` (audit-cross-show-url.js) cannot catch this
 * class either: it matches a URL slug against OTHER SHOWS' TITLES, and these
 * misattributed URLs (a Variety film review, a NYT article about an
 * unrelated play) never mention any of our show titles by slug — the
 * mismatch is a content signal, not a URL-shape one.
 */

'use strict';

const { wrongShowCleared, isRejectedNonReview } = require('./review-guards');

/**
 * @param {object} data - Review-text JSON (parsed).
 * @returns {boolean} true when this file is a review-of-a-different-show
 *   candidate that has NOT yet been promoted to wrongShow.
 */
function isReviewTypeWrongShowGap(data) {
  if (!data || data.isNonReview !== true) return false;
  if (data.nonReviewType !== 'review') return false;
  // Same "already handled" bar as audit-cross-show-url.js's isAlreadyHandled:
  // wrongProduction is treated as equivalent to wrongShow for exclusion
  // purposes everywhere else in this pipeline (isScoreable, the cross-
  // attribution fix tools), so a file already caught by that audit must not
  // be re-flagged here.
  if (data.wrongShow === true || data.wrongProduction === true) return false;
  if (wrongShowCleared(data)) return false;
  // A pre-existing garbage_text/not_a_review rejectionReason (or a high-
  // confidence contentVerification.wrongArticle verdict) means a MORE
  // precise mechanism already determined this file has no usable review
  // content at all — the classifier's 'review' contentType label is itself
  // the false signal in that case, not evidence of cross-show content, so
  // promoting it to wrongShow here would write a factually wrong reason.
  if (isRejectedNonReview(data)) return false;
  return true;
}

module.exports = { isReviewTypeWrongShowGap };
