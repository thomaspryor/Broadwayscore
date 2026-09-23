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
const { normalizeCritic } = require('./review-normalization');

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
  const fileUrl = canonicalizeUrlForDedup(file.data.url);
  const critic = normalizeCritic(file.data.criticName || '');
  const inReviews = reviews.some((r) => r.showId === showId && (
    (fileUrl && canonicalizeUrlForDedup(r.url) === fileUrl)
    || (r.outletId === file.data.outletId && normalizeCritic(r.criticName || '') === critic)
  ));
  if (inReviews) return { landed: true, reason: null, file: file.path };
  const why = explainExclusion(file.data, show, file.path);
  return { landed: false, reason: why || 'excluded during rebuild (date or duplicate check)', file: file.path };
}

module.exports = { checkSubmissionLanded, findSubmissionFile };
