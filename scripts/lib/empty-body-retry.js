'use strict';

const fs = require('fs');
const path = require('path');
const { isBlockedReviewUrl } = require('./domain-filters');
const { extractArticleTextFromUrl, extractPublishDate } = require('./article-extractor');
const { classifyContentTier, validateContentMentionsShow, verifyFullTextContent } = require('./content-quality');
const { isArticleOutsideProductionWindow } = require('./date-guard');
const { createRunBudget } = require('./run-budget');
const { leaseSkipReason } = require('./opening-night-lane/lease-guard');
const { safeWriteReview } = require('./review-write-guard');

function needsEmptyBodyRetry(review) {
  return !!review && (!review.fullText || (typeof review.fullText === 'string' && !review.fullText.trim()))
    && review.contentTier === 'stub' && typeof review.url === 'string' && !!review.url.trim()
    && !review.wrongProduction && !review.wrongShow && !review.isNonReview
    && !review.duplicateOf && !review.duplicateTextOf && !review.isRoundupArticle
    && !review._locked && !review.manualContentTier && review.textStatus !== 'garbage_cleared'
    && !review.rssIdentityRejected && !review.promoteSkippedReason
    && !isBlockedReviewUrl(review.url);
}

// Called at the promotion writer, before an empty stub leaves _pending.
function markEmptyBodyForRetry(review) {
  if (needsEmptyBodyRetry(review)) review.needsTextRetry = true;
  return review;
}

function recoveryPatch(review, result, show, now = new Date().toISOString()) {
  if (!show?.title || typeof result?.content !== 'string' || result.format === 'markdown') return null;
  const fullText = extractArticleTextFromUrl(result.content, review.url, review.criticName);
  if (!fullText || fullText.trim().length < 300) return null;
  const match = validateContentMentionsShow(fullText, result.content, show.title, show.id);
  const verdict = verifyFullTextContent(fullText, show).verdict;
  if (!match.valid || ['probable_mismatch', 'confident_mismatch'].includes(verdict)) return null;
  const publishDate = extractPublishDate(result.content, review.url) || review.publishDate;
  if (publishDate && isArticleOutsideProductionWindow(show, publishDate)) return null;
  const tier = classifyContentTier({ ...review, fullText });
  if (!['complete', 'truncated'].includes(tier.contentTier)) return null;
  return {
    fullText,
    contentTier: tier.contentTier,
    contentTierReason: tier.tierReason,
    isFullReview: tier.contentTier === 'complete',
    wordCount: tier.wordCount,
    textStatus: 'success',
    fetchMethod: result.source,
    textFetchedAt: now,
    ...(publishDate && !review.publishDate ? { publishDate } : {}),
  };
}

/** Bounded, cookie-aware via fetchPage, and safe to import without fetching. */
async function retryEmptyBodyReviews({ root, shows, showIds, dryRun = false, limit = 10,
  cooldownHours = 6, budget = createRunBudget(2), now = Date.now,
  fetchPage = (...args) => require('./scraper').fetchPage(...args),
  isLeased = leaseSkipReason, log = console.log } = {}) {
  if (!fs.existsSync(root)) throw new Error(`Review texts directory missing: ${root}`);
  const showById = new Map(shows.map(show => [show.id, show]));
  const ids = showIds || fs.readdirSync(root, { withFileTypes: true })
    .filter(dir => dir.isDirectory() && !dir.name.startsWith('.') && !dir.name.startsWith('_'))
    .map(dir => dir.name);
  const candidates = [];
  for (const id of ids) {
    if (!showById.has(id) || isLeased(id)) continue;
    const dir = path.join(root, id);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(file => file.endsWith('.json'))) {
      const filepath = path.join(dir, file);
      let review;
      try { review = JSON.parse(fs.readFileSync(filepath, 'utf8')); }
      catch { log(`[text-retry] unreadable JSON: ${id}/${file}`); continue; }
      if (!needsEmptyBodyRetry(review)) continue;
      const lastAttempt = Date.parse(review.textRetryAttemptedAt) || 0;
      if (lastAttempt && now() - lastAttempt < cooldownHours * 3600000) continue;
      candidates.push({ id, file, filepath, review, lastAttempt });
    }
  }
  // Failed attempts go to the back so persistent paywalls cannot starve the backlog.
  candidates.sort((a, b) => a.lastAttempt - b.lastAttempt
    || Number(!!b.review.needsTextRetry) - Number(!!a.review.needsTextRetry)
    || a.filepath.localeCompare(b.filepath));
  const summary = { candidates: candidates.length, attempted: 0, recovered: 0, failed: 0, deferred: 0 };
  for (const candidate of candidates) {
    if (summary.attempted >= limit || budget.exceeded()) break;
    const { id, file, filepath } = candidate;
    // Another writer or the opening-night lane may have changed it during the scan.
    if (isLeased(id)) continue;
    let review = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    if (!needsEmptyBodyRetry(review)) continue;
    summary.attempted++;
    if (dryRun) {
      log(`[text-retry] DRY: ${id}/${file}`);
      continue;
    }
    const attemptedAt = new Date(now()).toISOString();
    // Checkpoint before fetch, including failures interrupted by the workflow timeout.
    review = { ...review, needsTextRetry: true, textRetryAttemptedAt: attemptedAt };
    if (!safeWriteReview(filepath, review).wrote) {
      summary.failed++;
      continue;
    }
    review = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    if (!needsEmptyBodyRetry(review)) continue;
    let patch = null;
    try {
      const result = await fetchPage(review.url);
      patch = recoveryPatch(review, result, showById.get(id), attemptedAt);
    } catch {
      // Do not log provider errors: they can contain credential-bearing request URLs.
    }
    // Re-read after the await; never overwrite a concurrent recovery or a new verdict.
    const current = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    if (isLeased(id) || current.url !== review.url || !needsEmptyBodyRetry(current)) continue;
    if (patch) {
      const recovered = { ...current, ...patch, needsTextRetry: false };
      const result = safeWriteReview(filepath, recovered);
      if (result.wrote && !result.autoFlaggedWrongProduction) {
        summary.recovered++;
        log(`[text-retry] recovered ${id}/${file}: ${patch.fullText.length} chars, ${patch.contentTier}`);
      } else {
        summary.failed++;
        log(`[text-retry] recovery refused by write guard: ${id}/${file}`);
      }
    } else {
      summary.failed++;
      log(`[text-retry] still empty or unusable: ${id}/${file}`);
    }
  }
  summary.deferred = candidates.length - summary.attempted;
  log(`[text-retry] ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = { needsEmptyBodyRetry, markEmptyBodyForRetry, recoveryPatch, retryEmptyBodyReviews };
