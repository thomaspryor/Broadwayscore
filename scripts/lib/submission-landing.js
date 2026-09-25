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

function findSubmissionFile(showDir, submittedUrl) {
  const want = canonicalizeUrlForDedup(submittedUrl);
  if (!want || !fs.existsSync(showDir)) return null;
  for (const f of fs.readdirSync(showDir)) {
    if (!f.endsWith('.json')) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8')); } catch { continue; }
    const urls = [data.url, data.previousUrl, ...(Array.isArray(data.alternateUrls) ? data.alternateUrls : [])];
    if (urls.some((u) => u && canonicalizeUrlForDedup(u) === want)) {
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
  const fileUrl = canonicalizeUrlForDedup(file.data.url);
  const inReviews = !!fileUrl && reviews.some((r) => r.showId === showId && canonicalizeUrlForDedup(r.url) === fileUrl);
  if (inReviews) return { landed: true, reason: null, file: file.path };
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
 * Sweep decision for an open `awaiting-score` submission issue (BRO-4141).
 * @returns {'close'|'escalate'|'wait'}
 */
function decideAwaitingSubmission({ landed, ageHours }) {
  if (landed) return 'close';
  return ageHours >= AWAITING_SCORE_MAX_HOURS ? 'escalate' : 'wait';
}

/** The show whose review-texts dir holds a file for this URL, among candidates. */
function findShowForSubmission(url, shows, reviewTextsDir) {
  return shows.find((s) => findSubmissionFile(path.join(reviewTextsDir, s.id), url)) || null;
}

module.exports = {
  checkSubmissionLanded, findSubmissionFile, decideAwaitingSubmission, findShowForSubmission,
  AWAITING_SCORE_MAX_HOURS,
};
