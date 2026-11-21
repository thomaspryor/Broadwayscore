/**
 * submission-landing.js — did a /submit-review submission actually reach the site?
 *
 * Issue #908 (Golden Boy / Daily Mail, 2026-09-22): process-review-submission.yml
 * posted "Review Successfully Added" and closed the issue because the ingest
 * step exited 0, but the file it wrote was contentTier=invalid and the rebuild
 * excluded it. Nothing ever looked at the outcome. This answers the question
 * from the rebuilt reviews.json itself (the real decision), and only uses
 * explainExclusion() to say WHY when the answer is no.
 */

const fs = require('fs');
const path = require('path');
const { canonicalizeUrlForDedup, explainExclusion } = require('./review-guards');
const { unscoredSkipReason } = require('./scoring-queue-counts');
const { isQueuedRetryStub } = require('./submission-retry-stub');

// Submitters type https:// and www. freely while the ingest may store the
// page's own http:// URL (#1062: https submitted, http on file), so match
// scheme- and www-insensitively on top of the dedup canonical form (BRO-7614).
function submissionUrlKey(url) {
  return canonicalizeUrlForDedup(url).replace(/^https?:\/\/(www\.)?/, '');
}

function findSubmissionFile(showDir, submittedUrl) {
  const want = submissionUrlKey(submittedUrl);
  if (!want || !fs.existsSync(showDir)) return null;
  for (const f of fs.readdirSync(showDir)) {
    if (!f.endsWith('.json')) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8')); } catch { continue; }
    const urls = [data.url, data.previousUrl, ...(Array.isArray(data.alternateUrls) ? data.alternateUrls : [])];
    if (urls.some((u) => u && submissionUrlKey(u) === want)) {
      return { path: path.join(showDir, f), data };
    }
  }
  return null;
}

/**
 * @returns {{ landed: boolean, reason: string|null, file: string|null }}
 */
function checkSubmissionLanded({ showId, url, reviews, reviewTextsDir, show }) {
  const file = findSubmissionFile(path.join(reviewTextsDir, showId), url);
  if (!file) return { landed: false, reason: 'no review file was written for this URL', file: null };
  // URL identity only. An outlet+critic fallback would let an older, already
  // listed review by the same critic vouch for a submission that was itself
  // excluded (ship-check 2026-09-22). A merge that kept a different URL on the
  // file is not found above and is reported as not landed: a maintainer look,
  // never a false "added".
  const fileUrl = submissionUrlKey(file.data.url);
  const inReviews = !!fileUrl && reviews.some((r) => r.showId === showId && submissionUrlKey(r.url) === fileUrl);
  if (inReviews) return { landed: true, reason: null, file: file.path };
  // BRO-4431: a page we couldn't read yet was saved as a stub that the
  // collector, the T1/T2 gap audit and the aggregator star relay keep
  // retrying. Same wait-then-escalate path as an unscored review (the sweep
  // closes it once live, escalates after AWAITING_SCORE_MAX_HOURS).
  if (isQueuedRetryStub(file.data)) {
    return { landed: false, pendingScore: true, reason: 'page could not be read yet; queued for automatic retry', file: file.path };
  }
  const why = explainExclusion(file.data, show, file.path);
  if (why) return { landed: false, reason: why, file: file.path };
  // BRO-4141: an unscored review is left out of the rebuild and goes live when
  // the llm-ensemble-score cron scores it. That is a wait, not a failure: all
  // 11 "not on the site" owner emails of 9/23-9/24 were this case.
  // Pending only if the scorer will actually pick it up (its own selection
  // predicate): a text-gate-blocked or text-less file is never scored, so it
  // is a real miss that a maintainer should see now.
  if (!isScored(file.data)) {
    const skip = unscoredSkipReason(file.data, { show, showTitle: show && show.title, filePath: file.path });
    if (skip === null) {
      return { landed: false, pendingScore: true, reason: 'not scored yet (goes live once the scoring cron scores it)', file: file.path };
    }
    return { landed: false, reason: `unscored and the scorer will skip it (${skip})`, file: file.path };
  }
  return { landed: false, reason: 'excluded during rebuild (date or duplicate check)', file: file.path };
}

function isScored(data) {
  return (data.llmScore && data.llmScore.score != null) || data.assignedScore != null;
}

// How long an awaiting-score submission may wait before a maintainer looks.
// The llm-ensemble-score cron runs several times a day, so a review still
// unscored after this is stuck (text gate, scorer failure), not queued.
const AWAITING_SCORE_MAX_HOURS = 36;

/**
 * Sweep decision for an awaiting-score or manual-review submission issue.
 * @returns {'close'|'escalate'|'wait'}
 */
function decideAwaitingSubmission({ landed, ageHours, manualReview = false }) {
  if (landed) return 'close';
  // Already escalated: keep it visible without posting the same warning on
  // every rebuild. A later successful ingest can still close it above.
  if (manualReview) return 'wait';
  return ageHours >= AWAITING_SCORE_MAX_HOURS ? 'escalate' : 'wait';
}

/** The show whose review-texts dir holds a file for this URL, among candidates. */
function findShowForSubmission(url, shows, reviewTextsDir) {
  return shows.find((s) => findSubmissionFile(path.join(reviewTextsDir, s.id), url)) || null;
}

/**
 * checkSubmissionLanded for the show the submission NAMED, falling back to the
 * show that actually holds the review file. The validator can pick the wrong
 * production of a title (issue #1178: submitted against
 * waiting-for-lefty-regional-2024, ingested under
 * clifford-odets-waiting-for-lefty-off-broadway-2026); the sweep already
 * resolves by URL across all shows, so the per-submission check must too, or
 * it sends a false "not on the site" email and files a card for a live review.
 *
 * Falls back only when the named show has NO file for the URL. If it has one,
 * that verdict stands (a real exclusion there must not be masked by another
 * show's copy).
 * @returns {{ landed: boolean, reason: string|null, file: string|null, pendingScore?: boolean, actualShowId?: string }}
 *   actualShowId is set only when the review was found under a different show.
 */
function checkSubmissionLandedAnywhere({ showId, url, reviews, reviewTextsDir, show, shows }) {
  const named = checkSubmissionLanded({ showId, url, reviews, reviewTextsDir, show });
  if (named.file) return named;
  // Several other shows can hold a copy of the same URL; prefer one that is
  // actually live in reviews.json, else the first.
  const holders = (shows || []).filter((s) => s.id !== showId
    && findSubmissionFile(path.join(reviewTextsDir, s.id), url));
  if (!holders.length) return named;
  const results = holders.map((s) => ({ s, res: checkSubmissionLanded({ showId: s.id, url, reviews, reviewTextsDir, show: s }) }));
  const pick = results.find((r) => r.res.landed) || results[0];
  return { ...pick.res, actualShowId: pick.s.id };
}

module.exports = {
  checkSubmissionLanded, checkSubmissionLandedAnywhere, findSubmissionFile, submissionUrlKey, decideAwaitingSubmission, findShowForSubmission,
  AWAITING_SCORE_MAX_HOURS,
};
