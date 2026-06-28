'use strict';

/**
 * consent-refetch.js — decide whether a wrongShow/wrongProduction review whose
 * STORED text is garbage should be re-fetched so the consent-backlog auto-drains.
 *
 * Background (2026-06-28): the cookie-consent dismissal added to the scraper
 * (cookie-consent.js, 2026-06) can now read consent-walled outlets
 * (whatsonstage the repeat offender). But 424 reviews corpus-wide were captured
 * BEFORE that fix landed and stored EMPTY / consent-wall text, then got flagged
 * wrongShow / wrongProduction. The wrong-content skip in collect-review-texts.js
 * blocks flagged files from retrying (14-day cooldown only for `Collector LLM`
 * flags), so these never re-fetch and the real review stays missing forever.
 *
 * This decision lets a flagged review retry IFF its stored text is already
 * garbage (empty capture / pure consent-wall — isGarbageContent.isGarbage). That
 * is the safe signal: a flag set on garbage text has no real review to protect,
 * so re-fetching can only help. A flag on a review with REAL buried text
 * (isGarbage=false, e.g. a Time Out newsletter prefix + the actual review) is
 * NOT matched — re-fetching as garbage there would risk nulling a live review.
 *
 * A cooldown gates retries so an outlet whose wall still can't be dismissed
 * isn't re-scraped every run — drain once, then re-try every 14 days.
 *
 * Pure function (no I/O) so it can be unit-tested per project rule 15. The
 * caller computes isGarbageContent(text).isGarbage and passes it in.
 */

const REFETCH_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * @param {object} ctx
 * @param {boolean} ctx.hasGarbageStoredText - isGarbageContent(data.fullText).isGarbage
 * @param {number|null} ctx.lastRetryMs - epoch ms of the last consent re-fetch attempt (data.consentRefetchAt), or null
 * @param {number} ctx.nowMs - current epoch ms
 * @returns {boolean}
 */
function shouldRetryGarbageConsentWall({ hasGarbageStoredText, lastRetryMs, nowMs } = {}) {
  if (!hasGarbageStoredText) return false;
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return false;
  const age = (typeof lastRetryMs === 'number' && Number.isFinite(lastRetryMs))
    ? nowMs - lastRetryMs
    : Infinity;
  return age > REFETCH_COOLDOWN_MS;
}

module.exports = { shouldRetryGarbageConsentWall, REFETCH_COOLDOWN_MS };
