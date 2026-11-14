// Pure decisions for review-submission validation (BRO-6978).
//
// Two ways the old flow sent a submitter the wrong email:
//  1. A review we already list was returned as `reject`, so the submitter got
//     "we were unable to add it to our database" for a review that was live
//     on the site (NYSR / Rope, issue #1180; 9 of 22 rejects since September).
//  2. The LLM classifier rejected reviews from outlets in our own registry for
//     reasons that were wrong ("Off-West-End is not covered" #1074, a British
//     Theatre Guide URL "looks malformed" #1114, "this requires manual review"
//     returned as reject #1085).
// Duplicates now get their own outcome, and an LLM reject of a registered
// outlet goes to manual review instead of being closed.

const { urlFor } = require('./new-show-types');
const { isLocalOnlyShow } = require('./local-market');

const ALREADY_LISTED = 'already-listed';

function alreadyListedResult(duplicateCheck, show) {
  return {
    isValid: true,
    recommendation: ALREADY_LISTED,
    isDuplicate: true,
    existingLocation: duplicateCheck.location,
    reasoning: 'This review is already on Broadway Scorecard.',
    extractedData: {
      showId: duplicateCheck.showId || (show && show.id) || null,
      showTitle: (show && show.title) || null,
    },
    // Local-only shows have no public page, so no link (it would 404).
    showUrl: show && !isLocalOnlyShow(show) ? urlFor(show) : null,
  };
}

// The LLM may only close a submission outright when the outlet is unknown to
// us. A registered outlet's review is in scope by definition, so a reject
// there is the classifier's doubt, not a verdict.
function finalizeLlmRecommendation(llm, matchedOutlet) {
  if (!llm || llm.recommendation !== 'reject' || !matchedOutlet) return llm;
  return {
    ...llm,
    recommendation: 'needs-manual-review',
    reasoning: `Automatic check doubted this review, but ${matchedOutlet.displayName || matchedOutlet.id} is an outlet we track, so a person decides. Classifier said: ${llm.reasoning || '(no reason given)'}`,
  };
}

// Why a submission was turned down, as one of a few kinds the submitter email
// can describe truthfully. The old email listed three generic "common
// reasons", one of which ("an outlet we do not currently track") a critic
// from a tracked outlet received (#1180).
function rejectKind(result) {
  if (!result || result.recommendation !== 'reject') return '';
  if (result.rejectKind) return result.rejectKind;
  // LLM reject: only name a reason the classifier actually gave. A host we do
  // not match can still be a tracked critic (Substack, a new domain), so
  // anything less specific gets the neutral wording.
  const v = result.validationDetails || {};
  if (v.isReview === false) return 'not-a-review-page';
  if (v.isCoveredMarket === false) return 'outside-market';
  if (v.isLegitimateOutlet === false) return 'untracked-outlet';
  return 'other';
}

function rejectEmailText(kind, reviewUrl) {
  const why = {
    'no-url': 'we could not find a link in the submission.',
    'not-a-review-page': 'the link does not look like a review page to us (it looks like a listing, ticketing, database, news or press page). If it is a review, reply and we will take another look.',
    'outside-market': 'it looks like a review of a production outside the New York and London theater we cover. If that is wrong, reply and we will take another look.',
    'untracked-outlet': 'the publication is not one we currently include. We add publications from time to time, so if you think this one belongs, reply and tell us a little about it.',
  }[kind] || 'it did not pass our automatic checks. If that looks wrong, reply and we will take a look.';
  const link = reviewUrl ? `:\n\n${reviewUrl}\n\n` : '.\n\n';
  return `Thanks for sending us a review${link}We have not added it, because ${why}\n\nBroadway Scorecard`;
}

function alreadyListedEmailText(reviewUrl, showUrl) {
  return `Thanks for sending us this review:\n\n${reviewUrl}\n\nGood news: it is already on Broadway Scorecard${showUrl ? `, here:\n\n${showUrl}` : '.'}\n\nBroadway Scorecard`;
}

module.exports = {
  ALREADY_LISTED,
  alreadyListedResult,
  finalizeLlmRecommendation,
  rejectKind,
  rejectEmailText,
  alreadyListedEmailText,
};
