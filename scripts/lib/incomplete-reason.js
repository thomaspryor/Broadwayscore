/**
 * Classify WHY a review is incomplete.
 *
 * Separate module to avoid linter conflicts with content-quality.js.
 * Uses detectPaywall from content-quality.js for paywall text detection.
 */

const { detectPaywall, TRUNCATION_SIGNALS } = require('./content-quality');

// Known hard-paywall domains where incomplete content is almost certainly paywall-truncated.
const KNOWN_PAYWALL_DOMAINS = new Set([
  'wsj.com',
  'ft.com',
  'newyorker.com',
  'thetimes.co.uk',
  'telegraph.co.uk',
]);

/**
 * Classify WHY a review is incomplete.
 *
 * @param {Object} review - Review data object from the JSON file
 * @param {Object|null} failedFetchEntry - Entry from failed-fetches.json, or null
 * @returns {{ incompleteReason: string, incompleteDetail: string } | null}
 *   Returns null if contentTier is 'complete'.
 */
function classifyIncompleteReason(review, failedFetchEntry) {
  const tier = review.contentTier;
  // url_content_mismatch can occur even on previously-complete reviews (CDN misroutes, content swaps).
  // Always surface it regardless of contentTier so Browserbase escalation fires on next run.
  if (tier === 'complete' && failedFetchEntry?.failureReason !== 'url_content_mismatch') return null;

  const hasUrl = !!review.url;
  const hasFetchHistory = !!(review.fetchMethod || review.textFetchedAt);
  const fullText = review.fullText || '';
  const failureReason = failedFetchEntry?.failureReason;

  // Priority 1: Wrong content
  if (review.wrongShow || review.wrongProduction) {
    const detail = review.wrongProductionReason
      || review.wrongShowReason
      || review.contentMismatchNote
      || (review.wrongProduction ? 'Wrong production' : 'Wrong show');
    return { incompleteReason: 'wrong_content', incompleteDetail: detail };
  }

  // Priority 2: URL dead
  if (failureReason === 'url_dead_404' || failureReason === 'url_dead_410') {
    return {
      incompleteReason: 'url_dead',
      incompleteDetail: `${failureReason} (${failedFetchEntry.failureCount} attempts)`
    };
  }

  // Priority 3: Scraper garbage (but reclassify as paywall if garbage reason mentions paywall)
  if (failureReason === 'garbage_content') {
    const garbageDetail = failedFetchEntry.garbageReason || 'Unknown garbage';
    if (/paywall|subscribe|login|sign.in|members?\s+only/i.test(garbageDetail)) {
      return { incompleteReason: 'paywall', incompleteDetail: `Garbage classified as paywall: ${garbageDetail}` };
    }
    // Also check if the URL is a known paywall domain
    const ffUrl = failedFetchEntry.url || review.url;
    if (ffUrl) {
      try {
        const hostname = new URL(ffUrl).hostname;
        for (const domain of KNOWN_PAYWALL_DOMAINS) {
          if (hostname === domain || hostname.endsWith('.' + domain)) {
            return { incompleteReason: 'paywall', incompleteDetail: `Garbage from paywall domain: ${domain}` };
          }
        }
      } catch (e) { /* malformed URL */ }
    }
    return { incompleteReason: 'scraper_garbage', incompleteDetail: garbageDetail };
  }

  // Priority 3.5: URL content mismatch (server served wrong page — Browserbase escalation on next run)
  if (failureReason === 'url_content_mismatch') {
    const detail = failedFetchEntry?.mismatchReason || 'Content did not mention show';
    return { incompleteReason: 'url_content_mismatch', incompleteDetail: detail };
  }

  // Priority 4: No URL
  if (!hasUrl) {
    return { incompleteReason: 'no_url', incompleteDetail: 'No URL on review file' };
  }

  // Priority 5: Scraper timeout
  if (failureReason === 'all_tiers_timeout') {
    return {
      incompleteReason: 'scraper_timeout',
      incompleteDetail: `${failedFetchEntry.failureCount} timeout attempts`
    };
  }

  // Priority 6: Bot blocked / fetch error
  if (failureReason === 'all_tiers_failed' || failureReason === 'fetch_error') {
    return {
      incompleteReason: 'bot_blocked',
      incompleteDetail: `${failureReason} (${failedFetchEntry.failureCount} attempts)`
    };
  }

  // Priority 7: Paywall (multi-layered detection)
  // Layer A: Known hard-paywall domain
  try {
    const hostname = new URL(review.url).hostname;
    for (const domain of KNOWN_PAYWALL_DOMAINS) {
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        if (tier === 'truncated' || tier === 'excerpt' || tier === 'stub' || !tier) {
          return {
            incompleteReason: 'paywall',
            incompleteDetail: `Known paywall domain: ${domain}`
          };
        }
      }
    }
  } catch (e) { /* malformed URL */ }
  // Layer A.5: Bot-detection stubs embedded in partial review text — NOT a subscriber paywall.
  // These stubs appear at 90-95% of the file (after real article prose), past the normal
  // severe-truncation scan window. Requires CAPTCHA-solving tier (Browserbase), NOT Archive.org.
  // Check both truncationSignals (populated after classifyContentTier) AND fullText directly
  // (fallback when rebuild hasn't yet propagated signals into the data object).
  const truncSignalsEarly = review.truncationSignals || [];
  const hasNytBotStub = truncSignalsEarly.includes('nyt_bot_stub') ||
    (fullText && TRUNCATION_SIGNALS.severeAnywhere &&
      TRUNCATION_SIGNALS.severeAnywhere.some(p => p.test(fullText)));
  if (hasNytBotStub) {
    return {
      incompleteReason: 'bot_blocked',
      incompleteDetail: 'NYT bot-detection JS-loader stub detected in review text'
    };
  }
  // Layer A.6: WSJ paywall CTA before 90% of text — article cut off at subscription wall.
  // At ≥90% the CTA is footer chrome on a complete review; before 90% = genuine truncation.
  const hasWsjPaywallCta = truncSignalsEarly.includes('wsj_paywall_cta') ||
    (fullText && (() => {
      const wsjPat = /reading\s+your\s+article\s+with\s*a?\s+WSJ\s+(?:membership|subscription)/i;
      const m = wsjPat.exec(fullText);
      return m && m.index < fullText.length * 0.9;
    })());
  if (hasWsjPaywallCta) {
    return {
      incompleteReason: 'bot_blocked',
      incompleteDetail: 'WSJ paywall CTA before 90% of text — article truncated at subscription wall'
    };
  }
  // Layer B: Explicit paywall signals in text
  if (fullText) {
    const paywallCheck = detectPaywall(fullText);
    if (paywallCheck.detected) {
      return {
        incompleteReason: 'paywall',
        incompleteDetail: `Paywall text detected: ${paywallCheck.match}`
      };
    }
  }
  // Layer C: Truncation signals
  const truncSignals = truncSignalsEarly; // same reference; declared in A.5
  if (truncSignals.includes('paywall_or_login_prompt')) {
    return {
      incompleteReason: 'paywall',
      incompleteDetail: 'Truncation signal: paywall_or_login_prompt'
    };
  }

  // Priority 8: Roundup article
  if (review.isRoundupArticle && tier !== 'complete') {
    return {
      incompleteReason: 'roundup_only',
      incompleteDetail: 'Content is a multi-show roundup article'
    };
  }

  // Priority 9: Partial text (fetched but incomplete, non-paywall)
  if (hasFetchHistory && (tier === 'truncated' || tier === 'excerpt' || tier === 'stub')) {
    const wordCount = review.wordCount || 0;
    return {
      incompleteReason: 'partial_text',
      incompleteDetail: `Fetched via ${review.fetchMethod || 'unknown'}, ${wordCount} words, tier: ${tier}`
    };
  }

  // Priority 10: Not attempted
  if (!hasFetchHistory && !failedFetchEntry) {
    return {
      incompleteReason: 'not_attempted',
      incompleteDetail: hasUrl ? 'Has URL but never scraped' : 'No URL and never scraped'
    };
  }

  // Fallback
  return {
    incompleteReason: 'unknown',
    incompleteDetail: `tier=${tier}, fetchMethod=${review.fetchMethod || 'none'}, failureReason=${failureReason || 'none'}`
  };
}

module.exports = {
  classifyIncompleteReason,
  KNOWN_PAYWALL_DOMAINS,
};
