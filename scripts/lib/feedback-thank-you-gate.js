'use strict';

/**
 * Decides whether a categorized feedback submission gets its thank-you email
 * sent now, at intake/classification time.
 *
 * Pure and deliberately blind to downstream outcomes: it takes only the
 * categorizer's output, never a dispatch result, an add-requested-show.js
 * classification, or anything else that happens after this run. That is what
 * makes the decoupling structural rather than a convention someone can
 * accidentally break — a caller CANNOT make this depend on
 * createWorkflowDispatch/add-requested-show.js succeeding because the
 * function has no parameter through which that outcome could arrive.
 *
 * add-requested-show.yml runs asynchronously, in a separate workflow
 * dispatched from this one, and can reject the request (title-mismatch,
 * venue ambiguity — see scripts/add-requested-show.js) or leave it
 * `stillStaged`. None of that is knowable at the moment this script sends
 * the thank-you, and none of it should gate whether the submitter is
 * acknowledged: content-addition requests bypass diagnosis/auto-fix entirely
 * (scripts/lib/content-request-routing.js) and would otherwise never get any
 * acknowledgement (BRO-129).
 *
 * Bug/Content-Error reports that are NOT content-addition requests are the
 * one deliberate exception: their thank-you is sent after resolution, not
 * now, so this returns false for them.
 */
function shouldSendThankYouNow(categorized) {
  if (!categorized) return false;
  const isBugOrContentError = categorized.category === 'Bug' || categorized.category === 'Content Error';
  if (isBugOrContentError && !categorized.contentRequest) return false;
  return true;
}

module.exports = { shouldSendThankYouNow };
