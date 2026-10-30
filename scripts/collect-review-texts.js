// GUARD-A-DISPOSITION (BRO-2158): live but enrichment-only. Writes only to review files already resolved by known showId (review.filePath); never creates files from cross-show discovery, so Guard A does not apply.
/**
 * Collect Review Texts - Multi-Tier Fallback System
 *
 * TIER 0: Archive.org (for archiveFirstSites - paywalled domains where Archive.org excels)
 * TIER 1: Playwright-extra with stealth plugin + login for paywalls + Google referrer header
 * TIER 1.1: AMP page variant (/amp/ URL — many soft paywalls serve full text on AMP)
 * TIER 1.5: Browserbase (managed browser cloud with CAPTCHA solving) - SPENDING LIMITS APPLY
 * TIER 2: ScrapingBee API
 * TIER 3: Bright Data Web Unlocker
 * TIER 3.6: Archive.today (archive.ph — community-archived paywall bypasses)
 * TIER 4: Archive.org Wayback Machine (final fallback)
 *
 * SUCCESS RATES (Jan 2026 data):
 *   Archive.org:  11.1% (best performer!)
 *   Playwright:    6.7%
 *   Browserbase:   NEW - $0.10/browser hour, has CAPTCHA solving
 *   ScrapingBee:   3.6%
 *   BrightData:    3.7%
 *
 * Environment variables:
 *   NYT_EMAIL, NYT_PASSWORD - New York Times credentials
 *   VULTURE_EMAIL, VULTURE_PASSWORD - Vulture/NY Mag credentials
 *   WAPO_EMAIL, WAPO_PASSWORD - Washington Post credentials
 *   SCRAPINGBEE_API_KEY - ScrapingBee API key
 *   BRIGHTDATA_TOKEN - Bright Data API token
 *   BRIGHTDATA_CUSTOMER_ID - Bright Data customer ID
 *   BROWSERBASE_API_KEY - Browserbase API key (for managed browser cloud)
 *   BROWSERBASE_PROJECT_ID - Browserbase project ID
 *   BROWSERBASE_ENABLED - 'true' to enable Browserbase tier
 *   BROWSERBASE_MAX_SESSIONS_PER_DAY - Daily limit (default: 250, lib/browserbase-caps.js)
 *   BROWSERBASE_MAX_SESSIONS_PER_RUN - Per-run limit (default: 30)
 *   BROWSERBASE_MAX_SESSIONS_PER_DOMAIN - Per-run per-domain limit (default: 10)
 *   BROWSERBASE_RECOVERY_RESERVE - Sessions held back for opted-in runs (default: 30)
 *   BROWSERBASE_USE_RESERVE - 'true' lets this run use the reserve (targeted recovery, opening night)
 *   WSJ_COOKIES - Base64-encoded JSON cookie array for WSJ paywall bypass
 *   NEWYORKER_COOKIES - Base64-encoded JSON cookie array for New Yorker paywall bypass
 *   NYT_COOKIES - Base64-encoded JSON cookie array for NYT paywall bypass
 *   VULTURE_COOKIES - Base64-encoded JSON cookie array for Vulture/NYMag paywall bypass
 *   WAPO_COOKIES - Base64-encoded JSON cookie array for Washington Post paywall bypass
 *   BATCH_SIZE - Reviews per batch (default: 10)
 *   MAX_REVIEWS - Max reviews to process (default: 50, 0 = all)
 *   PRIORITY - 'tier1' or 'all' (default: all)
 *   SHOW_FILTER - Only process specific show ID
 *   RETRY_FAILED - 'true' to retry previously failed reviews
 *   DOMAIN_FILTER - Comma-separated domain(s) to filter by URL (e.g., 'theatermania.com,timeout.com')
 *   EXCLUDE_DOMAINS - Comma-separated domain(s) to exclude (inverse of DOMAIN_FILTER)
 *
 * CLI Flags:
 *   --aggressive - Skip Playwright for known-blocked sites, start with ScrapingBee
 *   --tier=N - Force specific tier (1-4) for testing
 *   --test-url="URL" - Test single URL with all tiers
 */

const { pointsAtFile, planCanonicalPointerClear, applyCanonicalPointerClear } = require('./lib/canonical-duplicate-pointers');
const { quarantineBody } = require('./lib/quarantine-body');
const { withTimeout: sharedWithTimeout } = require('./lib/with-timeout');
const { guardianContentToResult, titleHtmlFor, guardianMentionWaiver } = require('./lib/guardian-api-result');
const fs = require('fs');
const { readReviewForUpdate, persistReviewSnapshot, renameReviewSnapshot } = require('./lib/persist-review-snapshot');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { matchesReviewFilter, isForcedRefetch, shouldRescoreForcedReplacement, shouldRescoreCompletedTruncated, forcedRefetchTrim, applyCrossOutletSkip, setDuplicateTextOf, staleCrossOutletFlagAfterRefetch, staleScoreOverridesAfterRefetch } = require('./lib/review-filter');
const { hostMatchesOutletDomain } = require('./lib/outlet-domain-validation');
const { loadCookiesForDomain, hasCookiesForUrl, buildCookieHeaderForUrl, COOKIE_DOMAIN_MAP } = require('./lib/cookie-loader');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { pushWithRetry } = require('./lib/push-with-retry.js');
const { markReviewTextsPushed } = require('./lib/review-texts-pushed-marker.js'); // BRO-5308
const { isTimeBudgetExceeded } = require('./lib/collect-time-budget.js');
const { buildCollectSummary, writeCollectSummary } = require('./lib/collect-run-summary.js');
const { shouldSkipAlreadyAttempted, dedupeAttemptState } = require('./lib/collection-attempt-guard.js');
const { protectStagedDeletions, invalidateWrongProductionAutoClear } = require('./lib/review-write-guard.js');
const { shouldPushReviewTextsCheckpoint, countUnpushedCommits, decideCheckpointAction } = require('./lib/review-texts-checkpoint-gate.js');
const { sbPageBudgetDecision, resolveSbPageCreditBudget } = require('./lib/crt-sb-credit-guard.js');
const https = require('https');
require('./lib/cloud-proxy'); // BRO-6258: route ScrapingBee through the cloud egress proxy

const USAGE = `collect-review-texts.js — multi-tier fallback review text scraper.

Usage:
  node scripts/collect-review-texts.js [--aggressive] [--tier=N] [--test-url=URL] [--stealth-proxy]
  node scripts/collect-review-texts.js --help, -h   print this usage and exit — no scraping/writes

See file header comment for the full env-var config surface (BATCH_SIZE, MAX_REVIEWS, etc).
`;
// const { HttpsProxyAgent } = require('https-proxy-agent'); // Not used - Bright Data needs zone setup

// Catch unhandled promise rejections from playwright-extra stealth plugin
// (cdpSession.send / onPageCreated errors when browser dies mid-operation)
let unhandledRejectionCount = 0;
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason?.message || String(reason);
  const isPlaywrightCrash = msg.includes('Target page, context or browser has been closed') ||
    msg.includes('Target closed') ||
    msg.includes('Browser has been closed') ||
    msg.includes('Protocol error') ||
    msg.includes('cdpSession.send') ||
    msg.includes('onPageCreated');
  if (isPlaywrightCrash) {
    unhandledRejectionCount++;
    console.log(`  ⚠ Caught browser crash (rejection #${unhandledRejectionCount}): ${msg.slice(0, 100)}`);
    // Don't exit — the main loop's timeout handler will restart the browser
  } else {
    console.error('Unhandled rejection:', msg);
    // For non-Playwright errors, exit after saving state
    if (unhandledRejectionCount > 20) {
      console.error('Too many unhandled rejections, exiting');
      process.exit(1);
    }
  }
});

// Score extraction for original scores
const { extractScore, extractDesignation, extractNYTCriticsPick, OUTLET_VERIFIED_SOURCES, OUTLET_EXTRACTORS, publishesNoCriticRating } = require('./lib/score-extractors');
const { findBoldHeaderAnchors, loadShows: loadSplitterShows } = require('./lib/multi-show-splitter');
const { applyMultiShowFanoutToFile } = require('./lib/multi-show-review-fanout');
const { extractExplicitScore } = require('./lib/llm-score-extractor');
// BRO-912: shared byline-anchored extractor (article-extractor.js) — aliased
// to avoid colliding with this file's own Playwright-DOM extractArticleText(page).
const { extractArticleText: extractArticleTextFromHtml, extractZoxNewsBody, extractVarietyBody, isDedicatedExtractorHost } = require('./lib/article-extractor');

// Text cleaning (entity decoding, junk stripping)
const { cleanText, stripTrailingJunk, TRAILING_JUNK_PATTERNS, hasStrippableConsentLayer } = require('./lib/text-cleaning');
const { preCleanForStorage, storedTextForm } = require('./lib/stored-text-form');

// LLM-based content verification
const { verifyContent, quickValidityCheck, resolveCvMarket, contentHash, isCvVerdictFromTruncatedFetch, isCvVerdictFromPartialWindow } = require('./lib/content-verifier');
const { isLongRunningProduction: _isLongRunner } = require('./lib/long-runner-registry');

// Content quality detection (garbage/invalid content filter)
const { isolateMultiShowSection, MULTI_SHOW_NOT_FOUND_REASON } = require('./lib/multi-show-section-extract');
const { laneBypasses } = require('./lib/opening-night-lane/trust-model');
const { assessTextQuality, qualityOptsFor, isGarbageContent, validateShowMentioned, validateContentMentionsShow, extractByline, matchesCritic, computeContentFingerprint, classifyContentTier, verifyFullTextContent, extractAuthorFromHtml, extractHighConfidenceAuthor, URL_CONTENT_CHECK_VERSION } = require('./lib/content-quality');
const { chooseArticleBody, SHORT_JSONLD_MAX: JSONLD_TEASER_MAX } = require('./lib/jsonld-body-choice');
const { resolveOutletFromUrl, getOutletDisplayName, generateReviewFilename, normalizeOutlet } = require('./lib/review-normalization');
const { setExtractedScore, AGGREGATOR_SCORE_SOURCES } = require('./lib/score-routing');
const { discardNoRatingOutletScore } = require('./lib/no-rating-outlet-score');
const { runScoreExtractorPrePass } = require('./lib/score-extractor-prepass');
const { classifyIncompleteReason, applyIncompleteReason } = require('./lib/incomplete-reason');
const { isTourReviewExcerpt, tourContextForShow, isFilmTvReview } = require('./lib/excerpt-validation');
const { isAnticipatoryPreviewPost } = require('./lib/content-filters');
const {
  NO_DATE_SENTINEL,
  buildShowRecencyMap,
  NEEDS_REFETCH_DRAIN_PER_RUN,
  isNeedsRefetchDrainCandidate,
  promoteNeedsRefetch,
  compareReviewPriority,
  AGED_STUB_DRAIN_PER_RUN,
  isAgedNeverAttemptedStub,
  promoteAgedStubs,
} = require('./lib/collection-priority');

// NYT Critics' Pick lookup — lazy-loaded once per run from authoritative URL list.
// Do NOT check raw HTML (10% FP from NYT page chrome). URL match only.
let _nytCriticsPicks = null;
function getNytCriticsPicks() {
  if (!_nytCriticsPicks) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'nyt-critics-picks.json'), 'utf8'));
      _nytCriticsPicks = new Set(data.urls.map(u => u.replace(/[?#].*$/, '').replace(/\/$/, '')));
    } catch { _nytCriticsPicks = new Set(); }
  }
  return _nytCriticsPicks;
}
const { isLondonMarket } = require('./lib/venue-classification');
const { isUrlCorrectedRefetch, mayShortCircuitCollected, bypassesFetchFailureGate } = require('./lib/url-corrected-refetch');
const { shouldSkipScoredReview, shouldSkipWrongProductionAudit, wrongShowCleared, evaluateShowMentionGuard, pickShowTitleForHeuristic, checkLlmVerificationAgainstKeywords, hasHighConfidenceLlmScore } = require('./lib/review-guards');
const { ownShowTextEvidence } = require('./lib/own-show-text-evidence');
const { resolveShowIdentity } = require('./lib/show-identity');
// Shared JSON-LD reader — handles schema.org @graph, which a hand-rolled
// `Array.isArray(x) ? x : [x]` silently misses (scripts/lib/jsonld.js).
const { extractFromJsonLd, extractParagraphText } = require('./lib/html-article-text');
const {
  isWithinPriorRun,
  isWithinTourLeg,
  shouldPreserveExclusionFlagsOnUrlRecovery,
} = require('./lib/wrong-production-autoclear');
const { shouldRetryGarbageConsentWall, storedTextNeedsConsentRefetch, shouldReleaseConsentLayerNonReview, salvageConsentPrefixedStoredText, salvageSourceHash, applyVerifiedRetryOutcome } = require('./lib/consent-refetch');
const { shouldRetryDatelessHoldFetch } = require('./lib/review-slot-guards');
const { isProvisionalPublishDate, isReplaceableByPageDate, needsOpeningWindowDateRecheck, resolvePageDateReplacement, htmlDateSourceFor, bodyPublishDateFallback, ingestGateDate } = require('./lib/publish-date-provenance');
const { checkBrowserbaseCaps, countBrowserbaseAttempt, resolveMaxSessionsPerDay, resolveRecoveryReserve, resolveUseReserve, isDeniedHost, isTier1RecoveryHost, tier1BoostForCaller, resolveExemptScripts: resolveBbExemptScripts } = require('./lib/browserbase-caps');
const { isExemptCaller: isBbExemptCaller } = require('./lib/brightdata-caps');

/** BRO-5243: true when the URL's host is on the Browserbase deny list (never a review). */
function isDeniedBrowserbaseHost(url) {
  try { return isDeniedHost(new URL(url).hostname); } catch { return false; }
}
const { pinBrowserbaseFirst } = require('./lib/browserbase-route');
const { classifyTimeoutPage, isTimeoutUrl, keepsStoredTimeoutReview } = require('./lib/timeout-capsule');
const { fetchLiveBrowserbaseSessionsToday: _fetchLiveBBSessions } = require('./lib/browserbase-live-usage');
const { logExclusion } = require('./lib/exclusion-logger');
const { shouldSkipPollerUpdate, invalidateWrongShowAutoClear, shouldMarkUrlCollisionDuplicate } = require('./lib/review-write-guard');
const { updateFileUrlWithInvariant, isDifferentArticleRecovery } = require('./lib/url-change-invariant');
const { extractDateFromUrl: extractDateFromUrlCanonical } = require('./lib/rebuild-helpers');
const { verificationPublishDate } = require('./lib/verification-publish-date');
const { verifierExcerpt } = require('./lib/excerpt-fields');
const { discoveredPageVerdict } = require('./lib/discovered-page-verdict');
const { isLegacyWebSearchOnly } = require('./lib/legacy-web-search');
const { parseDate } = require('./lib/date-utils');
const { evaluateShowScorePreviousProduction } = require('./lib/date-guard');
const { findExistingFileForUrl, decideSameUrlDifferentFileGuard } = require('./lib/review-url-clusters');
const { markRescoreNeeded } = require('./lib/rescore-flagging');

/**
 * Rename a review-text file to match its in-memory criticName when one of the
 * three criticName-override branches in updateReviewJson() (1A-bis HC override,
 * 1B byline cross-check, 1B-iii Unknown→real-name enrichment) changes the
 * canonical filename.
 *
 * Conflict-mode design (post PR #290 revert, 2026-04-29):
 * - On clean rename (dst doesn't exist): route through safeRenameReview which
 *   honors source `_locked` and updates the llm-scores sidecar + sibling
 *   duplicateTextOf pointers. Update review.filePath so the trailing
 *   updateReviewJson write lands at the new path.
 * - On conflict (dst exists): leave source untouched. Set data.duplicateOf =
 *   newFilename so validate-review-texts.js's skip-gate (line 185) catches
 *   the file before reviews.json. The trailing write at line ~4987 picks
 *   that up. Crucially, review.filePath stays at the SOURCE path — that's
 *   what kills the "merge undone by line 5069" bug PR #290 fell to.
 *
 * @param {object} review - The in-flight review object (mutates review.filePath)
 * @param {object} data - The in-memory review data (mutates data.duplicateOf on conflict)
 * @param {string} extractedAuthor - The new canonical critic name
 * @returns {{ action: 'noop'|'renamed'|'conflict'|'skipped-locked', newFile?: string }}
 */
function renameReviewFileForCriticOverride(review, data, extractedAuthor) {
  if (!review.filePath || !extractedAuthor) {
    return { action: 'noop' };
  }
  const currentFile = path.basename(review.filePath);
  const showDir = path.dirname(review.filePath);
  const outletId = normalizeOutlet(data.outletId || data.outlet);
  const newFilename = generateReviewFilename(outletId, extractedAuthor);

  if (newFilename === currentFile) {
    return { action: 'noop' };
  }

  // Same URL already promoted under a DIFFERENT critic name/file — rotating-byline
  // outlets (Times UK, WhatsOnStage: a "more from our critics" recirc widget) return
  // a different extracted byline on the SAME url across fetches, so the exact-filename
  // check below only catches a collision with the freshly-computed newFilename; it
  // misses a sibling already promoted under some OTHER name for this url. That gap is
  // the byline-explosion root cause (BRO-1391), fixed for the _pending drain in
  // replay-pending-bylines.js and shared here (BRO-3550) so this 3x-daily primary
  // collection pipeline gets the same protection instead of minting a second primary.
  //
  // The decision on whether to actually mark duplicate is delegated to
  // shouldMarkUrlCollisionDuplicate — the SAME check safeWriteReview's own URL-collision
  // path uses — rather than marking unconditionally: an empty/near-empty sibling found
  // first must never bury a substantive recovered review, and a prior deliberate
  // _duplicateOfCleared must never be silently re-flagged (ship-check, Codex review).
  const showId = data.showId || review.showId;
  if (data.url && showId) {
    const existingSameUrl = findExistingFileForUrl(CONFIG.reviewTextsDir, showId, outletId, data.url, currentFile);
    let colliderData = null;
    if (existingSameUrl && existingSameUrl !== currentFile && existingSameUrl !== newFilename) {
      try {
        colliderData = JSON.parse(fs.readFileSync(path.join(showDir, existingSameUrl), 'utf8'));
      } catch { /* unreadable collider — shouldMarkUrlCollisionDuplicate treats null as "mark" (historical behavior) */ }
    }
    const guardResult = decideSameUrlDifferentFileGuard({
      currentFile, newFilename, existingSameUrl, newData: data, colliderData,
      shouldMarkDuplicate: shouldMarkUrlCollisionDuplicate,
    });
    if (guardResult) {
      data.duplicateOf = guardResult.duplicateOf;
      data.duplicateTextOf = guardResult.duplicateOf;
      data.duplicateReason = guardResult.duplicateReason;
      delete data.duplicateClearReason;
      console.warn(`    ⚠ Same URL already promoted as ${guardResult.duplicateOf} — marking ${currentFile} duplicateOf instead of renaming to ${newFilename}`);
      return { action: 'conflict', newFile: guardResult.duplicateOf };
    }
  }

  const newPath = path.join(showDir, newFilename);
  if (fs.existsSync(newPath)) {
    // Conflict: do NOT merge, do NOT delete source. Mark this file as a
    // duplicate so validate-review-texts skips it, and let the operator
    // (or the dedup audit) decide which file is canonical.
    data.duplicateOf = newFilename;
    data.duplicateReason = 'criticName-override-collided-at-rename';
    console.warn(`    ⚠ Rename conflict: ${currentFile} → ${newFilename} already exists. Marking duplicateOf=${newFilename}; source kept at ${currentFile} for triage.`);
    return { action: 'conflict', newFile: newFilename };
  }

  // Merge our edits onto the current source before moving it, then rebase
  // data at the new path for updateReviewJson's trailing snapshot write.
  const result = renameReviewSnapshot({ filePath: review.filePath, data }, newPath);
  if (result.skipped === 'locked') {
    console.warn(`    ⚠ Rename refused: ${currentFile} is _locked. Leaving filename as-is; criticName mismatch will be caught by validate-review-texts on next CI run.`);
    return { action: 'skipped-locked' };
  }
  if (result.skipped === 'conflict') {
    // TOCTOU: another writer created newPath after our existsSync check.
    data.duplicateOf = newFilename;
    data.duplicateReason = 'criticName-override-collided-at-rename';
    return { action: 'conflict', newFile: newFilename };
  }
  if (!result.wrote) {
    console.warn(`    ⚠ Rename skipped (${result.skipped}): ${result.error || ''}`);
    return { action: 'noop' };
  }

  review.filePath = newPath;
  console.log(`    → Renamed ${currentFile} → ${newFilename}`);
  return { action: 'renamed', newFile: newFilename };
}

// Domain-specific tier ordering — prioritizes tiers by historical success rate per domain.
// Generated from 30K+ review collection results. Tiers not listed for a domain stay in default order.
const DOMAIN_TIER_ORDER = (() => {
  try {
    return require('./config/domain-tier-order.json');
  } catch { return {}; }
})();

// Domain-specific tier skip list — tiers with 3+ failures and 0 successes per domain.
// These are proven dead ends. Skipping saves 15-30s per tier per review.
const { getSkippedTiers } = require('./lib/domain-tier-skip');
// BRO-4334: hard-paywall completeness gate (tier loop + contentTier override)
const {
  decideTierResult: decidePaywallTierResult,
  assessPaywallCompleteness,
  isHardPaywallUrl,
  shouldKeepStoredText,
  escalateAfterPartial,
  needsPaywallRecheck,
  truncatedTierPatch,
  SCRAPED_SOURCE_METHODS,
} = require('./lib/paywall-completeness');
const DOMAIN_TIER_SKIP = (() => {
  try {
    return require('./config/domain-tier-skip.json');
  } catch { return {}; }
})();

// --- Domains where ScrapingBee needs premium_proxy + render_js=true ---
// Two categories: (1) JS-rendered content, (2) paywalled sites that forward subscriber cookies.
// All other domains use render_js=false with no premium_proxy → 1 credit (was 10).
const SB_PREMIUM_DOMAINS = new Set([
  // JS-rendered content
  'show-score.com',         // React SPA
  'theatermania.com',       // Dynamic content loading
  // Cookie-forwarding paywalled outlets (premium_proxy needed for reliable delivery)
  'wsj.com', 'newyorker.com', 'nytimes.com', 'vulture.com', 'nymag.com',
  'washingtonpost.com', 'ft.com', 'timeout.com', 'nypost.com', 'nydailynews.com',
  'deadline.com', 'observer.com', 'hollywoodreporter.com', 'variety.com',
  'indiewire.com', 'ew.com', 'huffpost.com', 'huffingtonpost.com',
  'usatoday.com', 'northjersey.com', 'bloomberg.com', 'thestage.co.uk',
  'backstage.com', 'telegraph.co.uk', 'thetimes.co.uk', 'thetimes.com',
  'standard.co.uk', 'independent.co.uk', 'chicagotribune.com', 'thewrap.com',
  'nbcnewyork.com', 'newsday.com',
]);

// Per-run SB page credit budget — prevents runaway spending.
// For bulk backfills, override: SB_PAGE_CREDIT_BUDGET=1000 node scripts/collect-review-texts.js ...
// Strict parse at startup (BRO-3009 ship-check): a malformed value must kill
// the run here, not surface later as a thrown tier error — the tier runner
// catches those and falls through to Bright Data, turning an operator typo
// into a silent, pricier reroute. parseInt alone would read '200oops' as 200.
const SB_PAGE_CREDIT_BUDGET = resolveSbPageCreditBudget(process.env.SB_PAGE_CREDIT_BUDGET, 200);

// Parse CLI arguments
const args = process.argv.slice(2);
const CLI = {
  aggressive: args.includes('--aggressive'),
  forceTier: args.find(a => a.startsWith('--tier='))?.split('=')[1],
  testUrl: args.find(a => a.startsWith('--test-url='))?.split('=')[1],
  stealthProxy: args.includes('--stealth-proxy'), // Use ScrapingBee stealth proxy (25 credits/req)
  // LLM verification now runs by default when ANTHROPIC_API_KEY is available (no opt-in needed)
};

// Dependencies (loaded dynamically)
let chromium, axios;
let stealthLoaded = false;

async function loadDependencies() {
  console.log('Loading dependencies...');

  // Try playwright-extra with stealth
  try {
    const { createCollectorChromium } = require('./lib/collector-chromium');
    const stealth = require('puppeteer-extra-plugin-stealth')();
    chromium = createCollectorChromium();
    chromium.use(stealth);
    stealthLoaded = true;
    console.log('✓ Loaded playwright-extra with stealth plugin');
  } catch (e) {
    // Fallback to regular playwright
    console.log('⚠ playwright-extra not available, using regular playwright');
    console.log('  Install with: npm install playwright-extra puppeteer-extra-plugin-stealth');
    const playwright = require('playwright');
    chromium = playwright.chromium;
  }

  // Load axios for API tiers
  try {
    axios = require('axios');
    console.log('✓ Loaded axios for API fallbacks');
  } catch (e) {
    console.log('⚠ axios not available - Tiers 2-4 disabled');
    console.log('  Install with: npm install axios');
  }
}

// Configuration
// BRO-2691: SHOW_FILTER scope helpers (pure, unit-tested)
const { isShowFilterActive, parseShowFilter, isInShowScope, showIdOfReviewId, summarizeRunScope } = require('./lib/show-scope.js');
/** REVIEW_TIMEOUT_SEC -> ms, clamped to 30-300s; anything unset or unreadable keeps 90s. */
function reviewTimeoutMs(raw) {
  const sec = Number(raw);
  if (!raw || !Number.isFinite(sec)) return 90000;
  return Math.min(300, Math.max(30, Math.round(sec))) * 1000;
}

const CONFIG = {
  batchSize: parseInt(process.env.BATCH_SIZE || '10'),
  pushEveryNBatches: parseInt(process.env.PUSH_EVERY_N_BATCHES || '5'), // Push every N batches (default: every 50 reviews)
  maxReviews: parseInt(process.env.MAX_REVIEWS || '1000'),
  priority: process.env.PRIORITY || 'all',
  showFilter: process.env.SHOW_FILTER || '',
  showFilterSet: parseShowFilter(process.env.SHOW_FILTER),
  retryFailed: process.env.RETRY_FAILED === 'true',
  commitEvery: parseInt(process.env.COMMIT_EVERY || '10'), // Git commit after every N reviews
  // BRO-2983: throttles ONLY the public-repo push cadence (data/collection-state/),
  // decoupled from pushEveryNBatches which still governs the private review-texts
  // repo checkpoint. Was batch-count-based (every 5 batches), landing ~267
  // separate "chore: Checkpoint" commits/day on main and starving other jobs'
  // pushes. See commitChanges() below.
  mainPushIntervalMs: (() => {
    const n = parseInt(process.env.MAIN_PUSH_INTERVAL_MIN, 10);
    return (Number.isFinite(n) && n > 0 ? n : 30) * 60 * 1000;
  })(),
  outletTier: process.env.OUTLET_TIER || '', // Filter by outlet tier: tier1, tier2, tier3
  contentTierFilter: process.env.CONTENT_TIER_FILTER || '', // Filter by content tier: excerpt, truncated, needs-rescrape
  domainFilter: (process.env.DOMAIN_FILTER || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean), // Filter by URL domain(s)
  excludeDomains: (process.env.EXCLUDE_DOMAINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean), // Exclude these domains
  incompleteReasonFilter: (process.env.INCOMPLETE_REASON_FILTER || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean), // Filter by incompleteReason
  marketFilter: process.env.MARKET_FILTER || '', // Filter by market: west-end, off-broadway (matches show ID suffix)
  // Specific review files: bare filename, showId/file, or force:<entry> to
  // refetch over existing text (scripts/lib/review-filter.js, BRO-5090).
  reviewFilter: require('./lib/review-filter').parseReviewFilter(process.env.REVIEW_FILTER),
  archiveFirst: process.env.ARCHIVE_FIRST !== 'false', // Archive.org first for older reviews (opt-OUT via ARCHIVE_FIRST=false)
  // Opt-in wall-clock budget (ms). Unset by default so long-running callers
  // (bulk-collect-review-texts.yml: timeout-minutes 300+, collect-review-texts.yml: 120)
  // are unaffected. Callers wrapping this in a short external timeout-minutes
  // (e.g. opening-night-poller.yml's 10-min step) should set this a bit under
  // that, so the run exits 0 with a clean checkpoint instead of being SIGKILLed
  // mid-batch — an external kill under `continue-on-error` reports the step
  // outcome as 'failure' and pages as a crash even though nothing broke, just
  // ran out of time (task #1911 follow-up, 2026-08-23).
  maxDurationMs: process.env.MAX_DURATION_MS ? parseInt(process.env.MAX_DURATION_MS) : 0,

  // API Keys
  scrapingBeeKey: process.env.SCRAPINGBEE_API_KEY || '',
  brightDataKey: process.env.BRIGHTDATA_TOKEN || '',
  brightDataCustomerId: process.env.BRIGHTDATA_CUSTOMER_ID || '',
  browserbaseApiKey: process.env.BROWSERBASE_API_KEY || '',
  browserbaseProjectId: process.env.BROWSERBASE_PROJECT_ID || '',

  // Browserbase spending limits (to control costs - $0.10/session).
  // Empirical April 2026 baseline (peak opening-night month): median 84/day, p95
  // 199/day, max 275/day (April 26, Joe Turner). Cap of 250 covers the empirical
  // max with 0 historical clip days; cap of 200 would have clipped April 26 alone.
  // Feb 2026 runaway: max 2,448/day = $244.80 in one day, $1,548 in one week.
  // The 250/day hard ceiling means worst-case month = $750 instead of unbounded.
  browserbaseEnabled: process.env.BROWSERBASE_ENABLED === 'true',
  // Emergency kill switch (#312): flip BROWSERBASE_KILL_SWITCH=true as a repo/org
  // variable to disable Browserbase globally without a code change or redeploy —
  // same pattern as the SB SERP exhaustion breaker (#201). Checked first in
  // canUseBrowserbase(), ahead of every other gate.
  browserbaseKillSwitch: process.env.BROWSERBASE_KILL_SWITCH === 'true',
  // Shared with lib/bww-rr-discover.js via the one constant in
  // lib/browserbase-caps.js — both cap the SAME account (Scraping v2 T13).
  browserbaseMaxSessionsPerDay: resolveMaxSessionsPerDay(), // $25/day ceiling = $750/mo MAX; normal $5-9/day
  browserbaseMaxSessionsPerRun: parseInt(process.env.BROWSERBASE_MAX_SESSIONS_PER_RUN || '30'), // Per workflow run; matches typical opening-night batch
  browserbaseMaxSessionsPerDomain: parseInt(process.env.BROWSERBASE_MAX_SESSIONS_PER_DOMAIN || '10'), // Prevent one paywalled outlet monopolizing
  // BRO-5222: the last BROWSERBASE_RECOVERY_RESERVE sessions of the day are
  // held for runs started with BROWSERBASE_USE_RESERVE=true.
  browserbaseRecoveryReserve: resolveRecoveryReserve(),
  browserbaseUseReserve: resolveUseReserve(),
  browserbaseUsageFile: 'data/collection-state/browserbase-usage.json',

  // Directories
  reviewTextsDir: 'data/review-texts',
  archivesDir: 'data/archives/reviews',
  stateDir: 'data/collection-state',
  auditDir: 'data/audit/validation',

  // Tier 1 outlets (highest priority for scoring - weight 1.0)
  tier1Outlets: ['nytimes', 'nyt', 'vulture', 'vult', 'variety', 'hollywood-reporter', 'thr', 'newyorker'],

  // Tier 2 outlets (weight 0.70)
  tier2Outlets: ['theatermania', 'nypost', 'new-york-post', 'time-out', 'timeout', 'wsj', 'wapo', 'washington-post', 'deadline', 'the-wrap', 'thewrap', 'observer', 'daily-beast', 'ew', 'entertainment-weekly', 'guardian'],

  // Tier 3 outlets (weight 0.40 - blogs and smaller sites)
  tier3Outlets: ['theatrely', 'broadway-news', 'cititour', 'culture-sauce', 'stage-and-cinema', 'forward', 'ny-stage-review', 'new-york-stage-review', 'am-new-york', 'chicago-tribune', 'nj-arts', 'dctheatrescene', 'talkin-broadway'],

  // Paywalled domains and their credential env vars
  paywalledDomains: {
    'nytimes.com': { emailVar: 'NYT_EMAIL', passVar: 'NYT_PASSWORD', altPassVar: 'NYTIMES_PASSWORD' },
    'vulture.com': { emailVar: 'VULTURE_EMAIL', passVar: 'VULTURE_PASSWORD' },
    'nymag.com': { emailVar: 'VULTURE_EMAIL', passVar: 'VULTURE_PASSWORD' },
    'newyorker.com': { emailVar: 'NEW_YORKER_EMAIL', passVar: 'NEW_YORKER_PASSWORD' },
    'washingtonpost.com': { emailVar: 'WAPO_EMAIL', passVar: 'WAPO_PASSWORD', altPassVar: 'WASHPOST_PASSWORD' },
    'wsj.com': { emailVar: 'WSJ_EMAIL', passVar: 'WSJ_PASSWORD' },
    'bloomberg.com': { emailVar: 'BLOOMBERG_EMAIL', passVar: 'BLOOMBERG_PASSWORD' },
    'northjersey.com': { emailVar: 'NORTHJERSEY_EMAIL', passVar: 'NORTHJERSEY_PASSWORD' },
    'usatoday.com': { emailVar: 'NORTHJERSEY_EMAIL', passVar: 'NORTHJERSEY_PASSWORD' },
    // thestage.co.uk: cookie-only auth (no email/password login — avoids session limit)
    'ft.com': { emailVar: 'FT_EMAIL', passVar: 'FT_PASSWORD' },
  },

  // Sites that require Browserbase (Cloudflare/CAPTCHA/SSO blocks that BD/SB/Playwright can't solve)
  // Keep this list tight — each session costs ~$0.10. Legacy entries without documented blockers removed.
  knownBlockedSites: [
    'nytimes.com',        // DataDome CAPTCHA in headless
    'wsj.com',            // Dow Jones SSO anti-bot — fake-rejects correct password in automated browsers
    'newyorker.com',      // Condé Nast id.condenast.com — routes automated browsers to OTP, not password login
    'hollywoodreporter.com', 'variety.com', 'deadline.com', // PMC sites — CAPTCHA-block Playwright consistently
    'bloomberg.com',      // PerimeterX anti-bot
    'ft.com',             // hCaptcha on login
    'talkinbroadway.com', // Cloudflare managed challenge — BD/SB/Playwright all fail
    'seenandheard-international.com', // Cloudflare managed challenge — BD/SB/Playwright all fail (2026-07-13)
  ],

  // Sites that need residential proxies (Bright Data preferred)
  brightDataPreferred: [
    'nytimes.com', 'vulture.com', 'nymag.com', 'washingtonpost.com',
    'wsj.com', 'newyorker.com',
  ],

  // Sites where Archive.org works best (paywalled sites - Wayback often has pre-paywall content)
  // SUCCESS RATES (2026-01-27): Archive.org 11.1%, Playwright 6.7%, ScrapingBee 3.6%, BrightData 3.7%
  // Archive.org is our MOST SUCCESSFUL scraper - prioritize it for these domains
  archiveFirstSites: [
    // Major paywalled publications
    'nytimes.com', 'vulture.com', 'nymag.com', 'washingtonpost.com',
    'wsj.com', 'newyorker.com', 'ew.com', 'latimes.com',
    // Entertainment/trade publications (free content, but archive useful for old/deleted URLs)
    'rollingstone.com',
    // Regional papers with paywalls
    'chicagotribune.com', 'nypost.com', 'nydailynews.com',
    // Sites where Archive.org has proven successful
    'theatrely.com', 'amny.com', 'forward.com',
    // Sites with CAPTCHA that block Playwright
    'timeout.com',
    // BroadwayNews: WordPress paywall, but Archive.org has excellent coverage (7-8 snapshots per URL)
    'broadwaynews.com',
    // Free outlets with excellent Archive.org coverage (6K+ / 9K+ pages archived)
    'talkinbroadway.com', 'huffpost.com',
    // Hard-paywall sites — Playwright/ScrapingBee/BrightData can't crack these anyway
    'usatoday.com', 'northjersey.com',   // Gannett paywall
    'bloomberg.com',                      // Hard paywall
    'backstage.com',                      // Paywall + JSP URLs
    'thestage.co.uk',                     // UK theater paywall
    // UK paywalls + FT — in SB_PREMIUM_DOMAINS but archive-first saves credits
    'ft.com', 'telegraph.co.uk', 'thetimes.co.uk', 'thetimes.com',
    'standard.co.uk', 'independent.co.uk',
    // Smaller paywalled outlets surfaced via SERP
    'nysun.com', 'spectator.co.uk', 'thejc.com',
  ],

  // Minimum word count for valid review
  minWordCount: 300,

  // Timeouts
  loginTimeout: 90000,    // 90s for slow logins
  pageTimeout: 60000,     // 60s for page load
  apiTimeout: 20000,      // 20s for API calls (Archive.org/scrapers respond fast or not at all)
  // 90s hard timeout per review (kills hung Playwright/Browserbase). A targeted
  // retry run may raise it with REVIEW_TIMEOUT_SEC (30-300s, BRO-5243).
  reviewTimeout: reviewTimeoutMs(process.env.REVIEW_TIMEOUT_SEC),

  // Retry settings
  maxRetries: 3,
  retryDelays: [2000, 4000, 8000], // Exponential backoff

  // Request delays
  requestDelay: 500,      // 500ms between reviews (polite but not wasteful)
  // Note: outletDomains mapping is now derived from outlet-registry.json
  // in url-discovery.js (single source of truth, 1,242 entries)
};

// Uncollectable outlets: built from outlet-registry.json accessModel field.
// Outlets marked 'print-only' or 'defunct' have no online content — skip SERP discovery.
// Single source of truth: outlet-registry.json (shared with collect-outlet-reviews.js).
const UNCOLLECTABLE_OUTLETS = (() => {
  const set = new Set();
  try {
    const registryPath = path.join(__dirname, '..', 'data', 'outlet-registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    for (const [id, info] of Object.entries(registry.outlets || {})) {
      if (info.accessModel === 'print-only' || info.accessModel === 'defunct') {
        set.add(id);
      }
    }
    console.log(`Loaded ${set.size} uncollectable outlets from registry (print-only + defunct)`);
  } catch (e) {
    console.warn('Warning: Could not load outlet-registry.json for uncollectable outlets:', e.message);
  }
  return set;
})();

// Registry for the 1C dedupe's own-domain check (BRO-5254). Read once, lazily;
// null (unreadable) makes hostMatchesOutletDomain return null, which keeps the
// old always-mark behaviour.
let _dedupeOutletRegistry;
function loadOutletRegistryForDedupe() {
  if (_dedupeOutletRegistry === undefined) {
    try {
      _dedupeOutletRegistry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'outlet-registry.json'), 'utf8'));
    } catch {
      _dedupeOutletRegistry = null;
    }
  }
  return _dedupeOutletRegistry;
}

// BRO-4807: opening-night lane reviews (provenance + productionVerified:"aggregator") stand down for the
// classifiers and the headline backstop below; laneBypasses is the one predicate, this only adds openingDate.
function laneHeld(rec, guard) {
  // The collection queue item carries only filePath/showId/url, not the stamp: read it from the review file.
  if (rec && rec.filePath && !rec.productionVerified) {
    try { rec = JSON.parse(fs.readFileSync(rec.filePath, 'utf8')); } catch (e) { return false; }
  }
  const show = rec && _showsJsonCache && _showsJsonCache.shows && _showsJsonCache.shows.find((x) => x.id === rec.showId);
  return laneBypasses(rec, guard, show && show.openingDate ? { openingDate: show.openingDate } : {});
}

// BRO-4058 follow-up (2026-09-22): outlets whose <title>/og:title tag is
// systemically unreliable — confirmed live for pages-on-stages, where the
// <title> consistently reflects a DIFFERENT post than the one at the fetched
// URL (a theme/widget bug, not a per-post fluke: verified on 2 independent
// URLs). Passing that html to validateContentMentionsShow's <title>
// cross-check risks a false url_content_mismatch reject whenever the wrong
// title happens to collide with a real catalog show (birthright-off-broadway-
// 2026: <title> read "The Heart", a real different show). Body-mention
// evidence alone (htmlTitleMatch=null path, already the no-HTML behavior)
// is the reliable signal for these outlets.
const UNRELIABLE_TITLE_OUTLETS = new Set(['pages-on-stages']);

// Domain alias matching — imported from shared lib (scraper.js)
const { domainMatchesExpected, checkScrapingBeeCredits, getScraperStats, fetchWithScrapingdog, isTollbitGate } = require('./lib/scraper');
const { isSoft404Body } = require('./lib/soft-404-body');
const { shouldCountFailure, isPermanentlyFailed, shouldReopenStaleContentMismatch, classifyFetchFailure, routeCapFromBrowserbaseError, applyRouteCapDeferralLimit, isRouteCapCooldownActive, effectiveFailureReason, isOwnCodeException } = require('./lib/failed-fetch-policy');
const { consultBrightData } = require('./lib/brightdata-caps');
const { recordBdCall } = require('./lib/bd-telemetry');
const { recordSbCall, sbBilledCredits } = require('./lib/provider-telemetry');
const { sbHostCooldown } = require('./lib/scrapingbee-host-cooldown');
const { discoverCorrectUrl: _sharedDiscoverUrl } = require('./lib/url-discovery');
const { shouldRetryUrlDiscovery, recordSerpAttempt, shouldRetryFetch, recordFetchAttempt, shouldBypassFetchGate, isFetchLedgerEntryForOtherUrl } = require('./lib/review-guards');
const { clearFailureFlags } = require('./lib/clear-failure-flags');
const { clearAutomatedTextRejectionOnRefetch, isRejectedRefetchOnHold } = require('./lib/stale-automated-text-verdict');
const { neutralizeStaleFlagsOnBodyReplacement } = require('./lib/stale-flag-neutralization');
const { emitStage } = require('./lib/stage-latency');

// Outlet-specific Playwright wait configurations
// Some outlets render content via JS and need specific selectors/waits
const OUTLET_WAIT_CONFIGS = {
  'broadwaynews.com': {
    waitForSelector: '.entry-content',
    waitTimeout: 20000,
    extraWait: 5000,   // BroadwayNews renders article via JS; extra wait for content
  },
  'broadwayworld.com': {
    waitForSelector: '.article-body, .bsp-article-content',
    waitTimeout: 15000,
    extraWait: 3000,
  },
  'timeout.com': {
    waitForSelector: '[class*="_articleContent_"], [class*="_content_"]',
    waitTimeout: 15000,
    extraWait: 2000,
  },
  // PMC sites (Variety, THR, Deadline) - free content, standard WordPress rendering
  'variety.com': {
    waitForSelector: '.a-content, .entry-content, article',
    waitTimeout: 15000,
    extraWait: 2000,
  },
  'hollywoodreporter.com': {
    waitForSelector: '.a-content, .entry-content, article',
    waitTimeout: 15000,
    extraWait: 2000,
  },
  'deadline.com': {
    waitForSelector: '.entry-content, article',
    waitTimeout: 15000,
    extraWait: 2000,
  },
  // Condé Nast - New Yorker uses specific body container
  'newyorker.com': {
    waitForSelector: '.body__inner-container, [class*="BodyWrapper"]',
    waitTimeout: 20000,
    extraWait: 3000,
  },
};

// ============================================================================
// COOKIE INJECTION (bypass paywall login via exported browser cookies)
// ============================================================================
// Cookie loading is centralized in scripts/lib/cookie-loader.js
// Provides 3-tier fallback: COOKIES_BUNDLE_* → individual env vars → local files

// Domains where login triggers OTC/OTP emails — use cookie injection ONLY, never attempt login.
// thestage.co.uk: session-limited hard paywall, email/password auth was removed — secrets deleted.
// See memory/feedback_stage_cookie_only.md.
const COOKIE_ONLY_DOMAINS = ['newyorker.com', 'thestage.co.uk'];

/**
 * Inject cookies into a Playwright browser context.
 * Filters cookies to ensure they have required fields for Playwright's addCookies().
 */
async function injectCookies(browserContext, domain) {
  const cookies = loadCookiesForDomain(domain);
  if (!cookies || cookies.length === 0) return false;

  try {
    // Ensure each cookie has the minimum required fields for Playwright
    const validCookies = cookies
      .filter(c => c.name && c.value && c.domain)
      .map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        httpOnly: c.httpOnly !== undefined ? c.httpOnly : false,
        secure: c.secure !== undefined ? c.secure : true,
        sameSite: c.sameSite || 'None',
        // Playwright needs expires as a Unix timestamp (seconds), not ms
        ...(c.expires && c.expires > 0 ? { expires: c.expires > 1e12 ? Math.floor(c.expires / 1000) : c.expires } : {}),
      }));

    if (validCookies.length === 0) {
      console.log(`  ⚠ No valid cookies found for ${domain} (missing name/value/domain)`);
      return false;
    }

    await browserContext.addCookies(validCookies);
    console.log(`  🍪 Injected ${validCookies.length} cookies for ${domain}`);
    return true;
  } catch (e) {
    console.log(`  ⚠ Failed to inject cookies for ${domain}: ${e.message}`);
    return false;
  }
}

// Track domains where cookies have been injected (to skip login)
const cookieInjectedDomains = new Set();

// Statistics tracking
const stats = {
  tier1Attempts: 0,
  tier1Success: 0,
  tier1_5Attempts: 0,  // Browserbase
  tier1_5Success: 0,
  tier1_9Attempts: 0,  // Scrapingdog
  tier1_9Success: 0,
  tier2Attempts: 0,
  tier2Success: 0,
  tier3Attempts: 0,
  tier3Success: 0,
  tier3_6Attempts: 0,  // Archive.today
  tier3_6Success: 0,
  tier4Attempts: 0,
  tier4Success: 0,
  ampAttempts: 0,      // AMP variant
  ampSuccess: 0,
  totalFailed: 0,
  scrapingBeePageCredits: 0,
  scrapingBeeSerpCredits: 0,
  browserbaseSessionsUsed: 0,
  browserbaseMinutesUsed: 0,
  // Track failures by outlet for end-of-run reporting
  failuresByOutlet: {},  // { outletName: { count, urls: [], domain, hasCredentials, isPaywalled } }
  // URL discovery stats
  urlDiscoveryAttempts: 0,
  urlDiscoverySuccess: 0,
  urlDiscoveryCapped: 0,  // Skipped due to per-run cap
  urlDiscoveryDetails: [],  // { reviewId, oldUrl, newUrl }
  // Cookie expiry tracking — aggregates _cookiesExpired flags from all tier executions.
  // When paywall cookies expire (NYT, Vulture, WSJ, New Yorker), the direct-cookie tier
  // fails silently and reviews degrade to ScrapingBee/BrightData — the worst tiers.
  // (Postmortem audit fix: _cookiesExpired was set but never read.)
  cookieExpiries: {},  // { outletDomain: count }
  cookieExpiryCount: 0,
};

// Reviews abandoned by the per-review REVIEW_TIMEOUT this run (BRO-4273).
// Run-local, not persisted: they are in state.failed too and retried next run.
const timedOutReviews = [];

// State tracking
// BRO-2691: this-process attempts (state.* is cumulative across resumed runs).
const runProcessed = [];
const runFailed = [];
let resumedCounts = { processed: 0, failed: 0 };
let state = {
  processed: [],
  failed: [],
  skipped: [],
  tierBreakdown: {
    playwright: [],
    amp: [],
    browserbase: [],
    directCookies: [],
    scrapingdog: [],
    scrapingbee: [],
    brightdata: [],
    archiveToday: [],
    archive: [],
  },
  startTime: new Date().toISOString(),
  lastProcessed: null,
  log: [],  // Recent activity log for real-time monitoring
};

// Browserbase usage tracking (persisted to disk)
// In-memory only (never saved with browserbaseUsage): set when the session-
// create chokepoint refuses for the day, so later rows in this run skip it.
let browserbaseChokepointCapped = false;
// BRO-5243: set when the chokepoint holds the recovery reserve back from a
// non-Tier-1 host. Later non-Tier-1 rows skip; WSJ/NYT/New Yorker still run.
let browserbaseReserveHeld = false;
let browserbaseUsage = {
  date: new Date().toISOString().split('T')[0],
  sessionsToday: 0,
  sessionsThisRun: 0,
  minutesToday: 0,
  sessionsPerDomain: {},  // { 'wsj.com': 3, 'nytimes.com': 2, ... } — per-run cap prevents starvation
  history: [],
};

// Archive.org rate-limit tracking (backoff with cooldown instead of permanent disable)
let archiveOrgConsecutiveFailures = 0;
let archiveOrgDisabledForBatch = false;
let archiveOrgCooldownCount = 0; // How many times we've hit the cooldown threshold
let archiveOrgLastRequestTime = 0; // Timestamp of last Archive.org API call
const ARCHIVE_ORG_MIN_DELAY_MS = 1500; // 1.5s between requests to avoid rate limits
const ARCHIVE_ORG_COOLDOWN_THRESHOLD = 3; // Consecutive failures before cooldown
const ARCHIVE_ORG_COOLDOWN_MS = 15000; // 15s cooldown after hitting threshold
const ARCHIVE_ORG_MAX_COOLDOWNS = 3; // After 3 cooldowns (9+ failures), disable for batch

// Browser and context (reused)
let browser = null;
let context = null;
let page = null;
const loggedInDomains = new Set();
let browserCrashCount = 0;
const MAX_BROWSER_CRASHES = 5;

// Bumped by closeBrowser()/setupBrowser() on every restart attempt. Three
// call sites (ensureBrowserHealthy, the REVIEW_TIMEOUT handler, processReview's
// fresh-page fallback) can each independently trigger a restart with no mutex
// between them; withTimeout() bounds the WAIT but never cancels the underlying
// browser.close()/chromium.launch(), so a "timed out" restart can still finish
// in the background later. Without this guard it would silently overwrite
// browser/context/page with a stale instance after a newer restart already
// succeeded. setupBrowser() checks its captured generation before committing
// to the module globals; a stale one tears itself down instead.
let browserGeneration = 0;
// BRO-4273: set once main() starts its final cleanup. A review abandoned by
// REVIEW_TIMEOUT keeps running in the background, and its own browser-restart
// path used to launch a fresh Chromium AFTER main() closed the last one; that
// orphan child process kept node alive until the CI step's 12-min kill
// (reproduced locally against a never-responding URL).
let collectorShuttingDown = false;

// ============================================================================
// PAGE HELPERS (scroll, paywall dismissal)
// ============================================================================

/**
 * Scroll to bottom of page to trigger lazy-loaded content.
 * Uses incremental scrolling to mimic human behavior and trigger scroll-based loaders.
 */
async function autoScroll(page) {
  try {
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 400;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= document.body.scrollHeight || totalHeight > 15000) {
            clearInterval(timer);
            // Scroll back to top so extraction starts from beginning
            window.scrollTo(0, 0);
            resolve();
          }
        }, 100);
      });
    });
  } catch (e) {
    // Non-fatal - continue with extraction even if scroll fails
  }
}

/**
 * Try to dismiss paywall overlays and expand hidden article content.
 * Handles common paywall patterns from NYT, Vulture/Condé Nast, WSJ, WaPo.
 */
async function dismissPaywallOverlays(page) {
  try {
    await page.evaluate(() => {
      // Remove common paywall overlay elements
      const overlaySelectors = [
        // NYT
        '[data-testid="paywall"]', '[data-testid="inline-message"]',
        '#gateway-content', '.css-mcm29f', '[class*="paywall"]',
        // Condé Nast (Vulture, New Yorker, NY Mag)
        '[class*="PaywallBarrier"]', '[class*="paywall-bar"]',
        '[data-testid="PaywallBarrier"]', '.paywall-bar',
        '[class*="PaywallModal"]', '.paywall-modal',
        '[class*="consumer-marketing-unit"]',
        '[class*="RecircList"]', '.recirc-list-wrapper',
        // WSJ
        '.wsj-snippet-login', '#cx-snippet-overlay', '[class*="snippet"]',
        // WaPo
        '[data-qa="subscribe-promo"]', '.paywall-overlay',
        // Generic
        '[id*="paywall"]', '[class*="subscription-wall"]',
        '[class*="meter-"]', '.overlay-gate', '#piano-modal',
        '[class*="PianoBarrier"]',
      ];

      for (const sel of overlaySelectors) {
        document.querySelectorAll(sel).forEach(el => el.remove());
      }

      // Unhide article content that may be CSS-hidden behind paywall
      const hiddenContentSelectors = [
        // NYT: article body paragraphs after paywall cutoff
        'article p[style*="display: none"]',
        'article p[style*="visibility: hidden"]',
        // Generic hidden sections
        '[class*="article-body"] [hidden]',
        '[class*="ArticleBody"] [hidden]',
        '[data-testid="article-body"] [hidden]',
      ];

      for (const sel of hiddenContentSelectors) {
        document.querySelectorAll(sel).forEach(el => {
          el.style.display = '';
          el.style.visibility = '';
          el.removeAttribute('hidden');
        });
      }

      // Remove overflow:hidden from body (some paywalls lock scrolling)
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';

      // Try to expand "continue reading" or "read more" sections
      const expandButtons = document.querySelectorAll(
        '[class*="continue-reading"], [class*="read-more"], [class*="expand"], [data-testid="continue-reading"]'
      );
      expandButtons.forEach(btn => {
        try { btn.click(); } catch(e) {}
      });
    });

    // Brief wait for any content expansion to render
    await page.waitForTimeout(500);
  } catch (e) {
    // Non-fatal
  }
}

// ============================================================================
// TIER 1: Playwright with Stealth Plugin
// ============================================================================

async function fetchWithPlaywright(url, review) {
  stats.tier1Attempts++;

  // Ensure browser is healthy before attempting
  const browserOk = await ensureBrowserHealthy();
  if (!browserOk) {
    throw new Error('Browser unavailable - too many crashes');
  }

  // Check for paywall and login if needed
  // Skip login entirely if cookies exist for this domain (avoids OTC email spam)
  // Also skip login for domains that route automated browsers to OTP (use cookies only)
  const paywallCreds = getPaywallCredentials(url);
  const hasCookiesForDomain = paywallCreds && hasCookiesForUrl(url);
  const isCookieOnlyDomain = paywallCreds && COOKIE_ONLY_DOMAINS.includes(paywallCreds.domain);
  if (paywallCreds && paywallCreds.email && !loggedInDomains.has(paywallCreds.domain) && !hasCookiesForDomain && !isCookieOnlyDomain) {
    const loginSuccess = await loginToSite(paywallCreds.domain, paywallCreds.email, paywallCreds.password);
    if (loginSuccess) {
      loggedInDomains.add(paywallCreds.domain);
    }
  }

  // Navigate with retry logic
  let lastError = null;
  for (let attempt = 0; attempt < CONFIG.maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`    Retry ${attempt + 1}/${CONFIG.maxRetries}...`);
        await sleep(CONFIG.retryDelays[attempt - 1]);

        // Re-check browser health before retry
        const retryBrowserOk = await ensureBrowserHealthy();
        if (!retryBrowserOk) {
          throw new Error('Browser unavailable after crash');
        }
      }

      // Set Google referrer to bypass metered paywalls (many soft paywalls allow search traffic)
      await page.setExtraHTTPHeaders({ 'Referer': 'https://www.google.com/' });

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: CONFIG.pageTimeout,
      });

      // Check for outlet-specific wait configuration
      const urlDomain = new URL(url).hostname.replace(/^www\./, '');
      const outletWait = OUTLET_WAIT_CONFIGS[urlDomain];

      if (outletWait) {
        // Use outlet-specific wait strategy (e.g., BroadwayNews JS rendering)
        await page.waitForSelector(outletWait.waitForSelector, {
          timeout: outletWait.waitTimeout,
        }).catch(() => {});
        if (outletWait.extraWait) {
          await page.waitForTimeout(outletWait.extraWait);
        }
      } else {
        // Generic wait for content to load
        await Promise.race([
          page.waitForSelector('article', { timeout: 15000 }),
          page.waitForSelector('[class*="article"]', { timeout: 15000 }),
          page.waitForSelector('[class*="story"]', { timeout: 15000 }),
          page.waitForSelector('main p', { timeout: 15000 }),
          page.waitForTimeout(10000),
        ]).catch(() => {});
      }

      // Scroll to bottom to trigger lazy-loaded content
      await autoScroll(page);

      // Additional wait for JS rendering after scroll
      await page.waitForTimeout(2000);

      // Dismiss paywall overlays and expand hidden content
      await dismissPaywallOverlays(page);

      // Verify we're on the expected domain (prevents cross-domain contamination
      // from redirects, ad interstitials, or stale page state)
      const actualUrl = page.url();
      if (!actualUrl || actualUrl === 'about:blank' || actualUrl.startsWith('chrome-error')) {
        throw new Error(`Page failed to load: ${actualUrl || '(empty)'}`);
      }
      try {
        const expectedDomain = new URL(url).hostname.replace(/^www\./, '');
        const actualDomain = new URL(actualUrl).hostname.replace(/^www\./, '');
        if (!domainMatchesExpected(expectedDomain, actualDomain)) {
          throw new Error(`Domain mismatch: expected ${expectedDomain} but landed on ${actualDomain} (${actualUrl})`);
        }
      } catch (e) {
        if (e.message.startsWith('Domain mismatch') || e.message.startsWith('Page failed')) throw e;
        // Fail open on URL parse errors (don't block on edge cases)
      }

      // Get page content
      const html = await page.content();

      // Check for blocking/CAPTCHA
      if (isBlocked(html)) {
        throw new Error('CAPTCHA or access blocked');
      }

      // Check for paywall text (not fully logged in)
      if (isPaywalled(html)) {
        throw new Error('Paywall detected - login may have failed');
      }

      // Check for 404
      const title = await page.title();
      if (title.toLowerCase().includes('404') || title.toLowerCase().includes('not found')) {
        throw new Error('404 - Page not found');
      }

      // Extract text
      const text = await extractArticleText(page);

      if (text && text.length > 500) {
        stats.tier1Success++;
        return { html, text };
      }

      throw new Error(`Insufficient text extracted: ${text?.length || 0} chars`);

    } catch (e) {
      lastError = e;
      if (e.message.includes('404')) {
        throw e; // Don't retry 404s
      }
      // Detect browser crash errors
      if (e.message.includes('Target page, context or browser has been closed') ||
          e.message.includes('Target closed') ||
          e.message.includes('Browser has been closed') ||
          e.message.includes('Protocol error')) {
        console.log(`    ⚠ Browser crash detected, will restart...`);
        // Don't count this as a regular failure - let health check handle it
      }
    }
  }

  throw lastError || new Error('Playwright failed after all retries');
}

async function loginToSite(domain, email, password) {
  console.log(`    → Logging in to ${domain}...`);

  try {
    if (domain === 'nytimes.com') {
      // NYT login is behind DataDome CAPTCHA - headless Playwright cannot solve it.
      // Strategy: Navigate to the login page. If CAPTCHA is detected, skip login
      // and rely on Archive.org / other tiers for NYT content.
      // Browserbase (Tier 1.5) has CAPTCHA solving and handles NYT separately.
      await page.goto('https://myaccount.nytimes.com/auth/login', { timeout: CONFIG.loginTimeout });
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);

      // Check for CAPTCHA / bot detection (DataDome)
      const hasCaptcha = await page.evaluate(() => {
        const iframes = document.querySelectorAll('iframe');
        for (const f of iframes) {
          if (f.src && f.src.includes('captcha-delivery.com')) return true;
        }
        const text = document.body?.innerText || '';
        if (text.includes('confirm that you are human') || text.includes('Slide right to complete')) return true;
        return false;
      });

      if (hasCaptcha) {
        console.log('    ✗ NYT login blocked by CAPTCHA (DataDome) - skipping Playwright login');
        console.log('      → NYT articles will use Archive.org or Browserbase (CAPTCHA-solving) tiers');
        return false;
      }

      // If no CAPTCHA, try the standard login flow
      const emailInput = await page.$('input[name="email"], input[type="email"], #email');
      if (emailInput) {
        await emailInput.type(email, { delay: 50 });
        await page.click('button[data-testid="submit-email"], button[type="submit"]').catch(() => {});
        await page.waitForTimeout(3000);

        const passInput = await page.$('input[name="password"], input[type="password"]');
        if (passInput) {
          await passInput.type(password, { delay: 50 });
          await page.click('button[data-testid="login-button"], button[type="submit"]').catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
          await page.waitForTimeout(3000);
        }
      }

      const verified = await page.evaluate(() => {
        const userMenu = document.querySelector('[data-testid="user-menu"], [data-testid="user-settings-button"]');
        const loginForm = document.querySelector('input[name="email"]');
        const errorMsg = document.querySelector('[data-testid="error-message"]');
        return { hasUserMenu: !!userMenu, hasLoginForm: !!loginForm, hasError: !!errorMsg };
      });

      if (verified.hasUserMenu) {
        console.log('    ✓ NYT login verified (user menu found)');
        return true;
      }
      if (verified.hasError) {
        console.log('    ✗ NYT login FAILED (error message shown - check credentials)');
        return false;
      }
      if (!verified.hasLoginForm) {
        console.log('    ✓ NYT login likely succeeded (login form gone)');
        return true;
      }
      console.log('    ⚠ NYT login uncertain - continuing anyway');
      return true;
    }

    if (domain === 'newyorker.com') {
      // The New Yorker uses Condé Nast centralized auth at id.condenast.com
      // Separate subscription from Vulture/NYMag despite both being Condé Nast
      // Two-step flow: 1) enter email + "Continue with e-mail", 2) enter password + "Sign in"
      const loginUrl = 'https://www.newyorker.com/auth/initiate?redirectURL=https%3A%2F%2Fwww.newyorker.com%2F&source=HB';
      try {
        await page.goto(loginUrl, { timeout: CONFIG.loginTimeout });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      } catch(e) {
        console.log('    ✗ New Yorker login FAILED (could not load id.condenast.com)');
        return false;
      }

      // Step 1: Enter email
      const emailField = await page.$('input[type="email"], input[name="email"], [role="textbox"]');
      if (!emailField) {
        console.log('    ✗ New Yorker login FAILED (no email field found)');
        return false;
      }
      await emailField.click();
      await emailField.type(email, { delay: 30 });
      await page.waitForTimeout(1000);

      // Click "Continue with e-mail" button
      const continueBtn = await page.$('button:has-text("Continue with e-mail"), button:has-text("Continue"), button[type="submit"]');
      if (continueBtn) {
        await continueBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(5000);

      // Step 2: Enter password
      const passwordField = await page.$('input[type="password"]');
      if (!passwordField) {
        console.log('    ✗ New Yorker login FAILED (no password field - may need different auth method)');
        return false;
      }
      await passwordField.click();
      await passwordField.type(password, { delay: 30 });
      await page.waitForTimeout(500);

      // Click "Sign in" button
      const signInBtn = await page.$('button:has-text("Sign in"), button[type="submit"]');
      if (signInBtn) {
        await signInBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(5000);

      // Verify: should have redirected to newyorker.com
      const postLoginUrl = page.url();
      if (postLoginUrl.includes('newyorker.com') && !postLoginUrl.includes('id.condenast.com')) {
        console.log('    ✓ New Yorker login verified (redirected to newyorker.com)');
        return true;
      }
      // Check for errors
      const hasError = await page.$('[class*="error"], [class*="Error"], [role="alert"]').catch(() => null);
      if (hasError) {
        const errorText = await hasError.textContent().catch(() => '');
        console.log(`    ✗ New Yorker login FAILED (error: ${errorText.substring(0, 80)})`);
        return false;
      }
      console.log('    ⚠ New Yorker login uncertain - continuing anyway');
      return true;
    }

    if (domain === 'vulture.com' || domain === 'nymag.com') {
      // NY Magazine / Vox Media centralized auth at subs.nymag.com
      // Two-step flow: 1) enter email + submit, 2) enter password + sign in
      const loginUrl = 'https://subs.nymag.com/account';
      try {
        await page.goto(loginUrl, { timeout: CONFIG.loginTimeout });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      } catch(e) {
        console.log('    ✗ Vulture login FAILED (could not load subs.nymag.com/account)');
        return false;
      }

      // Step 1: Enter email and submit
      // IMPORTANT: Must use type() not fill() - the "Submit Email" button is disabled
      // until React detects input events, which fill() doesn't trigger
      const emailField = await page.$('input[type="email"], input[name="email"], [role="textbox"]');
      if (!emailField) {
        console.log('    ✗ Vulture login FAILED (no email field found on subs.nymag.com)');
        return false;
      }
      await emailField.click();
      await emailField.type(email, { delay: 30 });
      await page.waitForTimeout(1000);

      // Click "Submit Email" button (should now be enabled after typing)
      const submitEmailBtn = await page.$('button:has-text("Submit Email"):not([disabled])');
      if (submitEmailBtn) {
        await submitEmailBtn.click();
      } else {
        // Fallback: try pressing Enter
        console.log('    ⚠ Submit Email button still disabled, trying Enter key');
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(4000);

      // Step 2: Enter password (page transitions to password form)
      const passwordField = await page.$('input[type="password"]');
      if (!passwordField) {
        console.log('    ✗ Vulture login FAILED (no password field after email submit - may be magic link flow)');
        return false;
      }
      await passwordField.click();
      await passwordField.type(password, { delay: 30 });
      await page.waitForTimeout(500);

      // Click "Sign In" button
      const signInBtn = await page.$('button:has-text("Sign In"), button[type="submit"]');
      if (signInBtn) {
        await signInBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);

      // Verify login success
      const postLoginUrl = page.url();
      const hasError = await page.$('[class*="error"], [class*="Error"], [role="alert"]').catch(() => null);

      if (hasError) {
        const errorText = await hasError.textContent().catch(() => '');
        console.log(`    ✗ Vulture login FAILED (error: ${errorText.substring(0, 80)})`);
        return false;
      }
      // Success if redirected away from account page or if URL contains account (logged in state)
      if (!postLoginUrl.includes('subs.nymag.com/account') || postLoginUrl.includes('#/account')) {
        console.log('    ✓ Vulture login verified (authenticated via subs.nymag.com)');
        return true;
      }
      // Check for user-specific elements that indicate logged-in state
      const userElement = await page.$('[class*="account"], [class*="profile"], [class*="user"]').catch(() => null);
      if (userElement) {
        console.log('    ✓ Vulture login verified (user element detected)');
        return true;
      }
      console.log('    ⚠ Vulture login uncertain (still on account page) - continuing anyway');
      return true;
    }

    if (domain === 'washingtonpost.com') {
      // WaPo uses a two-step login: email → "Next" button → password → submit
      await page.goto('https://www.washingtonpost.com/subscribe/signin/', { timeout: CONFIG.loginTimeout });
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);

      // Step 1: Enter email
      const emailInput = await page.$('input[type="email"], input[name="email"], [role="textbox"]');
      if (!emailInput) {
        console.log('    ✗ WaPo login FAILED (no email field found)');
        return false;
      }
      await emailInput.click();
      await emailInput.type(email, { delay: 30 });
      await page.waitForTimeout(500);

      // Click "Next" button (not "submit")
      const nextBtn = await page.$('button:has-text("Next"), button:has-text("Sign in"), button[type="submit"]');
      if (nextBtn) {
        await nextBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(4000);

      // Step 2: Enter password (page transitions to password form)
      const passInput = await page.$('input[type="password"], input[name="password"]');
      if (passInput) {
        await passInput.click();
        await passInput.type(password, { delay: 30 });
        await page.waitForTimeout(500);

        // Click sign in button
        const signInBtn = await page.$('button:has-text("Sign in"), button:has-text("Submit"), button[type="submit"]');
        if (signInBtn) {
          await signInBtn.click();
        } else {
          await page.keyboard.press('Enter');
        }
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(3000);
      } else {
        console.log('    ✗ WaPo login FAILED (no password field after email step)');
        return false;
      }

      // Verify: check if redirected away from signin or user indicator appears
      const postUrl = page.url();
      const signedIn = !postUrl.includes('signin');
      const hasUserEl = await page.$('[data-qa="user-button"], [class*="signed-in"], [data-testid="user"]').catch(() => null);
      const hasError = await page.$('[class*="error"], [data-testid="error"]').catch(() => null);

      if (hasError) {
        console.log('    ✗ WaPo login FAILED (error shown - check credentials)');
        return false;
      }
      if (hasUserEl || signedIn) {
        console.log('    ✓ WaPo login verified');
        return true;
      }
      console.log('    ⚠ WaPo login uncertain - continuing anyway');
      return true;
    }

    if (domain === 'bloomberg.com') {
      // Bloomberg two-step login: email → "Continue" → password → "Sign in"
      // Has PerimeterX (PX) anti-bot detection — Playwright may be blocked
      await page.goto('https://www.bloomberg.com/account/signin', { timeout: CONFIG.loginTimeout });
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);

      // Dismiss consent modal if present (Bloomberg shows "We've updated our terms" overlay)
      const consentBtn = await page.$('#cmp-consent-modal button, button:has-text("Accept All"), button:has-text("I Agree")');
      if (consentBtn) {
        const isVisible = await consentBtn.isVisible().catch(() => false);
        if (isVisible) {
          console.log('    → Dismissing Bloomberg consent modal...');
          await consentBtn.click();
          await page.waitForTimeout(2000);
        }
      }

      // Check for PerimeterX challenge
      const hasPxChallenge = await page.evaluate(() => {
        const text = document.body?.innerText || '';
        return text.includes('Press & Hold') || text.includes('Human Challenge') ||
               !!document.querySelector('#px-captcha, [id*="perimeterx"]');
      });
      if (hasPxChallenge) {
        console.log('    ✗ Bloomberg login blocked by PerimeterX — skipping Playwright login');
        console.log('      → Bloomberg articles will use cookies or Browserbase tier');
        return false;
      }

      // Step 1: Enter email
      const emailInput = await page.$('input[type="text"][placeholder*="email"], input[type="email"], input[name="email"]');
      if (!emailInput) {
        console.log('    ✗ Bloomberg login FAILED (no email field found)');
        return false;
      }
      await emailInput.click();
      await emailInput.type(email, { delay: 30 });
      await page.waitForTimeout(1000);

      // Click "Continue" button
      const continueBtn = await page.$('button:has-text("Continue"), button[type="submit"]');
      if (continueBtn) {
        await continueBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(4000);

      // Step 2: Enter password
      const passInput = await page.$('input[type="password"]');
      if (passInput) {
        await passInput.click();
        await passInput.type(password, { delay: 30 });
        await page.waitForTimeout(500);

        const signInBtn = await page.$('button:has-text("Sign in"), button:has-text("Continue"), button[type="submit"]');
        if (signInBtn) {
          await signInBtn.click();
        } else {
          await page.keyboard.press('Enter');
        }
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(3000);
      } else {
        console.log('    ✗ Bloomberg login FAILED (no password field after email step)');
        return false;
      }

      // Verify: check if redirected away from signin or user indicator appears
      const postUrl = page.url();
      const hasError = await page.$('[class*="error"], [data-testid="error"], [role="alert"]').catch(() => null);
      if (hasError) {
        const errorText = await hasError.textContent().catch(() => '');
        console.log(`    ✗ Bloomberg login FAILED (error: ${errorText.substring(0, 80)})`);
        return false;
      }
      if (!postUrl.includes('/account/signin')) {
        console.log('    ✓ Bloomberg login verified (left signin page)');
        return true;
      }
      console.log('    ⚠ Bloomberg login uncertain - continuing anyway');
      return true;
    }

    if (domain === 'northjersey.com' || domain === 'usatoday.com') {
      const returnUrl = domain === 'northjersey.com' ? 'https://www.northjersey.com/' : 'https://www.usatoday.com/';
      await page.goto(`https://login.usatoday.com/?return-url=${encodeURIComponent(returnUrl)}`, { timeout: CONFIG.loginTimeout });
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);
      const emailInput = await page.$('input[type="email"], input[name="email"], input[id*="email"]');
      if (!emailInput) { console.log(`    ✗ ${domain} login FAILED (no email field)`); return false; }
      await emailInput.click();
      await emailInput.type(email, { delay: 30 });
      await page.waitForTimeout(500);
      const passInput = await page.$('input[type="password"], input[name="password"]');
      if (passInput) {
        await passInput.click();
        await passInput.type(password, { delay: 30 });
        await page.waitForTimeout(500);
        const signInBtn = await page.$('button:has-text("Sign in"), button:has-text("Log in"), button[type="submit"]');
        if (signInBtn) await signInBtn.click();
        else await page.keyboard.press('Enter');
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(3000);
      } else { console.log(`    ✗ ${domain} login FAILED (no password field)`); return false; }
      const postUrl = page.url();
      if (!postUrl.includes('login.usatoday.com')) { console.log(`    ✓ ${domain} login verified`); return true; }
      console.log(`    ⚠ ${domain} login uncertain - continuing`);
      return true;
    }

    if (domain === 'thestage.co.uk') {
      // Cookie-only — secrets deleted, never attempt login.
      // See memory/feedback_stage_cookie_only.md.
      console.log('    → The Stage is cookie-only, skipping login');
      return false;
    }

    if (domain === 'ft.com') {
      await page.goto('https://accounts.ft.com/login', { timeout: CONFIG.loginTimeout });
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);
      const hasHcaptcha = await page.$('iframe[src*="hcaptcha"], .h-captcha, [data-hcaptcha-widget-id]');
      if (hasHcaptcha) { console.log('    ✗ FT login blocked by hCaptcha — skipping Playwright'); return false; }
      const emailInput = await page.$('input[type="email"], input[name="email"], input[id*="email"]');
      if (!emailInput) { console.log('    ✗ FT login FAILED (no email field)'); return false; }
      await emailInput.click();
      await emailInput.type(email, { delay: 30 });
      await page.waitForTimeout(500);
      const nextBtn = await page.$('button:has-text("Next"), button:has-text("Enter"), button[type="submit"]');
      if (nextBtn) await nextBtn.click();
      else await page.keyboard.press('Enter');
      await page.waitForTimeout(4000);
      const passInput = await page.$('input[type="password"]');
      if (passInput) {
        await passInput.click();
        await passInput.type(password, { delay: 30 });
        await page.waitForTimeout(500);
        const signInBtn = await page.$('button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Submit"), button[type="submit"]');
        if (signInBtn) await signInBtn.click();
        else await page.keyboard.press('Enter');
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(3000);
      } else { console.log('    ✗ FT login FAILED (no password field)'); return false; }
      const postUrl = page.url();
      if (!postUrl.includes('accounts.ft.com')) { console.log('    ✓ FT login verified'); return true; }
      console.log('    ⚠ FT login uncertain - continuing');
      return true;
    }

    if (domain === 'wsj.com') {
      // WSJ redirects to sso.accounts.dowjones.com for login
      // Two-step: email/username → "Continue" button → password → "Continue" button
      await page.goto('https://accounts.wsj.com/login', { timeout: CONFIG.loginTimeout });
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000); // Allow redirect to sso.accounts.dowjones.com

      // Step 1: Enter email/username
      // WSJ uses name="emailOrUsername" and id="emailOrUsername-form-item"
      const emailInput = await page.$('input[name="emailOrUsername"], input#emailOrUsername-form-item, input[type="email"], input[name="username"], input[name="email"]');
      if (!emailInput) {
        console.log('    ✗ WSJ login FAILED (no email/username field found)');
        return false;
      }
      await emailInput.click();
      await emailInput.type(email, { delay: 30 });
      await page.waitForTimeout(500);

      // Click "Continue" button (WSJ uses "Continue" not "Submit" on email step)
      const continueBtn = await page.$('button:has-text("Continue"), button[type="submit"]');
      if (continueBtn) {
        await continueBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(4000);

      // Step 2: Enter password
      const passInput = await page.$('input[type="password"], input[name="password"]');
      if (passInput) {
        await passInput.click();
        await passInput.type(password, { delay: 30 });
        await page.waitForTimeout(500);

        // Click Sign In for password step (prefer "Sign In" over "Continue" to avoid re-clicking email step)
        const signInBtn = await page.$('button:has-text("Sign In"), button:has-text("Continue"), button[type="submit"]');
        if (signInBtn) {
          await signInBtn.click();
        } else {
          await page.keyboard.press('Enter');
        }
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(3000);
      } else {
        console.log('    ✗ WSJ login FAILED (no password field after email step)');
        return false;
      }

      // Verify: check if redirected away from SSO domain (hostname-based)
      const postUrl = page.url();
      const postHost = new URL(postUrl).hostname;
      const leftSso = !postHost.includes('accounts.dowjones.com') && !postHost.includes('accounts.wsj.com');
      const hasError = await page.$('.error-message, [class*="error-text"], [role="alert"][class*="error"], .message--error').catch(() => null);

      if (hasError) {
        const errorText = await hasError.textContent().catch(() => '');
        console.log(`    ✗ WSJ login FAILED (error: ${errorText.substring(0, 80)})`);
        return false;
      }
      if (leftSso) {
        console.log('    ✓ WSJ login verified (left SSO domain)');
        return true;
      }
      console.log('    ⚠ WSJ login uncertain (still on SSO domain) - continuing anyway');
      return true;
    }

    return false;
  } catch (e) {
    console.log(`    ✗ Login error: ${e.message}`);
    return false;
  }
}

// ============================================================================
// TIER 1.5: Browserbase (Managed Browser Cloud with CAPTCHA solving)
// Cost: $0.10/browser hour - USE SPARINGLY with spending limits
// ============================================================================

/**
 * Login to paywalled sites via Browserbase (same flow as Playwright but with CAPTCHA solving).
 * Supports WSJ, NYT, WaPo, Vulture/NYMag. Returns true if login appears successful.
 */
async function browserbaseLogin(bbPage, domain, email, password) {
  if (domain === 'wsj.com') {
    // WSJ uses Dow Jones SSO - an SPA that requires JS rendering
    // accounts.wsj.com/login redirects to sso.accounts.dowjones.com
    // The SSO page has DataDome CAPTCHA - Browserbase's solveCaptchas handles it
    console.log(`    → Browserbase: navigating to WSJ login...`);
    await bbPage.goto('https://accounts.wsj.com/login', { timeout: CONFIG.loginTimeout, waitUntil: 'domcontentloaded' });

    // Check for and wait for CAPTCHA resolution (DataDome on Dow Jones SSO)
    const hasCaptcha = await bbPage.evaluate(() => {
      const iframes = document.querySelectorAll('iframe');
      for (const f of iframes) {
        if (f.src && f.src.includes('captcha-delivery.com')) return true;
      }
      return false;
    });
    if (hasCaptcha) {
      console.log(`    → CAPTCHA detected on WSJ login - waiting for Browserbase to solve...`);
      // Wait for the CAPTCHA iframe to disappear (Browserbase solves it automatically)
      try {
        await bbPage.waitForFunction(() => {
          const iframes = document.querySelectorAll('iframe');
          for (const f of iframes) {
            if (f.src && f.src.includes('captcha-delivery.com')) return false;
          }
          return true;
        }, { timeout: 45000 });
        console.log(`    → CAPTCHA resolved, proceeding with login...`);
        await bbPage.waitForTimeout(2000);
      } catch (e) {
        console.log(`    ✗ CAPTCHA not resolved after 45s - continuing anyway`);
      }
    }

    // Wait for the SPA to render the login form (up to 30s)
    const currentUrl = bbPage.url();
    console.log(`    → WSJ login page URL: ${currentUrl.substring(0, 80)}`);

    // Dump page title and visible inputs for diagnostics
    const pageInfo = await bbPage.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')).map(i => ({
        type: i.type, name: i.name, id: i.id, placeholder: i.placeholder,
      }));
      const buttons = Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim().substring(0, 30));
      const errorMsg = document.querySelector('.error-message, [class*="error-text"], [role="alert"][class*="error"], .message--error');
      return { title: document.title, inputs, buttons, error: errorMsg?.textContent?.trim() };
    });
    console.log(`    → WSJ page title: "${pageInfo.title}"`);
    console.log(`    → WSJ form inputs: ${JSON.stringify(pageInfo.inputs)}`);
    console.log(`    → WSJ buttons: ${JSON.stringify(pageInfo.buttons)}`);
    if (pageInfo.error) console.log(`    → WSJ error on page: "${pageInfo.error}"`);

    let emailInput = null;
    // Try broad set of selectors including generic text input
    const emailSelectors = 'input[type="email"], input[name="email"], input[name="emailOrUsername"], input[name="username"], input[type="text"]:not([name="search"])';
    try {
      await bbPage.waitForSelector(emailSelectors, { timeout: 30000 });
      emailInput = await bbPage.$(emailSelectors);
    } catch (e) {
      console.log(`    → WSJ login SPA slow to render, waiting...`);
      await bbPage.waitForTimeout(10000);
      emailInput = await bbPage.$(emailSelectors);
    }
    if (!emailInput) {
      console.log(`    ✗ WSJ login FAILED (no email/username field found after CAPTCHA wait)`);
      return false;
    }
    console.log(`    → Found email input, typing credentials...`);
    await emailInput.click();
    await emailInput.type(email, { delay: 30 });
    await bbPage.waitForTimeout(500);

    const continueBtn = await bbPage.$('button:has-text("Continue"), button:has-text("Next"), button[type="submit"]');
    if (continueBtn) {
      console.log(`    → Clicking continue/sign-in button...`);
      await continueBtn.click();
    } else {
      console.log(`    → No continue button found, pressing Enter...`);
      await bbPage.keyboard.press('Enter');
    }

    // Wait for password step (Dow Jones SSO is two-step)
    let passInput = null;
    try {
      await bbPage.waitForSelector('input[type="password"]', { timeout: 15000 });
      passInput = await bbPage.$('input[type="password"]');
    } catch (e) {
      await bbPage.waitForTimeout(5000);
      passInput = await bbPage.$('input[type="password"]');
    }
    if (!passInput) {
      // Dump current page state for debugging
      const postEmailUrl = bbPage.url();
      const postEmailInfo = await bbPage.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, name: i.name }));
        const errorMsg = document.querySelector('.error-message, [class*="error-text"], [role="alert"][class*="error"], .message--error');
        return { inputs, error: errorMsg?.textContent?.trim() };
      });
      console.log(`    ✗ WSJ login FAILED (no password field found)`);
      console.log(`    → Post-email URL: ${postEmailUrl.substring(0, 80)}`);
      console.log(`    → Post-email inputs: ${JSON.stringify(postEmailInfo.inputs)}`);
      if (postEmailInfo.error) console.log(`    → Post-email error: "${postEmailInfo.error}"`);
      return false;
    }
    console.log(`    → Found password input, typing...`);
    await passInput.click();
    await passInput.type(password, { delay: 30 });
    await bbPage.waitForTimeout(500);

    // Dump pre-submit state to diagnose button targeting
    const preSubmitInfo = await bbPage.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])')).map(i => ({
        type: i.type, name: i.name, visible: i.offsetParent !== null,
      }));
      const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
        text: b.textContent?.trim().substring(0, 40),
        visible: b.offsetParent !== null, type: b.type,
      }));
      return { inputs, buttons };
    });
    console.log(`    → Pre-submit buttons: ${JSON.stringify(preSubmitInfo.buttons)}`);

    // Use password field's closest form to find the right submit button
    // Avoid re-clicking the email "Continue" — prefer "Sign In"/"Log In" first
    let signInBtn = await bbPage.$('button:has-text("Sign In"), button:has-text("Log In")');
    if (!signInBtn) {
      // Fall back to submit button near the password field
      signInBtn = await bbPage.$('input[type="password"] ~ button, input[type="password"] + div button, button[type="submit"]');
    }
    if (!signInBtn) {
      // Last resort: any Continue button
      signInBtn = await bbPage.$('button:has-text("Continue")');
    }
    if (signInBtn) {
      const btnText = await signInBtn.evaluate(el => el.textContent?.trim());
      console.log(`    → Clicking button: "${btnText}"...`);
      await signInBtn.click();
    } else {
      console.log(`    → No submit button found, pressing Enter on password field...`);
      await passInput.press('Enter');
    }
    // Wait for redirect away from SSO domain (hostname-based, not URL path)
    // The SSO URL always contains /login-page and #/signin-password, so path checks always fail
    let leftSsoDomain = false;
    try {
      await bbPage.waitForFunction(() => {
        const host = window.location.hostname;
        return !host.includes('accounts.dowjones.com') && !host.includes('accounts.wsj.com');
      }, { timeout: 30000 });
      leftSsoDomain = true;
      console.log(`    → WSJ redirect completed (left SSO domain)`);
    } catch (e) {
      console.log(`    → WSJ still on SSO domain after 30s, checking page state...`);
    }

    // Full post-login diagnostic dump
    const postUrl = bbPage.url();
    const postLoginInfo = await bbPage.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])')).map(i => ({
        type: i.type, name: i.name, id: i.id, visible: i.offsetParent !== null,
      }));
      const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
        text: b.textContent?.trim().substring(0, 40), visible: b.offsetParent !== null,
      }));
      // Get all visible text (first 500 chars) to detect OTP prompts, errors, etc.
      const bodyText = document.body?.innerText?.substring(0, 500) || '';
      const hasOtpPrompt = bodyText.includes('passcode') || bodyText.includes('verification') || bodyText.includes('one-time');
      const errorEls = document.querySelectorAll('.error-message, [class*="error-text"], [role="alert"][class*="error"], .message--error');
      const errors = Array.from(errorEls).map(e => e.textContent?.trim().substring(0, 100)).filter(t => t && t.length > 2);
      return { title: document.title, inputs, buttons, bodyText, hasOtpPrompt, errors };
    });
    console.log(`    → Post-login URL: ${postUrl.substring(0, 100)}`);
    console.log(`    → Post-login title: "${postLoginInfo.title}"`);
    if (postLoginInfo.errors.length) console.log(`    → Post-login errors: ${JSON.stringify(postLoginInfo.errors)}`);

    // Check for OTP prompt (unrecoverable - need user interaction)
    if (postLoginInfo.hasOtpPrompt) {
      console.log(`    ✗ WSJ login requires OTP/verification - cannot proceed automatically`);
      return false;
    }

    if (leftSsoDomain) {
      console.log(`    ✓ WSJ login succeeded`);
      return true;
    }

    // Still on SSO but no errors or OTP - may have succeeded (session cookie set)
    // Let the article fetch determine real success
    if (!postLoginInfo.errors.length) {
      console.log(`    ⚠ WSJ login uncertain (still on SSO domain) - continuing`);
      return true;
    }

    console.log(`    ✗ WSJ login failed (errors on SSO page)`);
    return false;
  }

  if (domain === 'newyorker.com') {
    // The New Yorker uses Condé Nast centralized auth at id.condenast.com
    console.log(`    → Browserbase: navigating to New Yorker login...`);
    await bbPage.goto('https://www.newyorker.com/auth/initiate?redirectURL=https%3A%2F%2Fwww.newyorker.com%2F&source=HB', { timeout: CONFIG.loginTimeout });
    await bbPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await bbPage.waitForTimeout(3000);

    const emailInput = await bbPage.$('input[type="email"], input[name="email"], [role="textbox"]');
    if (!emailInput) {
      console.log(`    ✗ New Yorker login FAILED (no email field on id.condenast.com)`);
      return false;
    }
    await emailInput.click();
    await emailInput.type(email, { delay: 30 });
    await bbPage.waitForTimeout(1000);

    const continueBtn = await bbPage.$('button:has-text("Continue with e-mail"), button:has-text("Continue"), button[type="submit"]');
    if (continueBtn) await continueBtn.click();
    else await bbPage.keyboard.press('Enter');
    await bbPage.waitForTimeout(5000);

    const passInput = await bbPage.$('input[type="password"]');
    if (!passInput) {
      console.log(`    ✗ New Yorker login FAILED (no password field after email step)`);
      return false;
    }
    await passInput.click();
    await passInput.type(password, { delay: 30 });
    await bbPage.waitForTimeout(500);

    const signInBtn = await bbPage.$('button:has-text("Sign in"), button[type="submit"]');
    if (signInBtn) await signInBtn.click();
    else await bbPage.keyboard.press('Enter');
    await bbPage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await bbPage.waitForTimeout(5000);

    const postUrl = bbPage.url();
    if (postUrl.includes('newyorker.com') && !postUrl.includes('id.condenast.com')) {
      console.log(`    ✓ New Yorker login succeeded (via Browserbase)`);
      return true;
    }
    console.log(`    ⚠ New Yorker login uncertain (URL: ${postUrl.substring(0, 80)}) - continuing`);
    return true;
  }

  if (domain === 'bloomberg.com') {
    console.log(`    → Browserbase: navigating to Bloomberg login...`);
    await bbPage.goto('https://www.bloomberg.com/account/signin', { timeout: CONFIG.loginTimeout });
    await bbPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await bbPage.waitForTimeout(3000);

    // Dismiss consent modal if present (Bloomberg shows "We've updated our terms" overlay)
    const bbConsentBtn = await bbPage.$('#cmp-consent-modal button, button:has-text("Accept All"), button:has-text("I Agree")');
    if (bbConsentBtn) {
      const isVisible = await bbConsentBtn.isVisible().catch(() => false);
      if (isVisible) {
        console.log(`    → Dismissing Bloomberg consent modal...`);
        await bbConsentBtn.click();
        await bbPage.waitForTimeout(2000);
      }
    }

    // Check for PerimeterX challenge — Browserbase should auto-solve
    const hasPxChallenge = await bbPage.evaluate(() => {
      return !!document.querySelector('#px-captcha, [id*="perimeterx"]') ||
             (document.body?.innerText || '').includes('Press & Hold');
    });
    if (hasPxChallenge) {
      console.log(`    → PerimeterX challenge detected — waiting for Browserbase to solve...`);
      try {
        await bbPage.waitForFunction(() => {
          return !document.querySelector('#px-captcha, [id*="perimeterx"]') &&
                 !(document.body?.innerText || '').includes('Press & Hold');
        }, { timeout: 45000 });
        console.log(`    → PerimeterX resolved, proceeding with login...`);
        await bbPage.waitForTimeout(2000);
      } catch (e) {
        console.log(`    ✗ PerimeterX not resolved after 45s - continuing anyway`);
      }
    }

    // Step 1: Email
    const emailInput = await bbPage.$('input[type="text"][placeholder*="email"], input[type="email"], input[name="email"]');
    if (!emailInput) {
      console.log(`    ✗ Bloomberg login FAILED (no email field)`);
      return false;
    }
    await emailInput.click();
    await emailInput.type(email, { delay: 30 });
    await bbPage.waitForTimeout(1000);

    const continueBtn = await bbPage.$('button:has-text("Continue"), button[type="submit"]');
    if (continueBtn) await continueBtn.click();
    else await bbPage.keyboard.press('Enter');
    await bbPage.waitForTimeout(4000);

    // Step 2: Password
    const passInput = await bbPage.$('input[type="password"]');
    if (!passInput) {
      console.log(`    ✗ Bloomberg login FAILED (no password field after email step)`);
      return false;
    }
    await passInput.click();
    await passInput.type(password, { delay: 30 });
    await bbPage.waitForTimeout(500);

    const signInBtn = await bbPage.$('button:has-text("Sign in"), button:has-text("Continue"), button[type="submit"]');
    if (signInBtn) await signInBtn.click();
    else await bbPage.keyboard.press('Enter');
    await bbPage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await bbPage.waitForTimeout(3000);

    const postUrl = bbPage.url();
    if (!postUrl.includes('/account/signin')) {
      console.log(`    ✓ Bloomberg login succeeded (via Browserbase)`);
      return true;
    }
    console.log(`    ⚠ Bloomberg login uncertain (URL: ${postUrl.substring(0, 80)}) - continuing`);
    return true;
  }

  if (domain === 'northjersey.com' || domain === 'usatoday.com') {
    console.log(`    → Browserbase: navigating to ${domain} Gannett login...`);
    const returnUrl = domain === 'northjersey.com' ? 'https://www.northjersey.com/' : 'https://www.usatoday.com/';
    await bbPage.goto(`https://login.usatoday.com/?return-url=${encodeURIComponent(returnUrl)}`, { timeout: CONFIG.loginTimeout });
    await bbPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await bbPage.waitForTimeout(3000);
    const emailInput = await bbPage.$('input[type="email"], input[name="email"], input[id*="email"]');
    if (!emailInput) { console.log(`    ✗ ${domain} login FAILED (no email field)`); return false; }
    await emailInput.click();
    await emailInput.type(email, { delay: 30 });
    await bbPage.waitForTimeout(500);
    const passInput = await bbPage.$('input[type="password"], input[name="password"]');
    if (passInput) {
      await passInput.click();
      await passInput.type(password, { delay: 30 });
      await bbPage.waitForTimeout(500);
      const signInBtn = await bbPage.$('button:has-text("Sign in"), button:has-text("Log in"), button[type="submit"]');
      if (signInBtn) await signInBtn.click();
      else await bbPage.keyboard.press('Enter');
      await bbPage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await bbPage.waitForTimeout(3000);
    } else { console.log(`    ✗ ${domain} login FAILED (no password field)`); return false; }
    const postUrl = bbPage.url();
    if (!postUrl.includes('login.usatoday.com')) { console.log(`    ✓ ${domain} login succeeded (via Browserbase)`); return true; }
    console.log(`    ⚠ ${domain} login uncertain - continuing`);
    return true;
  }

  if (domain === 'thestage.co.uk') {
    // Cookie-only — secrets deleted, never attempt login.
    // See memory/feedback_stage_cookie_only.md.
    console.log('    → The Stage is cookie-only, skipping Browserbase login');
    return false;
  }

  if (domain === 'ft.com') {
    console.log(`    → Browserbase: navigating to FT login...`);
    await bbPage.goto('https://accounts.ft.com/login', { timeout: CONFIG.loginTimeout });
    await bbPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await bbPage.waitForTimeout(3000);
    const hasHcaptcha = await bbPage.$('iframe[src*="hcaptcha"], .h-captcha, [data-hcaptcha-widget-id]');
    if (hasHcaptcha) {
      console.log('    → hCaptcha detected on FT — waiting for Browserbase to solve...');
      try {
        await bbPage.waitForFunction(() => {
          return !document.querySelector('iframe[src*="hcaptcha"]') && !document.querySelector('.h-captcha iframe');
        }, { timeout: 45000 });
        console.log('    → hCaptcha resolved, proceeding with login...');
        await bbPage.waitForTimeout(2000);
      } catch (e) { console.log('    ✗ hCaptcha not resolved after 45s - continuing anyway'); }
    }
    const emailInput = await bbPage.$('input[type="email"], input[name="email"], input[id*="email"]');
    if (!emailInput) { console.log('    ✗ FT login FAILED (no email field)'); return false; }
    await emailInput.click();
    await emailInput.type(email, { delay: 30 });
    await bbPage.waitForTimeout(500);
    const nextBtn = await bbPage.$('button:has-text("Next"), button:has-text("Enter"), button[type="submit"]');
    if (nextBtn) await nextBtn.click();
    else await bbPage.keyboard.press('Enter');
    await bbPage.waitForTimeout(4000);
    const passInput = await bbPage.$('input[type="password"]');
    if (passInput) {
      await passInput.click();
      await passInput.type(password, { delay: 30 });
      await bbPage.waitForTimeout(500);
      const signInBtn = await bbPage.$('button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Submit"), button[type="submit"]');
      if (signInBtn) await signInBtn.click();
      else await bbPage.keyboard.press('Enter');
      await bbPage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await bbPage.waitForTimeout(3000);
    } else { console.log('    ✗ FT login FAILED (no password field)'); return false; }
    const postUrl = bbPage.url();
    if (!postUrl.includes('accounts.ft.com')) { console.log('    ✓ FT login succeeded (via Browserbase)'); return true; }
    console.log('    ⚠ FT login uncertain - continuing');
    return true;
  }

  if (domain === 'nytimes.com') {
    console.log(`    → Browserbase: navigating to NYT login...`);
    await bbPage.goto('https://myaccount.nytimes.com/auth/login', { timeout: CONFIG.loginTimeout });
    await bbPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await bbPage.waitForTimeout(3000);

    // Check for DataDome CAPTCHA overlay before attempting any clicks
    const hasCaptcha = await bbPage.evaluate(() => {
      const iframes = document.querySelectorAll('iframe');
      for (const f of iframes) {
        if (f.src && f.src.includes('captcha-delivery.com')) return true;
      }
      const text = document.body?.innerText || '';
      if (text.includes('confirm that you are human') || text.includes('Slide right to complete')) return true;
      return false;
    });
    if (hasCaptcha) {
      console.log(`    → CAPTCHA detected on NYT login - waiting for Browserbase to solve...`);
      try {
        await bbPage.waitForFunction(() => {
          const iframes = document.querySelectorAll('iframe');
          for (const f of iframes) {
            if (f.src && f.src.includes('captcha-delivery.com')) return false;
          }
          return true;
        }, { timeout: 45000 });
        console.log(`    → CAPTCHA resolved, proceeding with login...`);
        await bbPage.waitForTimeout(2000);
      } catch (e) {
        console.log(`    ✗ NYT CAPTCHA not resolved after 45s - login failed`);
        return false;
      }
    }

    // Step 1: Email entry
    let emailInput = null;
    const emailSelectors = 'input[name="email"], input[type="email"], #email';
    try {
      await bbPage.waitForSelector(emailSelectors, { timeout: 15000 });
      emailInput = await bbPage.$(emailSelectors);
    } catch (e) {
      console.log(`    → NYT email field slow to render, waiting...`);
      await bbPage.waitForTimeout(5000);
      emailInput = await bbPage.$(emailSelectors);
    }
    if (!emailInput) {
      console.log(`    ✗ NYT login FAILED (no email field found)`);
      return false;
    }
    try {
      await emailInput.click();
    } catch (e) {
      console.log(`    → Email click failed (possible overlay), using keyboard focus...`);
      await bbPage.keyboard.press('Tab');
    }
    await emailInput.type(email, { delay: 30 });
    await bbPage.waitForTimeout(500);

    // Click Continue / submit email
    const continueBtn = await bbPage.$('button[data-testid="submit-email"], button:has-text("Continue"), button[type="submit"]');
    if (continueBtn) {
      try {
        await continueBtn.click();
      } catch (e) {
        console.log(`    → Continue button click failed, pressing Enter...`);
        await bbPage.keyboard.press('Enter');
      }
    } else {
      await bbPage.keyboard.press('Enter');
    }
    await bbPage.waitForTimeout(5000);

    // Check for CAPTCHA after email submission (DataDome sometimes triggers here)
    const hasCaptchaAfterEmail = await bbPage.evaluate(() => {
      const iframes = document.querySelectorAll('iframe');
      for (const f of iframes) {
        if (f.src && f.src.includes('captcha-delivery.com')) return true;
      }
      return false;
    });
    if (hasCaptchaAfterEmail) {
      console.log(`    → CAPTCHA appeared after email entry - waiting for Browserbase to solve...`);
      try {
        await bbPage.waitForFunction(() => {
          const iframes = document.querySelectorAll('iframe');
          for (const f of iframes) {
            if (f.src && f.src.includes('captcha-delivery.com')) return false;
          }
          return true;
        }, { timeout: 45000 });
        console.log(`    → CAPTCHA resolved after email step`);
        await bbPage.waitForTimeout(2000);
      } catch (e) {
        console.log(`    ✗ NYT CAPTCHA not resolved after email step - login failed`);
        return false;
      }
    }

    // Step 2: Password entry
    let passInput = null;
    try {
      await bbPage.waitForSelector('input[type="password"]', { timeout: 15000 });
      passInput = await bbPage.$('input[type="password"]');
    } catch (e) {
      console.log(`    → NYT password field slow to render, waiting...`);
      await bbPage.waitForTimeout(5000);
      passInput = await bbPage.$('input[type="password"]');
    }
    if (!passInput) {
      const postEmailUrl = bbPage.url();
      console.log(`    ✗ NYT login FAILED (no password field found)`);
      console.log(`    → Post-email URL: ${postEmailUrl.substring(0, 100)}`);
      return false;
    }
    try {
      await passInput.click();
    } catch (e) {
      console.log(`    → Password click failed (possible overlay), using keyboard focus...`);
      await bbPage.keyboard.press('Tab');
    }
    await passInput.type(password, { delay: 30 });
    await bbPage.waitForTimeout(500);

    // Click Log In / submit password
    const loginBtn = await bbPage.$('button[data-testid="login-button"], button:has-text("Log In"), button[type="submit"]');
    if (loginBtn) {
      try {
        await loginBtn.click();
      } catch (e) {
        console.log(`    → Login button click failed, pressing Enter...`);
        await bbPage.keyboard.press('Enter');
      }
    } else {
      await bbPage.keyboard.press('Enter');
    }
    await bbPage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await bbPage.waitForTimeout(3000);

    const postUrl = bbPage.url();
    if (!postUrl.includes('auth/login')) {
      console.log(`    ✓ NYT login succeeded (left login page)`);
      return true;
    }
    console.log(`    ⚠ NYT login uncertain (URL: ${postUrl.substring(0, 100)}) - continuing`);
    return true;
  }

  return false;
}

/**
 * Query Browserbase's own API for the actual number of sessions created in the
 * last 24h (rolling), same endpoint + method scraper-cost-report.yml already
 * treats as billing ground truth. Returns null on any failure (network, auth,
 * unexpected shape) — callers must treat null as "unknown," not "zero."
 *
 * Why this exists (#312): the local sessionsToday counter in
 * browserbase-usage.json is read once at process start and written once at
 * exit. When multiple collect-review-texts.js runs execute concurrently
 * (explicitly supported — "Parallel runs: YES" per the workflow doc, and
 * observed in practice: gather-reviews.yml's per-show auto-dispatch guard
 * (checkoutRUNNING/QUEUED) races when many single-show runs fire within
 * seconds of each other, e.g. 12 parallel Collect Review Texts dispatches
 * 2026-07-20 15:49-15:50 and 13 more 2026-07-21 15:58-15:59), every run in the
 * burst loads the SAME stale snapshot and each independently enforces the
 * 250/day cap against that one stale number — so N concurrent runs can each
 * spend up to their own per-run allowance before any of them would see the
 * others' spend. Reconciling against the live API count closes that gap
 * regardless of how many runners are in flight.
 */
async function fetchLiveBrowserbaseSessionsToday() {
  const count = await _fetchLiveBBSessions(CONFIG.browserbaseApiKey, CONFIG.browserbaseProjectId);
  if (count === null) {
    console.log(`  ⚠ Browserbase live session count unavailable — falling back to local counter only`);
  }
  return count;
}

/**
 * Load Browserbase usage from disk (tracks daily spending), then reconcile
 * against the live API count (#312) so a stale/raced local file can never
 * UNDER-report actual spend — only the max of the two is trusted.
 */
async function loadBrowserbaseUsage() {
  const usagePath = CONFIG.browserbaseUsageFile;
  const today = new Date().toISOString().split('T')[0];

  try {
    if (fs.existsSync(usagePath)) {
      const saved = JSON.parse(fs.readFileSync(usagePath, 'utf8'));

      // Reset if it's a new day
      if (saved.date === today) {
        browserbaseUsage = saved;
        browserbaseUsage.sessionsThisRun = 0; // Reset per-run counter
        browserbaseUsage.sessionsPerDomain = {}; // Per-domain cap is per-run, not per-day (prevents cross-run starvation in chained rounds)
        console.log(`  Browserbase usage loaded: ${browserbaseUsage.sessionsToday}/${CONFIG.browserbaseMaxSessionsPerDay} sessions today`);
      } else {
        // New day - archive previous day and reset
        browserbaseUsage.history.push({
          date: saved.date,
          sessions: saved.sessionsToday,
          minutes: saved.minutesToday
        });
        browserbaseUsage.date = today;
        browserbaseUsage.sessionsToday = 0;
        browserbaseUsage.sessionsThisRun = 0;
        browserbaseUsage.minutesToday = 0;
        console.log(`  Browserbase: New day - reset usage counters`);
      }
    }
  } catch (e) {
    console.log(`  Could not load Browserbase usage: ${e.message}`);
  }

  const liveCount = await fetchLiveBrowserbaseSessionsToday();
  if (liveCount !== null && liveCount > browserbaseUsage.sessionsToday) {
    console.log(`  Browserbase live count (${liveCount}) exceeds local counter (${browserbaseUsage.sessionsToday}) — trusting live count (concurrent run or lost commit)`);
    browserbaseUsage.sessionsToday = liveCount;
  }
}

/**
 * Save Browserbase usage to disk
 */
function saveBrowserbaseUsage() {
  fs.mkdirSync(path.dirname(CONFIG.browserbaseUsageFile), { recursive: true });
  fs.writeFileSync(CONFIG.browserbaseUsageFile, JSON.stringify(browserbaseUsage, null, 2));
}

/**
 * Check if we can use Browserbase (within spending limits)
 */
function canUseBrowserbase(urlDomain) {
  return !browserbaseBlockReason(urlDomain);
}

/**
 * Why Browserbase can't run right now: null when it can, 'disabled' for
 * configuration (kill switch, off, no key), else the cap that is spent
 * ('day' | 'run' | 'domain'). Only cap reasons make a failure a deferral
 * (route_not_attempted_cap, BRO-5222); 'disabled' is not a spend decision.
 */
/** True when this run is exempt from the opening-window reserve, judged as the chokepoint judges it. */
function browserbaseRunIsExempt() {
  return isBbExemptCaller(process.argv[1] || null, resolveBbExemptScripts(), process.env.GITHUB_WORKFLOW || null, process.env.BD_OPENING_NIGHT || null);
}

function browserbaseBlockReason(urlDomain) {
  if (CONFIG.browserbaseKillSwitch) return 'disabled';
  if (!CONFIG.browserbaseEnabled) return 'disabled';
  if (!CONFIG.browserbaseApiKey) return 'disabled';
  // The session-create chokepoint already refused this run (account-wide day
  // cap or opening-window reserve); the count only grows, so skip the rest.
  if (browserbaseChokepointCapped) return 'day';
  if (browserbaseReserveHeld && !CONFIG.browserbaseUseReserve && !isTier1RecoveryHost(urlDomain)) return 'reserve';

  const decision = checkBrowserbaseCaps({
    sessionsToday: browserbaseUsage.sessionsToday,
    sessionsThisRun: browserbaseUsage.sessionsThisRun,
    sessionsPerDomain: browserbaseUsage.sessionsPerDomain || {},
    urlDomain,
    config: {
      // Time-boxed Tier-1 boost (BRO-5243 Option B), mirroring the chokepoint:
      // Tier-1 hosts get it, and opening-night (exempt) runs get it for every
      // host so boosted Tier-1 spend never squeezes them.
      maxPerDay: CONFIG.browserbaseMaxSessionsPerDay + tier1BoostForCaller(urlDomain, { exempt: browserbaseRunIsExempt() }),
      maxPerRun: CONFIG.browserbaseMaxSessionsPerRun,
      maxPerDomain: CONFIG.browserbaseMaxSessionsPerDomain,
      reserve: CONFIG.browserbaseRecoveryReserve,
      // Tier-1 paywalled hosts may spend the recovery reserve, matching the
      // chokepoint (BRO-5243).
      useReserve: CONFIG.browserbaseUseReserve || isTier1RecoveryHost(urlDomain),
    },
  });
  if (!decision.allowed) {
    const labels = { day: 'daily', run: 'per-run', domain: `per-domain (${urlDomain})` };
    const reserveNote = decision.reason === 'day' && !CONFIG.browserbaseUseReserve && CONFIG.browserbaseRecoveryReserve > 0
      ? `, ${CONFIG.browserbaseRecoveryReserve} held for recovery runs` : '';
    console.log(`    ⚠ Browserbase ${labels[decision.reason]} limit reached (${decision.used}/${decision.limit}${reserveNote})`);
    return decision.reason;
  }
  return null;
}

/**
 * Fetch with Browserbase - managed browser cloud with CAPTCHA solving
 * Uses their API to create a browser session and control it
 */
/**
 * fetchWithBrowserbase: retries once (fresh session) on "Insufficient text"
 * before giving up. #221/#224 diagnostic (2026-07-20) found WSJ's real-world
 * Browserbase hit rate is ~50% per attempt even with valid injected cookies —
 * NOT a hard block (isBlocked/isPaywalled both pass, the page loads and has a
 * real <article> with real cookies present) but some sessions render an empty
 * paragraph tree while an identical retry moments later succeeds. Sampled
 * data/review-texts wsj--*.json fetchMethod:'browserbase' entries from
 * 2026-07-10 to 07-19 show real successes (5000+ chars) interleaved with
 * 0-char failures throughout, not a step-function regression — a single
 * session-level retry (independent fingerprint/proxy) converts that ~50%
 * single-shot rate into a ~75% effective rate. Does NOT retry hard failures
 * (cap reached, missing config, session-creation errors) — those won't
 * resolve on retry and retrying them just burns a second session for nothing.
 */
async function fetchWithBrowserbase(url, review) {
  try {
    return await _fetchWithBrowserbaseAttempt(url, review);
  } catch (error) {
    if (!/Insufficient text/.test(error.message)) throw error;
    // A second session needs ~40s; with less left before the per-review
    // REVIEW_TIMEOUT it would be paid for and then abandoned (BRO-5222).
    const startedAt = Number.isFinite(review && review._reviewStartedAt) ? review._reviewStartedAt : null;
    if (startedAt !== null && startedAt + CONFIG.reviewTimeout - Date.now() < 40000) throw error;
    console.log(`    ⚠ Browserbase returned insufficient text — retrying once with a fresh session...`);
    return await _fetchWithBrowserbaseAttempt(url, review);
  }
}

async function _fetchWithBrowserbaseAttempt(url, review) {
  // Extract domain ONCE — used by both the cap gate and the per-domain counter.
  // canUseBrowserbase needs it to enforce the per-domain cap (otherwise
  // anything that bypasses the shouldRun gate would silently skip the
  // domain-level guard — caught by ship-check on commit ae46715a0a).
  let urlDomain;
  try { urlDomain = new URL(url).hostname.replace('www.', ''); } catch {}

  // Mid-run resync (#312): a run that opens dozens of sessions can outlive the
  // start-of-run snapshot by many minutes — long enough for a SIBLING run
  // (e.g. another burst-dispatched single-show Collect Review Texts job) to
  // burn sessions this process has no way to see otherwise. Re-check the live
  // API every 5 sessions rather than every single fetch, to bound API calls.
  if (browserbaseUsage.sessionsThisRun > 0 && browserbaseUsage.sessionsThisRun % 5 === 0) {
    const liveCount = await fetchLiveBrowserbaseSessionsToday();
    if (liveCount !== null && liveCount > browserbaseUsage.sessionsToday) {
      console.log(`    ⚠ Browserbase live count (${liveCount}) exceeds local counter mid-run — resyncing`);
      browserbaseUsage.sessionsToday = liveCount;
    }
  }

  if (!canUseBrowserbase(urlDomain)) {
    throw new Error('Browserbase unavailable (limits reached or not configured)');
  }

  stats.tier1_5Attempts++;
  const startTime = Date.now();

  // Track usage BEFORE attempting (we pay even if it fails)
  countBrowserbaseAttempt(browserbaseUsage, urlDomain);
  stats.browserbaseSessionsUsed++;


  console.log(`    Browserbase session ${browserbaseUsage.sessionsThisRun}/${CONFIG.browserbaseMaxSessionsPerRun} (${browserbaseUsage.sessionsToday}/${CONFIG.browserbaseMaxSessionsPerDay} today)`);

  let bbBrowser = null;
  let bbPage = null;

  try {
    // Browserbase SDK approach - use their connect endpoint
    const { chromium: bbChromium } = require('playwright');
    const { createBbSession } = require('./lib/browserbase-session');

    // Create session via Browserbase API. A refusal before the create call
    // (cap, reserve, denied host) cost nothing: give the counts back.
    const bbSession = await createBbSession({
      apiKey: CONFIG.browserbaseApiKey,
      projectId: CONFIG.browserbaseProjectId,
      caller: 'collect-review-texts.js',
      purpose: urlDomain ? `paywalled review fetch: ${urlDomain}` : 'paywalled review fetch',
      host: urlDomain || null,
      category: 'review-text',
      body: {
        browserSettings: {
          // Enable stealth and CAPTCHA solving
          solveCaptchas: true,
          fingerprint: {
            // Use residential-like fingerprint
            locales: ['en-US'],
            operatingSystems: ['macos', 'windows'],
          },
        },
      },
    }).catch((err) => {
      if (err && err.bbNoSession) {
        countBrowserbaseAttempt(browserbaseUsage, urlDomain, -1);
        stats.browserbaseSessionsUsed = Math.max(0, stats.browserbaseSessionsUsed - 1);
        stats.tier1_5Attempts = Math.max(0, stats.tier1_5Attempts - 1);
      }
      throw err;
    });

    const sessionId = bbSession.id;
    const connectUrl = bbSession.connectUrl;

    console.log(`    → Browserbase session created: ${sessionId.substring(0, 8)}...`);
    state.log.push({ t: new Date().toISOString(), event: 'bb-session', session: sessionId.substring(0, 8), url: url.substring(0, 80) });

    // Connect via Playwright CDP
    bbBrowser = await bbChromium.connectOverCDP(connectUrl);
    const contexts = bbBrowser.contexts();
    const bbContext = contexts[0] || await bbBrowser.newContext();
    bbPage = await bbContext.newPage();

    // Try cookie injection first (faster, more reliable than login)
    let bbCookiesInjected = false;
    const cookieDomain = hasCookiesForUrl(url);
    if (cookieDomain) {
      bbCookiesInjected = await injectCookies(bbContext, cookieDomain);
      if (bbCookiesInjected) {
        console.log(`    🍪 Browserbase: cookies injected for ${cookieDomain} — skipping login`);
        state.log.push({ t: new Date().toISOString(), event: 'bb-cookie-inject', domain: cookieDomain });
      }
    }

    // Login to paywalled sites before navigating to the review URL
    // Browserbase has CAPTCHA solving, making it ideal for sites that block Playwright
    // Skip login if cookies were already injected for this domain
    // Skip login for cookie-only domains (e.g., newyorker.com triggers OTC emails on login)
    const paywallCreds = getPaywallCredentials(url);
    const isCookieOnly = paywallCreds && COOKIE_ONLY_DOMAINS.includes(paywallCreds.domain);
    if (paywallCreds && paywallCreds.email && !bbCookiesInjected && !isCookieOnly) {
      console.log(`    → Browserbase login to ${paywallCreds.domain}...`);
      try {
        const loginOk = await browserbaseLogin(bbPage, paywallCreds.domain, paywallCreds.email, paywallCreds.password);
        if (loginOk) {
          console.log(`    ✓ Browserbase login to ${paywallCreds.domain} succeeded`);
          state.log.push({ t: new Date().toISOString(), event: 'bb-login-ok', domain: paywallCreds.domain });
        } else {
          console.log(`    ⚠ Browserbase login to ${paywallCreds.domain} uncertain - continuing`);
          state.log.push({ t: new Date().toISOString(), event: 'bb-login-uncertain', domain: paywallCreds.domain });
        }
      } catch (loginErr) {
        console.log(`    ⚠ Browserbase login failed: ${loginErr.message} - continuing without login`);
        state.log.push({ t: new Date().toISOString(), event: 'bb-login-fail', domain: paywallCreds.domain, error: loginErr.message });
      }
    }

    // Navigate to the URL
    const bbResponse = await bbPage.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: CONFIG.pageTimeout,
    });

    // Wait for content
    await Promise.race([
      bbPage.waitForSelector('article', { timeout: 15000 }),
      bbPage.waitForSelector('[class*="article"]', { timeout: 15000 }),
      bbPage.waitForSelector('main p', { timeout: 15000 }),
      bbPage.waitForTimeout(10000),
    ]).catch(() => {});

    // Extra wait for JS rendering and CAPTCHA solving
    await bbPage.waitForTimeout(5000);

    const html = await bbPage.content();

    // Check for blocking
    if (isBlocked(html)) {
      throw new Error('CAPTCHA or access blocked (even with Browserbase)');
    }

    // Check for paywall
    if (isPaywalled(html)) {
      throw new Error('Paywall detected');
    }

    // Extract text using same method as Playwright (full selector list)
    const text = await bbPage.evaluate(() => {
      // Zox News theme (t2conline.com, BRO-4977): the next stories auto-load
      // inside the same <article>, and the longest-match loop below would keep
      // them. Drop that chrome and take the body container when present.
      document.querySelectorAll('#mvp-author-box-wrap, #mvp-prev-next-wrap, #mvp-related-posts, #mvp-post-add-box, #mvp-post-add-wrap, .mvp-post-add-story, #mvp-post-more-wrap, #mvp-content-bot')
        .forEach(el => el.remove());
      const zoxBody = document.querySelector('#mvp-content-main');
      if (zoxBody) {
        const zoxText = Array.from(zoxBody.querySelectorAll('p'))
          .map(p => p.textContent.trim()).filter(t => t.length > 30).join('\n\n');
        if (zoxText.length > 500) return zoxText.replace(/\s+/g, ' ').trim();
      }
      const selectors = [
        // NYT
        '[data-testid="article-body"]', 'section[name="articleBody"]',
        // Vulture / NY Mag / Condé Nast
        '[class*="ArticlePageChunks"]', '[class*="RawHtmlBody"]',
        // TimeOut (hashed class names)
        '[class*="_articleContent_"]',
        // Variety / THR / Deadline (PMC sites)
        '.a-content',
        // WSJ
        '.article-content .wsj-snippet-body', 'div.article-content', '[class*="article_body"]',
        // WaPo
        '[data-qa="article-body"]', '.article-body',
        // Entertainment Weekly / People
        '[data-testid="article-body-content"]',
        // Generic (ordered by specificity)
        'article .entry-content', 'article .post-content', 'article .article-body',
        '.story-body', '.entry-content', '.post-content', '.review-content',
        '.article__body', '.article-content', '.rich-text',
        '[class*="ArticleBody"]', '[class*="article-body"]',
        '[class*="story-body"]', '[class*="StoryBody"]', 'main article',
        '.story-content', '[role="article"]', 'article', 'main',
      ];

      let bestText = '';
      for (const selector of selectors) {
        try {
          const el = document.querySelector(selector);
          if (el) {
            const paragraphs = el.querySelectorAll('p');
            if (paragraphs.length > 0) {
              const text = Array.from(paragraphs)
                .map(p => p.textContent.trim())
                .filter(t => t.length > 30)
                .join('\n\n');
              if (text.length > bestText.length) bestText = text;
            }
          }
        } catch (e) {}
      }
      return bestText.replace(/\s+/g, ' ').trim();
    });

    // Track time used
    const minutesUsed = (Date.now() - startTime) / 60000;
    browserbaseUsage.minutesToday += minutesUsed;
    stats.browserbaseMinutesUsed += minutesUsed;

    if (text && text.length > 500) {
      stats.tier1_5Success++;
      saveBrowserbaseUsage();
      return { html, text };
    }

    // BRO-5874: say what the browser got, so a 0-char result reads as a block (403, short page) or an extractor miss.
    const bbTitle = await bbPage.title().catch(() => '');
    console.log(`    Browserbase page: HTTP ${bbResponse ? bbResponse.status() : '?'}, ${html.length} bytes, title "${String(bbTitle).slice(0, 80)}"`);
    throw new Error(`Insufficient text: ${text?.length || 0} chars`);

  } catch (error) {
    // Track time even on failure
    const minutesUsed = (Date.now() - startTime) / 60000;
    browserbaseUsage.minutesToday += minutesUsed;
    stats.browserbaseMinutesUsed += minutesUsed;
    saveBrowserbaseUsage();

    throw error;
  } finally {
    // Always close the browser
    if (bbBrowser) {
      try {
        await bbBrowser.close();
      } catch (e) {}
    }
  }
}

// ============================================================================
// TIER 2: ScrapingBee API
// ============================================================================

// This script has its own standalone ScrapingBee client (does not go through
// scripts/lib/scraper.js), so scraper.js's _scrapingBeePageExhausted breaker
// doesn't cover it — a second-opinion review of that fix (2026-07-20) found
// this exact function still had zero circuit breaker, meaning the incident
// it was meant to close (every SB call doing a full round-trip before dying
// on a monthly-cap 401) was still live in the flagship review-collection
// script. Same one-failure-and-stop pattern as scraper.js's breaker.
let _sbPageExhausted = false;

/**
 * TIER 1.9: Scrapingdog page fetch — 1 cr plain / 5 cr JS-rendered, vs
 * ScrapingBee's 1/10/75 on the same page. Delegates to the shared
 * fetchWithScrapingdog in lib/scraper, which forwards subscriber cookies,
 * auto-detects JS-required domains, respects the per-run SD budget, and emits
 * [SD Call] telemetry. Same acceptance bar as the SB tier: unblocked HTML with
 * >500 chars of extracted text; anything less throws so the chain continues.
 */
async function fetchWithScrapingdogText(url) {
  if (!process.env.SCRAPINGDOG_API_KEY) {
    throw new Error('Scrapingdog not configured');
  }
  stats.tier1_9Attempts++;
  console.log('    Scrapingdog...');
  const result = await fetchWithScrapingdog(url);
  if (!result || !result.content) {
    // fetchWithScrapingdog logs the underlying error and returns null
    throw new Error('Scrapingdog returned no content');
  }
  const html = result.content;
  if (isBlocked(html)) {
    throw new Error('CAPTCHA detected (scrapingdog)');
  }
  const text = extractTextFromHtml(html, url);
  if (text && text.length > 500) {
    stats.tier1_9Success++;
    return { html, text };
  }
  throw new Error(`Insufficient text: ${text?.length || 0} chars`);
}

async function fetchWithScrapingBee(url, useStealth = false) {
  if (!CONFIG.scrapingBeeKey || !axios) {
    throw new Error('ScrapingBee not configured');
  }
  if (_sbPageExhausted) {
    throw new Error('ScrapingBee disabled for the rest of this process (prior auth/limit failure)');
  }

  // Determine cost tier based on domain
  const hostname = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const needsPremium = SB_PREMIUM_DOMAINS.has(hostname);

  let proxyType, renderJs, waitMs;
  if (useStealth) {
    proxyType = 'stealth_proxy';
    renderJs = true;
    waitMs = 5000;
  } else if (needsPremium) {
    proxyType = 'premium_proxy';
    renderJs = true;
    waitMs = 5000;
  } else {
    proxyType = 'standard';
    renderJs = false;
    waitMs = 0;  // No wait needed for static HTML
  }
  // BRO-3057: credits derived from proxyType (the real API param value) via
  // the shared provider-credits.js table, instead of an independently
  // maintained literal — a proxyType typo now throws instead of silently
  // billing the wrong cost.
  // BRO-3009 S1-T5: the budget comparison itself now runs through
  // scripts/lib/crt-sb-credit-guard.js, which asserts both sides are finite
  // before comparing — an unknown proxyType or a malformed
  // SB_PAGE_CREDIT_BUDGET used to make `spent + credits > budget` evaluate to
  // false and disable the cap entirely instead of tripping it.
  const budgetCheck = sbPageBudgetDecision({
    spentCredits: stats.scrapingBeePageCredits,
    mode: proxyType,
    budget: SB_PAGE_CREDIT_BUDGET,
  });
  const credits = budgetCheck.credits;

  // Per-run budget guard
  if (budgetCheck.exhausted) {
    throw new Error(`SB page credit budget exhausted (${stats.scrapingBeePageCredits}/${SB_PAGE_CREDIT_BUDGET})`);
  }

  const hostVerdict = sbHostCooldown.consult(url);
  if (!hostVerdict.allowed) throw new Error(`ScrapingBee skipped: ${hostVerdict.reason}`);
  stats.tier2Attempts++;

  // Guards the catch block below: isBlocked()/insufficient-text throw AFTER a
  // successful, already-billed API response — the catch's failure recorder
  // must not also fire for those, or one billed call becomes two ledger rows.
  let apiCallRecorded = false;

  // Forward subscriber cookies via ScrapingBee's header forwarding
  const cookieHeader = buildCookieHeaderForUrl(url);
  if (cookieHeader) {
    console.log(`    ScrapingBee (${proxyType}, ${credits} credits, +cookies ${cookieHeader.length} chars)...`);
  } else {
    console.log(`    ScrapingBee (${proxyType}, ${credits} credits)...`);
  }

  try {
    const params = {
      api_key: CONFIG.scrapingBeeKey,
      url: url,
      render_js: renderJs,
      block_ads: true,
      block_resources: false,
    };

    // Only add wait for JS-rendered pages
    if (waitMs > 0) {
      params.wait = waitMs;
    }

    if (useStealth) {
      params.stealth_proxy = true;
    } else if (needsPremium) {
      params.premium_proxy = true;
    }
    // Standard mode: no proxy param needed (default SB proxy)

    // Forward subscriber cookies to the target site
    if (cookieHeader) {
      params.forward_headers = true;
    }

    // Build request config — add Spb-Cookie header for cookie forwarding
    const requestConfig = {
      params,
      timeout: CONFIG.apiTimeout,
    };
    if (cookieHeader) {
      requestConfig.headers = {
        'Spb-Cookie': cookieHeader,
      };
    }

    const response = await axios.get('https://app.scrapingbee.com/api/v1/', requestConfig);

    stats.scrapingBeePageCredits += credits;
    apiCallRecorded = true;
    sbHostCooldown.record(url, true);
    recordSbCall({
      url,
      fn: useStealth ? 'stealth' : (needsPremium ? 'premium' : 'page'),
      success: true,
      status: response.status,
      credits,
      purpose: 'review-text',
    });

    const html = response.data;

    if (isBlocked(html)) {
      // If premium failed with CAPTCHA and we haven't tried stealth yet, retry with stealth
      if (!useStealth && CLI.stealthProxy) {
        console.log(`    → CAPTCHA with premium, retrying with stealth_proxy...`);
        return await fetchWithScrapingBee(url, true);
      }
      throw new Error(`CAPTCHA detected (${proxyType})`);
    }

    const text = extractTextFromHtml(html, url);

    if (text && text.length > 500) {
      stats.tier2Success++;
      return { html, text };
    }

    throw new Error(`Insufficient text: ${text?.length || 0} chars`);
  } catch (error) {
    // Don't retry if we're already on stealth - let it fail through
    // (This prevents double-retrying when stealth also fails)

    // Enhanced error reporting for ScrapingBee
    if (error.response) {
      const status = error.response.status;
      const message = error.response.data?.message || error.message;
      if (!apiCallRecorded) {
        sbHostCooldown.record(url, false);
        recordSbCall({
          url,
          fn: useStealth ? 'stealth' : (needsPremium ? 'premium' : 'page'),
          success: false,
          status,
          credits: sbBilledCredits(status, credits),
          purpose: 'review-text',
        });
      }

      // Same trigger set as scraper.js's _scrapingBeePageExhausted and
      // url-discovery.js's _scrapingBeeSerpExhausted: auth/plan/rate-limit
      // failures don't resolve mid-run, so stop asking for the rest of this
      // process instead of eating a full round-trip on every candidate.
      if ([401, 403, 429].includes(status)) {
        _sbPageExhausted = true;
        console.warn(`  ⚠️  ScrapingBee disabled for the rest of this process (HTTP ${status})`);
      }

      if (status === 401) {
        throw new Error(`ScrapingBee auth failed: ${message}`);
      } else if (status === 403) {
        throw new Error(`ScrapingBee blocked: ${message}`);
      } else {
        throw new Error(`ScrapingBee error (${status}): ${message}`);
      }
    }
    if (!apiCallRecorded) {
      sbHostCooldown.record(url, false);
      recordSbCall({
        url,
        fn: useStealth ? 'stealth' : (needsPremium ? 'premium' : 'page'),
        success: false,
        status: 'error',
        credits: sbBilledCredits('error', credits),
        purpose: 'review-text',
      });
    }
    throw error;
  }
}

// ============================================================================
// TIER 1.8: Direct HTTP fetch with subscriber cookies (no proxy, free)
// ============================================================================

/**
 * Fetch a URL directly with subscriber cookies — bypasses headless browser detection
 * because it's a plain HTTP request (no JS fingerprinting). Uses the same approach
 * as recover-wsj-subscriber.js. Free (no API credits), fast, and avoids the headless
 * Chrome fingerprinting that defeats Playwright + cookies on sites like New Yorker.
 */
async function fetchWithDirectCookies(url) {
  const cookieHeader = buildCookieHeaderForUrl(url);
  if (!cookieHeader) {
    throw new Error('No cookies available for this domain');
  }

  console.log(`    Direct HTTP fetch (+cookies, ${cookieHeader.length} chars)...`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    // Determine referrer based on domain
    const hostname = new URL(url).hostname;
    const referrer = `https://${hostname}/`;

    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Cookie': cookieHeader,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': referrer,
        'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="122", "Chromium";v="122"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (resp.status === 403 || resp.status === 401) {
      throw new Error(`Auth rejected (HTTP ${resp.status}) — cookies may be expired`);
    }
    if (resp.status === 404) {
      throw new Error(`404 Not Found`);
    }
    if (resp.status !== 200) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const html = await resp.text();

    if (isBlocked(html)) {
      throw new Error('Paywall/block detected in direct fetch response');
    }

    const text = extractTextFromHtml(html, url);

    if (text && text.length > 500) {
      return { html, text };
    }

    throw new Error(`Insufficient text: ${text?.length || 0} chars`);
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      throw new Error('Direct fetch timed out (30s)');
    }
    throw error;
  }
}

// ============================================================================
// TIER 3: Bright Data Web Unlocker
// ============================================================================

async function fetchWithBrightData(url) {
  if (!CONFIG.brightDataKey || !axios) {
    throw new Error('Bright Data not configured');
  }

  // THIRD chokepoint (ship-check finding). This file has its own axios-based
  // Web Unlocker tier — it does NOT go through scripts/lib/scraper.js — and it
  // is the single largest Bright Data spender in the system. Capping only the
  // lib's two helpers would have left the daily breaker decorative: the
  // hourly job would trip, the alert would fire, and this collector would keep
  // billing. Any future direct api.brightdata.com/request call must consult
  // here too; scripts/lib/brightdata-caps.js is the one place that decides.
  const bdVerdict = consultBrightData({ zone: process.env.BRIGHTDATA_ZONE || 'web_unlocker2' });
  if (!bdVerdict.allowed) {
    if (bdVerdict.firstBlock) {
      recordBdCall({ url, fn: 'collector-tier3', success: false, status: 'budget_capped', purpose: 'budget_capped' });
    }
    // Throw (not return null): this tier's contract with its callers is
    // throw-on-failure, and the outer handler already turns a thrown tier into
    // "try the next tier / record the failure" — where getScraperStats().
    // bdBlocked then classifies it as budget_capped rather than a dead URL.
    throw new Error('Bright Data skipped — daily budget cap');
  }

  stats.tier3Attempts++;

  // Use Bright Data Web Unlocker Direct API
  // See: https://docs.brightdata.com/scraping-automation/web-unlocker/web-unlocker-api
  const zoneName = process.env.BRIGHTDATA_ZONE || 'web_unlocker2';
  const keyPreview = CONFIG.brightDataKey.substring(0, 8) + '...';
  console.log(`    Bright Data API (zone=${zoneName}, key=${keyPreview})`);

  try {
    const response = await axios.post('https://api.brightdata.com/request', {
      zone: zoneName,
      url: url,
      format: 'raw',
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.brightDataKey}`,
      },
      timeout: 90000, // 90s for Bright Data
    });

    const html = response.data;
    // BRO-4936: the 200 is billed whether or not the body turns out blocked.
    recordBdCall({ url, fn: 'collector-tier3', success: true, status: response.status });

    if (isBlocked(html)) {
      throw new Error('Access blocked in Bright Data response');
    }

    const text = extractTextFromHtml(html, url);

    if (text && text.length > 500) {
      stats.tier3Success++;
      return { html, text };
    }

    throw new Error(`Insufficient text: ${text?.length || 0} chars`);
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      const message = error.response.data?.message || error.response.data || error.message;
      recordBdCall({ url, fn: 'collector-tier3', success: false, status });
      throw new Error(`Bright Data error (${status}): ${message}`);
    }
    throw error;
  }
}

// ============================================================================
// AMP VARIANT: Try /amp/ version of URL (many soft paywalls serve full text on AMP)
// ============================================================================

/**
 * Domains known to have AMP versions with full article text
 */
const AMP_SUPPORTED_DOMAINS = [
  'variety.com', 'hollywoodreporter.com', 'deadline.com',  // PMC network
  'ew.com', 'usatoday.com', 'time.com',
  'vulture.com', 'nymag.com',  // Vox Media
  'washingtonpost.com', 'nypost.com',
  'thewrap.com', 'thedailybeast.com', 'dailybeast.com',
  'huffpost.com', 'huffingtonpost.com',
  'timeout.com', 'newsday.com', 'amny.com',
  'nydailynews.com', 'chicagotribune.com',
];

function getAmpUrl(url) {
  try {
    const parsed = new URL(url);
    const domain = parsed.hostname.replace(/^www\./, '');
    if (!AMP_SUPPORTED_DOMAINS.includes(domain)) return null;
    // Skip if already an AMP URL
    if (parsed.pathname.includes('/amp') || parsed.pathname.endsWith('/amp/')) return null;
    // Append /amp/ to the path
    const ampPath = parsed.pathname.endsWith('/') ? parsed.pathname + 'amp/' : parsed.pathname + '/amp/';
    return `${parsed.protocol}//${parsed.host}${ampPath}${parsed.search}`;
  } catch {
    return null;
  }
}

async function fetchAmpVariant(url, review) {
  stats.ampAttempts++;
  const ampUrl = getAmpUrl(url);
  if (!ampUrl) throw new Error('No AMP variant available for this domain');

  console.log(`    → Trying AMP: ${ampUrl.substring(0, 80)}...`);

  // Use Playwright with the AMP URL
  const browserOk = await ensureBrowserHealthy();
  if (!browserOk) throw new Error('Browser unavailable');

  await page.setExtraHTTPHeaders({ 'Referer': 'https://www.google.com/' });
  await page.goto(ampUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout });

  await Promise.race([
    page.waitForSelector('article', { timeout: 10000 }),
    page.waitForSelector('.article-body', { timeout: 10000 }),
    page.waitForSelector('amp-story', { timeout: 10000 }),
    page.waitForTimeout(8000),
  ]).catch(() => {});

  const html = await page.content();
  if (isBlocked(html)) throw new Error('AMP page blocked');

  const text = await extractArticleText(page);
  if (text && text.length > 500) {
    stats.ampSuccess++;
    return { html, text, ampUrl };
  }
  throw new Error(`AMP insufficient text: ${text?.length || 0} chars`);
}

// ============================================================================
// TIER 3.6: Archive.today (archive.ph) — community-archived paywall bypasses
// ============================================================================

async function fetchFromArchiveToday(url) {
  stats.tier3_6Attempts++;

  const checkUrl = `https://archive.ph/newest/${url}`;
  console.log(`    → Checking archive.today...`);

  try {
    const axios = require('axios');
    // First, check if the URL has been archived (follows redirect to archived page)
    const resp = await axios.get(checkUrl, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      validateStatus: (s) => s < 500,
    });

    if (resp.status === 404 || (resp.status === 302 && !resp.headers.location)) {
      throw new Error('No archive.today snapshot found');
    }

    // Extract text from the archived page HTML
    const html = typeof resp.data === 'string' ? resp.data : '';
    if (html.length < 500) throw new Error('Empty archive.today response');

    // Extract text from the archived HTML (strip scripts, styles, tags)
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#\d+;/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (text && text.length > 500) {
      stats.tier3_6Success++;
      console.log(`    ✓ Archive.today: ${text.length} chars`);
      return { html, text, archiveTodayUrl: resp.request?.res?.responseUrl || checkUrl };
    }

    throw new Error(`Insufficient text from archive.today: ${text?.length || 0} chars`);
  } catch (error) {
    if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
      throw new Error('Archive.today timeout');
    }
    throw error;
  }
}

// ============================================================================
// TIER 4: Archive.org Wayback Machine
// ============================================================================

async function fetchFromArchive(url) {
  if (!axios) {
    throw new Error('axios not available');
  }

  stats.tier4Attempts++;

  // Rate-limit: wait at least ARCHIVE_ORG_MIN_DELAY_MS between requests
  const elapsed = Date.now() - archiveOrgLastRequestTime;
  if (elapsed < ARCHIVE_ORG_MIN_DELAY_MS) {
    await new Promise(resolve => setTimeout(resolve, ARCHIVE_ORG_MIN_DELAY_MS - elapsed));
  }
  archiveOrgLastRequestTime = Date.now();

  // Check if snapshots exist
  const availabilityUrl = `http://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
  const availability = await axios.get(availabilityUrl, { timeout: 15000 });

  const snapshot = availability.data?.archived_snapshots?.closest;
  if (!snapshot || !snapshot.url) {
    throw new Error('No archive snapshot available');
  }

  console.log(`    → Found archive from ${snapshot.timestamp}`);

  // Fetch the archived version
  const response = await axios.get(snapshot.url, {
    timeout: CONFIG.apiTimeout,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
  });

  const html = response.data;
  const text = extractTextFromHtml(html, url);

  if (text && text.length > 500) {
    stats.tier4Success++;
    return {
      html,
      text,
      archiveTimestamp: snapshot.timestamp,
      archiveUrl: snapshot.url,
    };
  }

  throw new Error(`Insufficient text in archive: ${text?.length || 0} chars`);
}

/**
 * Archive.org CDX multi-snapshot fetcher.
 * Uses the CDX API to find multiple archived snapshots, then tries oldest-first
 * (pre-paywall snapshots are more likely to have full text).
 * Rate limited: 2s between snapshot fetches to respect CDX ~15 req/min limit.
 */
async function fetchFromArchiveCDX(url) {
  if (!axios) {
    throw new Error('axios not available');
  }

  // Rate-limit: wait at least ARCHIVE_ORG_MIN_DELAY_MS between requests
  const elapsed = Date.now() - archiveOrgLastRequestTime;
  if (elapsed < ARCHIVE_ORG_MIN_DELAY_MS) {
    await new Promise(resolve => setTimeout(resolve, ARCHIVE_ORG_MIN_DELAY_MS - elapsed));
  }
  archiveOrgLastRequestTime = Date.now();

  // Query CDX API for snapshots
  // New Yorker articles go back to 2008+, so use wider date range for paywalled sites
  const isPaywalledSite = url.includes('newyorker.com') || url.includes('nytimes.com') || url.includes('wsj.com');
  const fromYear = isPaywalledSite ? '2008' : '2014';
  const snapshotLimit = isPaywalledSite ? 20 : 10;
  const cdxUrl = `http://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=${snapshotLimit}&from=${fromYear}&to=2026`;
  const cdxResp = await axios.get(cdxUrl, { timeout: 15000 });

  const rows = cdxResp.data;
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error('No CDX snapshots found');
  }

  // First row is header: [urlkey, timestamp, original, mimetype, statuscode, digest, length]
  const snapshots = rows.slice(1)
    .filter(row => row[4] === '200' && (row[3] || '').includes('text/html'))
    .sort((a, b) => a[1].localeCompare(b[1])); // oldest-first

  if (snapshots.length === 0) {
    throw new Error('No usable CDX snapshots (all non-200 or non-HTML)');
  }

  console.log(`    → CDX found ${snapshots.length} snapshots (oldest: ${snapshots[0][1]}, newest: ${snapshots[snapshots.length - 1][1]})`);

  // Try more snapshots for paywalled sites (pre-paywall snapshots are gold)
  const maxAttempts = Math.min(snapshots.length, isPaywalledSite ? 5 : 3);
  let lastError = null;

  for (let i = 0; i < maxAttempts; i++) {
    const [, timestamp, original] = snapshots[i];
    const archiveUrl = `http://web.archive.org/web/${timestamp}/${original}`;

    try {
      const response = await axios.get(archiveUrl, {
        timeout: CONFIG.apiTimeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      });

      const html = response.data;
      const text = extractTextFromHtml(html, original);

      if (text && text.length > 500) {
        console.log(`    → CDX snapshot ${timestamp} yielded ${text.length} chars`);
        return {
          html,
          text,
          archiveTimestamp: timestamp,
          archiveUrl,
        };
      }

      console.log(`    → CDX snapshot ${timestamp}: only ${text?.length || 0} chars, trying next...`);
    } catch (err) {
      console.log(`    → CDX snapshot ${timestamp} failed: ${err.message}`);
      lastError = err;
    }

    // Rate limit: 2s between snapshot fetches
    if (i < maxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  throw new Error(lastError?.message || `All ${maxAttempts} CDX snapshots had insufficient text`);
}

// ============================================================================
// TIMEOUT URL RESOLVER - TimeOut merged reviews into listing pages
// Their standalone review URLs (e.g., /suffs-review) now 404.
// Reviews live on listing pages (e.g., /hamilton-1, /aladdin-1).
// ============================================================================

/**
 * Try known TimeOut listing URL patterns before falling back to SERP discovery.
 * No API cost - just direct HEAD requests to candidate URLs.
 */
async function resolveTimeoutListingUrl(review) {
  if (!review.url) return null;
  let hostname;
  try { hostname = new URL(review.url).hostname; } catch (e) { return null; }
  if (!hostname.includes('timeout.com')) return null;

  const showSlug = (review.showId || '').replace(/-\d{4}$/, '');
  if (!showSlug) return null;

  // Candidate URL patterns (ordered by likelihood)
  const candidates = [
    `https://www.timeout.com/newyork/theater/${showSlug}-1`,
    `https://www.timeout.com/newyork/theater/${showSlug}`,
    `https://www.timeout.com/newyork/theater/${showSlug}-broadway`,
    `https://www.timeout.com/newyork/theater/${showSlug}-on-broadway-tickets-and-information`,
  ];

  // Skip the URL we already tried
  const tried = review.url.replace(/^http:/, 'https:');
  const toTry = candidates.filter(c => c !== tried);

  for (const url of toTry) {
    try {
      const resp = await axios.head(url, {
        timeout: 10000,
        maxRedirects: 3,
        validateStatus: (s) => s < 400,
      });
      if (resp.status < 400) {
        console.log(`    ✓ TimeOut listing found: ${url}`);
        return url;
      }
    } catch (e) {
      // 404 or network error - try next candidate
    }
  }
  return null;
}

// ============================================================================
// URL DISCOVERY - Find correct URLs for reviews with dead/fabricated links
// Uses shared url-discovery.js module (BD-first SERP, date range filtering,
// domain alias matching, stripped-title retries, URL year checks).
// ============================================================================

const URL_DISCOVERY_MAX_PER_RUN = parseInt(process.env.URL_DISCOVERY_LIMIT, 10) || 1000; // Cap SERP API calls to control costs (env: URL_DISCOVERY_LIMIT)
let _showsJsonCache = null; // Cached shows.json data (used by URL discovery + content validation)

/**
 * Thin wrapper around shared url-discovery.js discoverCorrectUrl.
 * Adds per-run cap, stats tracking, UNCOLLECTABLE_OUTLETS filter, AND the
 * lifecycle-aware SERP retry gate (shouldRetryUrlDiscovery). The gate stops
 * re-SERPing stuck wrong_content reviews on closed-old shows where the SERP
 * date window is frozen. See sprint-plan-serp-cost-reduction.md.
 */
async function discoverCorrectUrl(review) {
  if (!CONFIG.scrapingBeeKey && !CONFIG.brightDataKey) return null;
  if (UNCOLLECTABLE_OUTLETS.has((review.outletId || '').toLowerCase())) return null;

  // Look up show metadata for the lifecycle gate (null is safe — guard treats
  // missing show as 'unknown' lifecycle with default retry behavior).
  let showMeta = null;
  try {
    if (!_showsJsonCache) _showsJsonCache = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
    showMeta = _showsJsonCache.shows.find(s => s.id === review.showId) || null;
  } catch (e) { /* shows.json unavailable — fall through with null */ }

  // Lifecycle retry gate: stops re-SERPing stuck wrong_content files, applies
  // cooldown to no_url files, and short-circuits serpDiscoveryAbandoned files.
  const gate = shouldRetryUrlDiscovery(showMeta, review);
  if (!gate.shouldRetry) {
    const detail = gate.nextAttemptAt ? ` (next ${gate.nextAttemptAt.slice(0, 10)})` : '';
    console.log(`    [serp-gate] Skipping URL discovery: ${gate.reason}${detail}`);
    stats.urlDiscoveryGated = (stats.urlDiscoveryGated || 0) + 1;
    // If the gate returned a terminal-state patch (e.g. just crossed max-retries),
    // write it now so the next run fast-paths on 'abandoned' without re-evaluating.
    if (gate.updates && review.filePath) {
      try {
        const fileData = readReviewForUpdate(review.filePath);
        Object.assign(fileData, gate.updates);
        persistReviewSnapshot({ filePath: review.filePath, data: fileData, trailingNewline: true });
      } catch (e) { /* non-fatal — gate will re-evaluate next run */ }
    }
    return null;
  }

  // Per-run cap to prevent runaway SERP API costs
  if (stats.urlDiscoveryAttempts >= URL_DISCOVERY_MAX_PER_RUN) {
    stats.urlDiscoveryCapped++;
    console.log(`    ⚠ URL discovery capped (${URL_DISCOVERY_MAX_PER_RUN}/run limit reached)`);
    return null;
  }

  stats.urlDiscoveryAttempts++;

  // Delegate to shared url-discovery.js module (handles show lookup, market awareness,
  // date range filtering, domain aliases, stripped-title retries, URL year checks,
  // BD-first SERP ordering with preferSpeed support)
  const result = await _sharedDiscoverUrl(review, CONFIG.scrapingBeeKey || '', {
    brightDataKey: CONFIG.brightDataKey || '',
    log: (msg) => console.log(msg),
  });

  // Record attempt state BEFORE returning — advances serpRetryCount/cooldown
  // whether the SERP succeeded or failed. Perpetually-null responses must
  // still progress toward abandonment, not retry forever.
  if (review.filePath && result !== '__SERP_UNAVAILABLE__') {
    try {
      const attemptUpdates = recordSerpAttempt(showMeta, review);
      if (Object.keys(attemptUpdates).length > 0) {
        const fileData = readReviewForUpdate(review.filePath);
        Object.assign(fileData, attemptUpdates);
        persistReviewSnapshot({ filePath: review.filePath, data: fileData, trailingNewline: true });
      }
    } catch (e) { /* non-fatal — next run re-evaluates */ }
  }

  if (result === '__SERP_UNAVAILABLE__') return '__SERP_UNAVAILABLE__';

  // BRO-4430: refuse a discovered url that is an aggregator/round-up page or
  // that a sibling file already holds for a DIFFERENT named critic. Checked
  // here, before any fetch: the show-not-mentioned path fetches the new url
  // and writes its text into this file BEFORE persisting the url, so a refusal
  // only at persist time (url-change-invariant) would still leave another
  // critic's review text in this critic's file (NYSR Finkle/Scheck).
  if (result && result !== '__SERP_UNAVAILABLE__' && review.filePath) {
    const { isAggregatorPageUrl, urlOwnedByOtherCritic } = require('./lib/review-slot-guards');
    const owner = urlOwnedByOtherCritic({
      showDir: path.dirname(review.filePath),
      url: result,
      selfFilename: path.basename(review.filePath),
      selfCriticName: review.critic,
    });
    if (isAggregatorPageUrl(result) || owner) {
      console.log(`    ⊘ Discovered url refused: ${result} ${owner ? `is ${owner.criticName}'s review (${owner.filename})` : 'is an aggregator/round-up page'}`);
      stats.urlDiscoveryRefused = (stats.urlDiscoveryRefused || 0) + 1;
      return null;
    }
  }

  if (result && result !== null) {
    stats.urlDiscoverySuccess++;
    stats.urlDiscoveryDetails.push({
      reviewId: review.reviewId || `${review.showId}/${review.file}`,
      oldUrl: review.url,
      newUrl: result,
    });
  }

  return result;
}

// ============================================================================
// QUALITY GATE + TIMEOUT HELPERS (for tier chain loop)
// ============================================================================

/**
 * Quality gate — returns garbage reason string or null.
 * Uses isGarbageContent() not assessTextQuality() — the full assessor has a 5.5%
 * false positive rate on known-good reviews (multi-show mentions, article boundaries).
 * isGarbageContent() has 0% false positives and catches paywall pages, newsletters,
 * ad-blockers, error pages, and nav junk.
 */
function checkContentQuality(text) {
  const check = isGarbageContent(text);
  if (check.isGarbage) {
    return check.reason;
  }
  return null;
}

/**
 * Timeout wrapper for tier execution.
 * Returns the promise result or rejects with a timeout error.
 */
function withTimeout(promise, ms, tierName) {
  if (!ms) return promise;
  // Shared helper clears its timer once the race settles (BRO-4273, BRO-2427).
  return sharedWithTimeout(promise, ms, { message: tierName === 'REVIEW_TIMEOUT' ? tierName : `${tierName} timed out after ${ms}ms` });
}

// ============================================================================
// UNIFIED FETCH FUNCTION
// ============================================================================

/**
 * Build the context object describing URL properties and mutable state signals
 * used by tier shouldRun predicates and onFailure hooks.
 */
function buildTierContext(review) {
  // Strip browser-only fragment hashes (#google_vignette etc) — HTTP servers never see them
  const url = (review.url || '').replace(/#[^#]*$/, '');
  const urlLower = url.toLowerCase();

  const isKnownBlocked = CONFIG.knownBlockedSites.some(s => urlLower.includes(s));
  const hasCookiesLoaded = !!hasCookiesForUrl(url);
  const isArchiveFirstSite = CONFIG.archiveFirstSites.some(s => urlLower.includes(s));

  let isOldReview = false;
  if (review.publishDate) {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    isOldReview = review.publishDate < sixMonthsAgo;
  }

  const archiveFirstExplicitlyDisabled = process.env.ARCHIVE_FIRST === 'false';

  // Reason-aware routing: override tier strategy based on incompleteReason.
  // Ignore stale incompleteReason when the review already has complete text — a different
  // source (Theatre Record, WET, etc.) may have provided full content after the flag was set.
  const alreadyComplete = review.contentTier === 'complete' || review.textQuality === 'full';
  const reason = alreadyComplete ? '' : (review.incompleteReason || '');
  // NOT scraper_garbage — many got garbage FROM archive.org, so archive-first creates a loop
  const forceArchiveFirst = ['paywall', 'partial_text'].includes(reason);
  // Only skip direct scrapers for paywall if we DON'T have cookies (cookies = try Playwright first)
  const skipDirectScrapers = reason === 'paywall' && !getPaywallCredentials(url)?.email;
  const enableBrowserbase = reason === 'bot_blocked' || reason === 'url_content_mismatch' || reason === 'route_capped';

  const isArchiveFirst = forceArchiveFirst || (!archiveOrgDisabledForBatch &&
    ((!archiveFirstExplicitlyDisabled && isArchiveFirstSite) || (CONFIG.archiveFirst && isOldReview)));
  const hasPaywallCreds = !!getPaywallCredentials(url)?.email;

  return {
    url,
    urlLower,
    isKnownBlocked,
    hasCookiesLoaded,
    isArchiveFirst,
    hasPaywallCreds,
    // Reason-aware routing signals
    skipDirectScrapers,
    enableBrowserbase,
    // Mutable signals set by onFailure hooks, read by later shouldRun predicates
    sawCaptcha: false,
    sawPaywall: false,
    anyTierFailed: false,
    _playwright404NoCreds: false,
    _bail404: false,
    consecutive404Count: 0,
    _archiveTierRan: false,
    _archiveCdxRan: false,
  };
}

/**
 * Execute a forced tier directly (CLI --force-tier flag).
 * Bypasses the quality gate — returns raw tier output.
 */
async function executeForcedTier(tier, url, review) {
  try {
    switch (tier) {
      case 1: {
        const r = await fetchWithPlaywright(url, review);
        return { html: r.html, text: r.text, method: 'playwright', attempts: [{ tier: 1, method: 'playwright', success: true }] };
      }
      case 1.5: {
        const r = await fetchWithBrowserbase(url, review);
        return { html: r.html, text: r.text, method: 'browserbase', attempts: [{ tier: 1.5, method: 'browserbase', success: true }] };
      }
      case 2: {
        const r = await fetchWithScrapingBee(url);
        return { html: r.html, text: r.text, method: 'scrapingbee', attempts: [{ tier: 2, method: 'scrapingbee', success: true }] };
      }
      case 3: {
        const r = await fetchWithBrightData(url);
        return { html: r.html, text: r.text, method: 'brightdata', attempts: [{ tier: 3, method: 'brightdata', success: true }] };
      }
      case 1.1: {
        const r = await fetchAmpVariant(url, review);
        return { html: r.html, text: r.text, method: 'amp', attempts: [{ tier: 1.1, method: 'amp', success: true }] };
      }
      case 3.6: {
        const r = await fetchFromArchiveToday(url);
        return { html: r.html, text: r.text, method: 'archive-today', attempts: [{ tier: 3.6, method: 'archive-today', success: true }] };
      }
      case 4: {
        const r = await fetchFromArchive(url);
        return { html: r.html, text: r.text, method: 'archive', archiveData: r, attempts: [{ tier: 4, method: 'archive', success: true }] };
      }
    }
  } catch (e) {
    throw new Error(`Forced tier ${tier} failed: ${e.message}`);
  }
}

/**
 * Build the tier descriptor chain for fetchReviewText.
 * Each descriptor has: id, tierNumber, method, shouldRun(ctx), execute(url, review),
 * optional onFailure(error, ctx), onSuccess(review, result), timeoutMs.
 */
function buildTierChain(ctx, review) {
  return [
    // TIER 0: Archive.org first (for paywalled sites + old reviews when archiveFirst default is on)
    {
      id: 'archive-first',
      tierNumber: 0,
      method: 'archive-first',
      label: 'Archive.org (paywalled site - trying archive first)',
      shouldRun: () => ctx.isArchiveFirst,
      execute: (url) => fetchFromArchive(url),
      onSuccess: (review, result) => {
        ctx._archiveTierRan = true;
        archiveOrgConsecutiveFailures = 0; // Reset on success
      },
      onFailure: async (error) => {
        ctx._archiveTierRan = true;
        archiveOrgConsecutiveFailures++;
        if (archiveOrgConsecutiveFailures >= ARCHIVE_ORG_COOLDOWN_THRESHOLD && !archiveOrgDisabledForBatch) {
          archiveOrgCooldownCount++;
          if (archiveOrgCooldownCount >= ARCHIVE_ORG_MAX_COOLDOWNS) {
            archiveOrgDisabledForBatch = true;
            console.log(`    ⚠ Archive.org disabled for batch (${archiveOrgCooldownCount} cooldowns, ${archiveOrgConsecutiveFailures} total consecutive failures)`);
          } else {
            console.log(`    ⚠ Archive.org cooldown #${archiveOrgCooldownCount} (${archiveOrgConsecutiveFailures} consecutive failures) — waiting ${ARCHIVE_ORG_COOLDOWN_MS / 1000}s before retrying`);
            await new Promise(resolve => setTimeout(resolve, ARCHIVE_ORG_COOLDOWN_MS));
            archiveOrgConsecutiveFailures = 0; // Reset after cooldown
          }
        }
      },
    },

    // TIER 0.5: Archive.org CDX multi-snapshot (after Tier 0 fails for archive-first sites)
    {
      id: 'archive-cdx',
      tierNumber: 0.5,
      method: 'archive',
      label: 'Archive.org CDX multi-snapshot',
      shouldRun: () => ctx.isArchiveFirst && ctx._archiveTierRan,
      execute: (url) => fetchFromArchiveCDX(url),
      onSuccess: (review, result) => {
        ctx._archiveCdxRan = true;
        archiveOrgConsecutiveFailures = 0; // Reset on success
      },
      onFailure: (error) => { ctx._archiveCdxRan = true; },
    },

    // TIER 1: Playwright with stealth
    {
      id: 'playwright',
      tierNumber: 1,
      method: 'playwright',
      label: 'Playwright with stealth',
      shouldRun: () => {
        if (ctx.skipDirectScrapers) return false;
        return !ctx.isKnownBlocked || ctx.hasCookiesLoaded;
      },
      skipMessage: 'Skipped (known-blocked site, no cookies)',
      execute: (url) => fetchWithPlaywright(url, review),
      onFailure: (error) => {
        ctx.anyTierFailed = true;
        const msg = error.message || '';
        if (msg.includes('CAPTCHA') || msg.includes('blocked')) ctx.sawCaptcha = true;
        if (msg.includes('Paywall')) ctx.sawPaywall = true;
        if (msg.includes('404') && !ctx.hasPaywallCreds) {
          ctx._playwright404NoCreds = true;
        } else if (msg.includes('404') && ctx.hasPaywallCreds) {
          console.log('    → 404 on paywalled site with credentials - will try Browserbase login...');
        }
      },
    },

    // TIER 1.1: AMP variant (many soft paywalls serve full text on /amp/ pages)
    {
      id: 'amp-variant',
      tierNumber: 1.1,
      method: 'amp',
      label: 'AMP page variant (paywall bypass)',
      shouldRun: () => {
        // Only try AMP if Playwright got blocked/paywalled/insufficient AND domain has AMP
        if (!ctx.anyTierFailed && !ctx.sawPaywall) return false;
        return !!getAmpUrl(ctx.url);
      },
      execute: (url) => fetchAmpVariant(url, review),
      onSuccess: (review, result) => {
        state.tierBreakdown.amp.push(review.filePath);
      },
      onFailure: (error) => { /* AMP failed, continue to next tier */ },
    },

    // TIER 4 (early): Archive.org 404 recovery
    {
      id: 'archive-404-recovery',
      tierNumber: 4,
      method: 'archive',
      label: 'Archive.org (404 detected - skipping other tiers)',
      shouldRun: () => ctx._playwright404NoCreds,
      execute: (url) => fetchFromArchive(url),
      onSuccess: (review, result) => { ctx._archiveTierRan = true; },
      onFailure: (error) => {
        ctx._archiveTierRan = true;
        ctx._bail404 = true; // URL is dead — don't waste API credits
      },
    },

    // TIER 1.5: Browserbase (managed browser cloud + CAPTCHA solving + login)
    {
      id: 'browserbase',
      tierNumber: 1.5,
      method: 'browserbase',
      label: 'Browserbase (managed browser + CAPTCHA solving)',
      timeoutMs: 120000,
      shouldRun: () => {
        if (!CONFIG.browserbaseEnabled) return false;
        const wouldRoute = (
          ctx.isKnownBlocked || ctx.sawCaptcha || ctx.enableBrowserbase ||
          (ctx.hasPaywallCreds && (ctx.sawPaywall || ctx.anyTierFailed))
        );
        if (!wouldRoute) return false;
        // BRO-5243: never spend Browserbase on a host that is never a review.
        // Not a cap, so no deferral is recorded.
        if (isDeniedBrowserbaseHost(ctx.url)) return false;
        // browserbaseBlockReason() also enforces the per-domain cap when passed
        // the hostname, so the day/run/domain decision is unified in one place.
        let urlDomain;
        try { urlDomain = new URL(ctx.url).hostname.replace('www.', ''); } catch {}
        const blocked = browserbaseBlockReason(urlDomain);
        if (blocked && blocked !== 'disabled') {
          // The route this URL needs was not tried: record it so the failure
          // is a deferral, not evidence against the URL (BRO-5222).
          ctx.browserbaseCapSkipped = blocked;
          review._browserbaseCapSkipped = blocked;
        }
        return !blocked;
      },
      // Read only when shouldRun() returned false (see the tier loop).
      get skipMessage() {
        return ctx.browserbaseCapSkipped ? `Browserbase not attempted: ${ctx.browserbaseCapSkipped} cap reached` : null;
      },
      skipIsCap: true,
      execute: (url) => fetchWithBrowserbase(url, review),
      onSuccess: (review, result) => {
        state.tierBreakdown.browserbase.push(review.filePath);
      },
      onFailure: (error) => {
        ctx.anyTierFailed = true;
        // The session-create chokepoint can refuse even after the pre-check
        // passed (live account count, opening-window reserve): still a cap.
        // The mid-run live resync can also trip the local cap after shouldRun().
        const message = error && error.message;
        const chokepointCap = routeCapFromBrowserbaseError(message);
        if (chokepointCap === 'day') browserbaseChokepointCapped = true;
        if (chokepointCap === 'reserve') browserbaseReserveHeld = true;
        let urlDomain;
        try { urlDomain = new URL(ctx.url).hostname.replace('www.', ''); } catch {}
        const capped = routeCapFromBrowserbaseError(message, browserbaseBlockReason(urlDomain));
        if (capped) {
          ctx.browserbaseCapSkipped = capped;
          review._browserbaseCapSkipped = capped;
        }
      },
    },

    // TIER 1.8: Direct HTTP fetch with subscriber cookies (free, no proxy)
    // Bypasses headless browser fingerprinting that defeats Playwright/Browserbase.
    // Plain HTTP request with cookies + realistic headers — sites can't detect headless Chrome.
    {
      id: 'direct-cookies',
      tierNumber: 1.8,
      method: 'direct-cookies',
      label: 'Direct HTTP fetch with cookies',
      shouldRun: () => {
        // Only run if we have cookies for this domain AND previous tiers failed
        if (!ctx.hasCookiesLoaded) return false;
        return ctx.anyTierFailed || ctx.sawPaywall || ctx.sawCaptcha;
      },
      execute: (url) => fetchWithDirectCookies(url),
      onSuccess: (review, result) => {
        // Track in scrapingbee breakdown since we don't have a separate counter
        // (adds zero cost — this is a free tier)
      },
      onFailure: (error) => {
        ctx.anyTierFailed = true;
        const msg = error.message || '';
        if (msg.includes('expired')) {
          ctx._cookiesExpired = true;
          // Aggregate for end-of-run Discord alert
          try {
            const domain = new URL(ctx.url || '').hostname.replace(/^www\./, '');
            stats.cookieExpiries[domain] = (stats.cookieExpiries[domain] || 0) + 1;
            stats.cookieExpiryCount++;
          } catch {
            stats.cookieExpiryCount++;
          }
          console.warn(`  ⚠ COOKIE EXPIRED: ${ctx.url} — falling back to lower tiers`);
        }
      },
    },

    // TIER 1.9: Scrapingdog (cheapest API tier — 1 cr plain / 5 cr JS, vs SB's
    // 1/10/75). Sits just ahead of ScrapingBee so any page SD can fetch never
    // reaches SB; SD failures fall straight through to the SB/BD safety net.
    {
      id: 'scrapingdog',
      tierNumber: 1.9,
      method: 'scrapingdog',
      label: 'Scrapingdog API',
      shouldRun: () => {
        if (ctx.skipDirectScrapers) return false;
        return !!process.env.SCRAPINGDOG_API_KEY;
      },
      execute: (url) => fetchWithScrapingdogText(url),
      onFailure: (error) => { ctx.anyTierFailed = true; },
    },

    // TIER 2: ScrapingBee API (now with cookie forwarding for paywalled sites)
    {
      id: 'scrapingbee',
      tierNumber: 2,
      method: 'scrapingbee',
      label: 'ScrapingBee API',
      shouldRun: () => {
        if (ctx.skipDirectScrapers) return false;
        return !!CONFIG.scrapingBeeKey;
      },
      execute: (url) => fetchWithScrapingBee(url, false),
      onFailure: (error) => {
        ctx.anyTierFailed = true;
        if (error.message?.includes('404')) {
          ctx.consecutive404Count++;
        }
      },
    },

    // TIER 3: Bright Data Web Unlocker
    {
      id: 'brightdata',
      tierNumber: 3,
      method: 'brightdata',
      label: 'Bright Data Web Unlocker',
      shouldRun: () => {
        if (ctx.skipDirectScrapers) return false;
        return !!CONFIG.brightDataKey;
      },
      execute: (url) => fetchWithBrightData(url),
      onFailure: (error) => { ctx.anyTierFailed = true; },
    },

    // TIER 3.5: Archive.org CDX multi-snapshot (final fallback for non-archive-first sites)
    {
      id: 'archive-cdx-final',
      tierNumber: 3.5,
      method: 'archive',
      label: 'Archive.org CDX multi-snapshot (fallback)',
      shouldRun: () => !ctx._archiveCdxRan,
      execute: (url) => fetchFromArchiveCDX(url),
      onSuccess: (review, result) => { ctx._archiveCdxRan = true; },
      onFailure: (error) => { ctx._archiveCdxRan = true; },
    },

    // TIER 3.6: Archive.today (community-archived paywall content)
    {
      id: 'archive-today',
      tierNumber: 3.6,
      method: 'archive-today',
      label: 'Archive.today (community archive)',
      shouldRun: () => ctx.anyTierFailed, // Only try if everything else failed
      execute: (url) => fetchFromArchiveToday(url),
      onSuccess: (review, result) => {
        state.tierBreakdown.archiveToday.push(review.filePath);
      },
      onFailure: (error) => { /* Archive.today failed, continue to Archive.org */ },
    },

    // TIER 4: Archive.org (last resort)
    {
      id: 'archive-final',
      tierNumber: 4,
      method: 'archive',
      label: 'Archive.org Wayback Machine',
      shouldRun: () => !ctx._archiveTierRan,
      execute: (url) => fetchFromArchive(url),
      onSuccess: (review, result) => { ctx._archiveTierRan = true; },
      onFailure: (error) => { ctx._archiveTierRan = true; },
    },
  ];
}

async function fetchReviewText(review) {
  // A cap mark from an earlier attempt (e.g. before a discovered-URL retry)
  // must not label this attempt's failure as a deferral.
  delete review._browserbaseCapSkipped;
  const ctx = buildTierContext(review);
  const url = ctx.url;

  // Guardian Content API shortcut — clean body text without 64K page furniture.
  // ScrapingBee grabs entire page HTML (nav, footer, JS, cookie banners).
  // The Content API returns clean article body + starRating. Saves ~$0.13/review in scoring tokens.
  // (Titanique postmortem: Guardian text was 64K garbage, scorer burned 40K tokens.)
  if (url && url.includes('theguardian.com') && process.env.GUARDIAN_API_KEY) {
    try {
      const articlePath = url.replace(/^https?:\/\/(www\.)?theguardian\.com\//, '').replace(/\/$/, '');
      const apiUrl = `https://content.guardianapis.com/${articlePath}?api-key=${process.env.GUARDIAN_API_KEY}&show-fields=body,starRating,bodyText,headline`;
      const resp = await fetch(apiUrl, { signal: AbortSignal.timeout(60000) });
      if (resp.ok) {
        const json = await resp.json();
        const { resolveShowMeta } = require('./lib/show-identity');
        const { result, reason } = guardianContentToResult(json.response?.content, { show: resolveShowMeta(review.showId) });
        if (result) {
          console.log(`  ✓ Guardian Content API: ${result.text.length} chars` +
            (result.apiMeta.score ? ` (${result.apiMeta.score.originalScore})` : ''));
          return result;
        }
        console.log(`  ⚠ Guardian API: ${reason}, falling back to scraper chain...`);
      } else {
        console.log(`  ⚠ Guardian API HTTP ${resp.status}, falling back to scraper chain...`);
      }
    } catch (e) {
      console.log(`  ⚠ Guardian API error: ${e.message}, falling back to scraper chain...`);
    }
  }

  // Force specific tier if requested (bypasses quality gate)
  if (CLI.forceTier) {
    return executeForcedTier(parseFloat(CLI.forceTier), url, review);
  }

  // Diagnostic: log Browserbase routing state for paywalled sites
  if (ctx.hasPaywallCreds) {
    console.log(`  [Browserbase routing] enabled=${CONFIG.browserbaseEnabled} isBlocked=${ctx.isKnownBlocked} creds=${ctx.hasPaywallCreds}`);
  }

  let chain = buildTierChain(ctx, review);
  const builtChain = chain; // before reorder/skip, for pinBrowserbaseFirst below

  // Reorder tier chain based on domain-specific success rates.
  // Tiers listed in DOMAIN_TIER_ORDER for this domain get moved to the front (in priority order).
  // Tiers NOT listed stay at the end in their default order — nothing is skipped.
  try {
    const urlDomain = new URL(url).hostname.replace('www.', '');
    const domainOrder = DOMAIN_TIER_ORDER[urlDomain];
    if (domainOrder && domainOrder.length > 0) {
      const prioritized = [];
      const remaining = [];
      // Build index of tier IDs → tier objects
      const tierById = {};
      for (const tier of chain) tierById[tier.id] = tier;
      // Add prioritized tiers in order
      for (const tierId of domainOrder) {
        if (tierById[tierId]) {
          prioritized.push(tierById[tierId]);
          delete tierById[tierId];
        }
      }
      // Add remaining tiers in original order
      for (const tier of chain) {
        if (tierById[tier.id]) remaining.push(tier);
      }
      chain = [...prioritized, ...remaining];
    }
  } catch {}

  // Remove tiers that are proven dead ends for this domain (3+ failures, 0 successes).
  // Saves 15-30s per skipped tier per review.
  try {
    const urlDomain = new URL(url).hostname.replace('www.', '');
    const skipSet = getSkippedTiers(DOMAIN_TIER_SKIP, urlDomain);
    if (skipSet.size > 0) {
      chain = chain.filter(tier => !skipSet.has(tier.id));
    }
  } catch {}

  // Browserbase-first outlets (WSJ) try Browserbase before paid tiers. Applied
  // after the learned order and the skip list, which are regenerated weekly
  // from attempt stats and dropped Browserbase for wsj.com (BRO-5222).
  try {
    chain = pinBrowserbaseFirst(chain, new URL(url).hostname, builtChain);
  } catch {}

  const attempts = [];
  let bestResult = null; // Track longest non-empty text from garbage tiers
  // BRO-4334: best non-garbage but INCOMPLETE result on a hard-paywall domain
  // (e.g. ScrapingBee returning only page one of an NYT review). Kept while
  // later tiers (logged-in Browserbase, cookies, archive) get a chance.
  let bestPartial = null;
  // Once a partial is in hand, later tiers must finish inside the per-review
  // REVIEW_TIMEOUT or the whole review is dropped (partial included). Stop
  // trying — and cap each tier's timeout — 30s before that deadline (leaves
  // room for processReview's post-fetch validation/verification + write).
  // Anchored on processReview's start (the REVIEW_TIMEOUT race's clock), not
  // this call's — pre-fetch work and a URL-discovery retry share the budget.
  const reviewStartedAt = Number.isFinite(review._reviewStartedAt) ? review._reviewStartedAt : Date.now();
  const partialDeadline = reviewStartedAt + Math.max(CONFIG.reviewTimeout - 30000, 20000);

  let queue = [...chain];
  while (queue.length > 0) {
    const tier = queue.shift();
    // Bail conditions (a partial already in hand is returned below instead)
    if (bestPartial && (ctx._bail404 || ctx.consecutive404Count >= 2)) break;
    if (ctx._bail404) {
      throw new Error(`URL returned 404 (archive also failed): ${JSON.stringify(attempts)}`);
    }
    if (ctx.consecutive404Count >= 2) {
      throw new Error(`URL confirmed dead (404 from multiple tiers): ${JSON.stringify(attempts)}`);
    }

    // Check shouldRun predicate
    if (!tier.shouldRun()) {
      if (tier.skipMessage) {
        console.log(`  [Tier ${tier.tierNumber}] ${tier.skipMessage}`);
        // skipped: the tier never ran, so tier-attempt-stats must not count
        // it as a failure for the domain (BRO-5222).
        attempts.push({ tier: tier.tierNumber, method: tier.method, success: false, error: tier.skipMessage, ...(tier.skipIsCap ? { skipped: true } : {}) });
      }
      continue;
    }

    let tierTimeoutMs = tier.timeoutMs;
    if (bestPartial) {
      const remaining = partialDeadline - Date.now();
      if (remaining < 5000) {
        console.log(`  [Tier ${tier.tierNumber}] Skipped — review time budget spent; keeping best partial`);
        break;
      }
      tierTimeoutMs = tierTimeoutMs ? Math.min(tierTimeoutMs, remaining) : remaining;
    }

    // Execute tier
    console.log(`  [Tier ${tier.tierNumber}] ${tier.label}...`);
    let result;
    try {
      result = await withTimeout(tier.execute(url), tierTimeoutMs, tier.id);
    } catch (error) {
      console.log(`    ✗ Failed: ${error.message}`);
      attempts.push({ tier: tier.tierNumber, method: tier.method, success: false, error: error.message });
      if (tier.onFailure) await tier.onFailure(error, ctx);
      continue;
    }

    // Tier succeeded — log result
    console.log(`    ✓ ${tier.id} returned ${result.text?.length || 0} chars`);
    attempts.push({ tier: tier.tierNumber, method: tier.method, success: true });

    // Quality gate: check for garbage content (paywall pages, newsletters, nav junk)
    const garbageReason = checkContentQuality(result.text);
    if (garbageReason) {
      console.log(`    ⚠ ${tier.id} returned garbage: ${garbageReason} — trying next tier`);
      // Track best-of-garbage as fallback
      if (!bestResult || (result.text?.length || 0) > (bestResult.text?.length || 0)) {
        bestResult = { ...result, method: tier.method === 'archive-first' || tier.method === 'archive' ? 'archive' : tier.method };
        if (tier.method === 'archive-first' || tier.method === 'archive') bestResult.archiveData = result;
      }
      if (tier.onFailure) tier.onFailure(new Error(`garbage: ${garbageReason}`), ctx);
      continue;
    }

    // Accept result
    const accepted = {
      html: result.html,
      text: result.text,
      method: tier.method === 'archive-first' ? 'archive' : tier.method,
      attempts,
    };
    if (tier.method === 'archive-first' || tier.method === 'archive') {
      accepted.archiveData = result;
    }

    // BRO-4334 completeness gate (hard-paywall domains only; a no-op elsewhere):
    // partial text keeps the loop going so later tiers can deliver the whole
    // review; the best partial is the fallback if none does.
    const paywallDecision = decidePaywallTierResult({
      best: bestPartial,
      // _onSuccess defers this tier's success hook until (unless) the partial
      // is the one finally returned.
      candidate: { ...accepted, _onSuccess: tier.onSuccess ? () => tier.onSuccess(review, result) : null },
      url,
      criticName: review.criticName || review.critic, // queued reviews carry `critic`
    });
    if (paywallDecision.action === 'continue') {
      const a = paywallDecision.assessment;
      console.log(`    ⚠ ${tier.id} returned partial text (${a.reasons.join(', ')}) — trying next tier`);
      // Record as a non-success so regenerate-tier-configs ranks this tier by
      // COMPLETE results, not by "returned something" (partial: true lets it
      // exempt the tier from the dead-end skip list).
      const last = attempts[attempts.length - 1];
      if (last) { last.success = false; last.partial = true; last.error = `partial: ${a.reasons.join(', ')}`; }
      // First partial: run the logged-in tiers next (see escalateAfterPartial).
      if (!bestPartial) queue = escalateAfterPartial(queue);
      bestPartial = paywallDecision.best;
      // Unlock the credentialed tiers' shouldRun (browserbase, direct-cookies,
      // amp, archive-today). Deliberately NOT tier.onFailure: the page exists,
      // so archive-first's failure cooldown / archive-404's _bail404 must not fire.
      ctx.sawPaywall = true;
      ctx.anyTierFailed = true;
      if (tier.id === 'archive-first' || tier.id === 'archive-404-recovery' || tier.id === 'archive-final') ctx._archiveTierRan = true;
      if (tier.id === 'archive-cdx' || tier.id === 'archive-cdx-final') ctx._archiveCdxRan = true;
      continue;
    }

    if (tier.onSuccess) tier.onSuccess(review, result);
    return accepted;
  }

  // Hard-paywall: no tier produced complete text — use the best partial
  // (longest assessed body). processReview + updateReviewJson then tier it
  // 'truncated' so the opening-window refetch picks it up again.
  if (bestPartial) {
    console.log(`  ⚠ No tier returned complete text — using best partial via ${bestPartial.method} (${bestPartial.assessment.length} chars: ${bestPartial.assessment.reasons.join(', ')})`);
    if (bestPartial._onSuccess) bestPartial._onSuccess();
    const { assessment, _onSuccess, ...partial } = bestPartial;
    partial.attempts = attempts;
    partial.partial = true;
    partial.paywallAssessment = assessment;
    return partial;
  }

  // All tiers exhausted — return best-of-garbage if available
  if (bestResult) {
    console.log(`  ⚠ All tiers returned garbage — using best result (${bestResult.text?.length} chars)`);
    bestResult.attempts = attempts;
    return bestResult;
  }

  throw new Error(`All tiers failed: ${JSON.stringify(attempts)}`);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getPaywallCredentials(url) {
  for (const [domain, creds] of Object.entries(CONFIG.paywalledDomains)) {
    if (url.includes(domain)) {
      const email = process.env[creds.emailVar];
      const password = process.env[creds.passVar] || (creds.altPassVar && process.env[creds.altPassVar]);
      if (email && password) {
        return { domain, email, password };
      }
      return { domain, email: null, password: null };
    }
  }
  return null;
}

function isBlocked(html) {
  if (!html || typeof html !== 'string') return true;
  // TollBit bot paywall (THR/Variety/Deadline 402 JSON, BRO-5222).
  if (isTollbitGate(html)) return true;
  // Very short HTML = definitely blocked (error page or empty response)
  if (html.length < 1000) {
    const lower = html.toLowerCase();
    return (
      lower.includes('access denied') ||
      lower.includes('403 forbidden') ||
      lower.includes('blocked') ||
      lower.includes('robot check') ||
      lower.includes('rate limit')
    );
  }
  // For longer pages: check the visible text content, not script tags
  // Extract just the body text (strip script/style tags)
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : html;
  // Remove script and style tags to avoid false positives from JS code
  const visibleHtml = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  const lower = visibleHtml.toLowerCase();
  // Check for blocking patterns in visible content only
  const hasBlockingTitle = /<title[^>]*>[^<]*(access denied|forbidden|blocked|captcha)[^<]*<\/title>/i.test(html);
  const hasBlockingContent = (
    (lower.includes('please verify you are human') || lower.includes('confirm that you are human')) ||
    (lower.includes('access denied') && visibleHtml.length < 3000) ||
    (lower.includes('robot check') && visibleHtml.length < 3000) ||
    (lower.includes('unusual traffic') && visibleHtml.length < 3000) ||
    // Only flag captcha if it's the main page content, not just a script reference
    (lower.includes('solve the captcha') || lower.includes('complete the captcha') || lower.includes('slide right to complete'))
  );
  return hasBlockingTitle || hasBlockingContent;
}

function isPaywalled(html) {
  if (!html || typeof html !== 'string') return false;
  const lower = html.toLowerCase();
  // Note: Do NOT check for bare 'paywall' - ad scripts (Piano/tinypass) include the word
  // on free sites like Variety, THR, Deadline causing false positives
  return (
    lower.includes('subscribe to continue') ||
    lower.includes('subscription required') ||
    lower.includes('create a free account') ||
    lower.includes('sign in to read') ||
    lower.includes('already a subscriber') ||
    lower.includes('this article is for subscribers') ||
    lower.includes('to read the full story')
  );
}

// Logic extracted to scripts/lib/dom-article-extractor.js so it can be
// unit-tested in jsdom (parallel sessions kept silently reverting fixes when
// it lived inline). The function is serialized and injected into the
// Playwright browser context via page.evaluate.
const { extractArticleTextFromDocument } = require('./lib/dom-article-extractor');
const { decodeBloxRot47, decodeBloxRot47InDocument } = require('./lib/blox-rot47-decode');

async function extractArticleText(page) {
  // Serialize the lib function and run it in the browser. Wrapping in
  // `(${fn.toString()})(document, url)` evaluates the IIFE with the browser's
  // own document. Function must be self-contained — no closures. The current
  // page URL is passed through so BRO-912's talkinbroadway.com bail-out
  // (dom-article-extractor.js) can domain-scope itself.
  const currentUrl = page.url();
  // BRO-4221: BLOX ROT47-scrambled paragraphs are one text node in the DOM;
  // decode them in place first, or the extractor saves the gibberish.
  await page.evaluate(`(${decodeBloxRot47InDocument.toString()})(document)`).catch(() => 0);
  return await page.evaluate(
    `(${extractArticleTextFromDocument.toString()})(document, ${JSON.stringify(currentUrl)})`
  );
}

// BRO-3499: only TB and Variety delegated to article-extractor.js; the other
// DEDICATED_EXTRACTOR_HOSTS (WSJ, La Voce, The Stage, The Times, LSA, Theatre
// Weekly) ran on the generic extraction alone, leaving their tested dedicated
// patterns unused. Generic stays first (no behavior change when it already
// found a full body); the dedicated extractor is the fallback when the generic
// result is short, and wins only if it recovers more text.
const DEDICATED_FALLBACK_MIN_CHARS = 500;
function extractTextFromHtml(html, url) {
  // BLOX CMS hosts (Tulsa World, Buffalo News, ...) ship paywalled paragraphs
  // ROT47-scrambled; decode before either extractor runs (BRO-4221).
  html = decodeBloxRot47(html);
  const generic = extractTextFromHtmlGeneric(html, url);
  if (!url || generic.length >= DEDICATED_FALLBACK_MIN_CHARS || !isDedicatedExtractorHost(url)) return generic;
  let dedicated = null;
  try { dedicated = extractArticleTextFromHtml(html, url); } catch { dedicated = null; }
  return dedicated && dedicated.length > generic.length ? dedicated : generic;
}

function extractTextFromHtmlGeneric(html, url) {
  if (!html || typeof html !== 'string') return '';

  // Talkin' Broadway (BRO-912): checked FIRST (ahead of JSON-LD/generic
  // parsing) and authoritative — a "known outlet, don't let a bad fallback
  // masquerade as a real extraction" host, same as WSJ/Stage/Times in
  // scripts/lib/article-extractor.js's DEDICATED_EXTRACTOR_HOSTS. The naive
  // "grab every <p> inside <section class='page'>" scrape this used to fall
  // through to has no byline anchor, so on a "Past Reviews" page (multiple
  // runs stacked on one URL) it blends every stacked run into one fullText,
  // and it doesn't structurally exclude the newsletter-signup sidebar either
  // — the exact garbage/bleed failure modes BRO-912 reports. Delegate to the
  // shared, unit-tested byline-anchored extractor (task #1887) instead, which
  // anchors on the page's "Theatre Review by {Critic} - {Date}" marker. If it
  // returns null (no byline marker — not a real review page), return ''
  // rather than resurrecting the naive scrape: a null here means "this TB
  // page isn't a review", not "the good extractor merely failed".
  if (url && url.includes('talkinbroadway.com')) {
    return extractArticleTextFromHtml(html, url) || '';
  }

  // Nub News (BRO-5219): the generic path clears the 500-char dedicated
  // fallback threshold by keeping the donation appeal + share chrome, so the
  // dedicated extractor must run first. Falls through if its body block is
  // missing (unlike TB, a miss here doesn't mean "not a review").
  if (url && /(^|\.)nub\.news\//.test(url.replace(/^https?:\/\//, ''))) {
    const nub = extractArticleTextFromHtml(html, url);
    if (nub) return nub;
  }

  // New Yorker-specific extraction: isolate article body before generic parsing
  if (url && url.includes('newyorker.com')) {
    const nyText = extractNewYorkerFromHtml(html);
    if (nyText && nyText.length > 500) return nyText;
  }

  // Variety: the page paragraphs carry mid-article promo modules ("Related
  // Stories" headlines) and the JSON-LD body can be a teaser; the dedicated
  // extractor strips the promos (BRO-5222, Farnsworth refetch).
  if (url && url.includes('variety.com')) {
    const varietyText = extractVarietyBody(html);
    if (varietyText && varietyText.length > 500) return varietyText;
  }

  // Zox News theme (t2conline.com): body container only, never the
  // auto-loaded next stories (BRO-4977). Detected by markup, not host.
  const zoxText = extractZoxNewsBody(html);
  if (zoxText && zoxText.length > 500) return zoxText;

  // Try JSON-LD extraction — reliable when available, avoids CSS selector fragility
  const jsonLdText = extractFromJsonLd(html);
  if (jsonLdText && jsonLdText.length > 500) {
    if (jsonLdText.length >= JSONLD_TEASER_MAX) return jsonLdText;
    // A short JSON-LD body can be a teaser (Variety, BRO-5222): prefer the
    // page's paragraphs when they hold the same article, clearly longer.
    const choice = chooseArticleBody(jsonLdText, extractParagraphText(html));
    if (choice.source === 'paragraphs') {
      console.log(`    ↪ JSON-LD body is a ${jsonLdText.length}-char teaser; using ${choice.text.length} chars of page paragraphs`);
    }
    return choice.text;
  }
  return extractParagraphText(html);
}

/**
 * New Yorker-specific HTML extraction.
 * Isolates the article body container and strips recirc/newsletter/ad noise.
 * The ♦ character is New Yorker's traditional end-of-article marker.
 */
function extractNewYorkerFromHtml(html) {
  // Strip noise sections before extracting paragraphs
  let cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');

  // Try to isolate the article body container
  const bodyContainerMatch = cleaned.match(
    /class="[^"]*body__inner-container[^"]*"[^>]*>([\s\S]*?)(?:<div[^>]*class="[^"]*ContentFooter|<div[^>]*class="[^"]*recirc-list|$)/i
  );

  // Also try BodyWrapper pattern (Condé Nast CMS variant)
  const bodyWrapperMatch = !bodyContainerMatch && cleaned.match(
    /class="[^"]*BodyWrapper[^"]*"[^>]*>([\s\S]*?)(?:<div[^>]*class="[^"]*ContentFooter|<div[^>]*class="[^"]*recirc-list|$)/i
  );

  const articleHtml = (bodyContainerMatch || bodyWrapperMatch)?.[1] || cleaned;

  // Remove inline newsletter, audio embeds, and ad containers within article
  const strippedHtml = articleHtml
    .replace(/<div[^>]*class="[^"]*Newsletter[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*class="[^"]*AudioEmbed[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*class="[^"]*VideoFigure[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*class="[^"]*AdWrapper[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*class="[^"]*consumer-marketing[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');

  // Extract paragraphs
  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = pRegex.exec(strippedHtml)) !== null) {
    const pText = match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&rsquo;/g, "\u2019")
      .replace(/&lsquo;/g, "\u2018")
      .replace(/&rdquo;/g, "\u201D")
      .replace(/&ldquo;/g, "\u201C")
      .replace(/&mdash;/g, '\u2014')
      .replace(/&ndash;/g, '\u2013')
      .trim();

    if (pText.length > 30 &&
        !pText.toLowerCase().includes('cookie') &&
        !pText.toLowerCase().includes('subscribe') &&
        !pText.toLowerCase().includes('sign up for') &&
        !pText.toLowerCase().includes('newsletter')) {
      paragraphs.push(pText);
    }
  }

  let result = paragraphs.join('\n\n');

  // Truncate at ♦ (New Yorker end-of-article marker) if present
  const diamondIdx = result.indexOf('\u2666');
  if (diamondIdx > 500) {
    result = result.substring(0, diamondIdx).trim();
  }

  // Also truncate at "Published in the print edition" footer text
  const printIdx = result.indexOf('Published in the print edition');
  if (printIdx > 500) {
    result = result.substring(0, printIdx).trim();
  }

  return result;
}

function validateReviewText(text, review) {
  const issues = [];
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;

  if (wordCount < CONFIG.minWordCount) {
    issues.push(`Word count too low: ${wordCount} (min: ${CONFIG.minWordCount})`);
  }

  // Check if show title is mentioned
  const showWords = review.showId.replace(/-\d{4}$/, '').replace(/-/g, ' ').toLowerCase();
  const textLower = text.toLowerCase();
  const showMentioned = showWords.split(' ').some(word =>
    word.length > 3 && textLower.includes(word)
  );

  if (!showMentioned) {
    issues.push('Show title not found in text');
  }

  return {
    valid: issues.length === 0,
    wordCount,
    issues,
  };
}

function archiveHtml(html, review, method) {
  const date = new Date().toISOString().split('T')[0];
  const criticSlug = (review.critic || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '-');
  const outletSlug = (review.outletId || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '-');

  const archiveDir = path.join(CONFIG.archivesDir, review.showId);
  fs.mkdirSync(archiveDir, { recursive: true });

  const archivePath = path.join(archiveDir, `${outletSlug}--${criticSlug}_${date}.html`);

  const header = `<!--
  Archive Metadata
  URL: ${review.url}
  Outlet: ${review.outlet}
  Critic: ${review.critic}
  Show: ${review.showId}
  FetchMethod: ${method}
  Archived: ${new Date().toISOString()}
-->\n`;

  // Verify HTML canonical URL matches expected domain (catches cross-domain contamination)
  // Skip check for archive.org sources — they always set canonical to web.archive.org
  const canonicalMatch = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
  if (canonicalMatch) {
    try {
      const canonicalDomain = new URL(canonicalMatch[1]).hostname.replace(/^www\./, '');
      const expectedDomain = new URL(review.url).hostname.replace(/^www\./, '');
      const isArchiveSource = canonicalDomain === 'web.archive.org' || method === 'archive';
      if (!isArchiveSource && !domainMatchesExpected(expectedDomain, canonicalDomain)) {
        console.log(`  ⚠ ARCHIVE CONTAMINATION: canonical=${canonicalDomain} expected=${expectedDomain}`);
        console.log(`    Canonical URL: ${canonicalMatch[1]}`);
        // Still save archive (for debugging) but flag it
        const warningHeader = `<!-- WARNING: Cross-domain contamination detected! canonical=${canonicalDomain} expected=${expectedDomain} -->\n`;
        fs.writeFileSync(archivePath, warningHeader + header + html);
        return archivePath;
      }
    } catch (e) { /* ignore parse errors */ }
  }

  fs.writeFileSync(archivePath, header + html);
  return archivePath;
}

// TRAILING_JUNK_PATTERNS and stripTrailingJunk imported from ./lib/text-cleaning

// Patterns that indicate a legitimate review ending (not truncation)
const LEGITIMATE_ENDING_PATTERNS = [
  /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}$/,           // Phone number
  /\.(com|org|net|co\.uk)$/i,                  // URL ending
  /\d+\s+(W\.|West|E\.|East|Broadway|Street|St\.|Ave|Avenue)/i,  // Address
  /tickets?\s+(at|available|info)/i,           // Ticket info
  /Productions?$/i,                            // Production credits
  /Studios?$/i,
  /Entertainment$/i,
  /intermission$/i,                            // Runtime info
  /Open run$/i,
];

// Check if text has a legitimate ending (theater info, credits, etc.)
function hasLegitimateEnding(text) {
  const last100 = text.slice(-100).trim();
  return LEGITIMATE_ENDING_PATTERNS.some(p => p.test(last100));
}

// Detect truncation signals in text
// Returns object with detected signals and whether likely truncated
function detectTruncationSignals(text, excerptLength = 0) {
  if (!text || text.trim().length === 0) {
    return { signals: [], likelyTruncated: false, cleanedText: text };
  }

  // First strip trailing junk
  const cleanedText = stripTrailingJunk(text);

  const signals = [];
  const trimmedText = cleanedText.trim();
  const lastChar = trimmedText.slice(-1);
  const last50 = trimmedText.slice(-50);
  const last500 = trimmedText.slice(-500).toLowerCase();

  // Check for proper sentence ending
  const endsWithPunctuation = /[.!?"'"\)]$/.test(trimmedText);
  if (!endsWithPunctuation) {
    signals.push('no_ending_punctuation');
  }

  // Check for ellipsis ending
  if (/\.{3}$|…$/.test(trimmedText)) {
    signals.push('ends_with_ellipsis');
  }

  // Check for paywall/subscribe text near end
  if (/subscribe|sign.?in|log.?in|create.?account|members?.?only/i.test(last500)) {
    signals.push('has_paywall_text');
  }

  // Check for "read more" or "continue reading"
  if (/continue.?reading|read.?more|read.?the.?full|full.?article|full.?review/i.test(last500)) {
    signals.push('has_read_more_prompt');
  }

  // Check for common paywall endings
  if (/privacy.?policy|terms.?of.?use|all.?rights.?reserved|©/i.test(last500)) {
    signals.push('has_footer_text');
  }

  // Check if text is suspiciously short compared to excerpt
  if (excerptLength > 100 && text.length < excerptLength * 1.5) {
    signals.push('shorter_than_excerpt');
  }

  // Check for mid-word cutoff (ends with lowercase letter, no punctuation)
  if (/[a-z]$/.test(lastChar) && !endsWithPunctuation) {
    signals.push('possible_mid_word_cutoff');
  }

  // Determine if likely truncated based on signals
  const severeSignals = ['has_paywall_text', 'has_read_more_prompt', 'ends_with_ellipsis', 'shorter_than_excerpt'];
  const hasSevereSignal = signals.some(s => severeSignals.includes(s));

  // Check for legitimate endings (theater info, credits, URLs) that aren't truncation
  const legitimateEnding = hasLegitimateEnding(trimmedText);

  // Only weak signals (no_ending_punctuation, possible_mid_word_cutoff) + legitimate ending = NOT truncated
  const weakSignalsOnly = signals.every(s => ['no_ending_punctuation', 'possible_mid_word_cutoff'].includes(s));
  const likelyTruncated = hasSevereSignal || (signals.length >= 2 && !(weakSignalsOnly && legitimateEnding));

  return { signals, likelyTruncated, cleanedText, legitimateEnding };
}

// Classify text quality based on rules:
// - full: >1500 chars AND mentions show title AND >300 words AND no truncation signals
// - truncated: Has truncation signals (paywall, read more, etc.)
// - partial: 500-1500 chars OR larger but missing criteria
// - excerpt: <500 chars
// - missing: no text
function classifyTextQuality(text, showId, wordCount, excerptLength = 0) {
  if (!text || text.trim().length === 0) {
    return { quality: 'missing', truncationSignals: [], cleanedText: text };
  }

  // Detect truncation signals (also strips junk and checks for legitimate endings)
  const { signals, likelyTruncated, cleanedText, legitimateEnding } = detectTruncationSignals(text, excerptLength);

  // Use cleaned text for analysis
  const charCount = cleanedText.length;
  const cleanedWordCount = cleanedText.split(/\s+/).filter(w => w.length > 0).length;

  // Extract title from showId (e.g., "hamilton-2015" -> "hamilton")
  const titleLower = showId ? showId.replace(/-\d{4}$/, '').replace(/-/g, ' ').toLowerCase() : '';
  const textLower = cleanedText.toLowerCase();
  const hasShowTitle = titleLower && textLower.includes(titleLower);

  // If truncation detected, mark as truncated regardless of length
  if (likelyTruncated) {
    return { quality: 'truncated', truncationSignals: signals, cleanedText };
  }

  // Full: >1500 chars AND mentions show title AND >300 words AND no severe truncation
  // Allow weak signals (no_ending_punctuation, possible_mid_word_cutoff) if legitimate ending
  const weakSignalsOnly = signals.every(s => ['no_ending_punctuation', 'possible_mid_word_cutoff'].includes(s));
  if (charCount > 1500 && hasShowTitle && cleanedWordCount > 300 && (signals.length === 0 || (weakSignalsOnly && legitimateEnding))) {
    return { quality: 'full', truncationSignals: signals.length === 0 ? [] : signals, cleanedText };
  }

  // Partial: 500-1500 chars OR larger but missing criteria
  if (charCount >= 500 && charCount <= 1500) {
    return { quality: 'partial', truncationSignals: signals, cleanedText };
  }
  if (charCount > 1500 && (!hasShowTitle || cleanedWordCount <= 300)) {
    return { quality: 'partial', truncationSignals: signals, cleanedText };
  }

  // Excerpt: <500 chars
  if (charCount < 500) {
    return { quality: 'excerpt', truncationSignals: signals, cleanedText };
  }

  return { quality: 'partial', truncationSignals: signals, cleanedText };
}

// Page-date extraction (JSON-LD, meta, <time>, visible dateline) lives in
// scripts/lib/html-publish-date.js (BRO-5674): one copy for the collector and
// both backfill scripts.
const { extractPublishDateFromHtml } = require('./lib/html-publish-date');

// URL-path dates come from the canonical scripts/lib/rebuild-helpers.js
// extractDateFromUrl. They are never stored as publishDate here (BRO-5351,
// CLAUDE.md rule 3): they only veto a disagreeing byline date and feed the
// in-memory dates for the temporal override and the anticipatory gate.

// Byline-date extraction lives in scripts/lib/body-date-mismatch.js (BRO-2770)
// so the date guards, the shared writer and the corpus audit use one parser.
const { extractDateFromText, detectBodyDateMismatch } = require('./lib/body-date-mismatch');

// Map fetch method to standardized sourceMethod
function mapSourceMethod(method) {
  const map = {
    'playwright': 'playwright',
    'playwright-stealth': 'playwright',
    'browserbase': 'browserbase',
    'scrapingbee': 'scrapingbee',
    'brightdata': 'brightdata',
    'archive.org': 'archive',
    'archive': 'archive',
    'webfetch': 'webfetch',
    'amp': 'amp',
    'archive-today': 'archive-today',
  };
  return map[method] || method;
}

async function updateReviewJson(review, text, validation, archivePath, method, attempts, archiveData = {}, html = '', contentVerification = null, apiMeta = null) {
  // Metadata the publisher's API returned with the text (Guardian Content API).
  const apiScore = (apiMeta && apiMeta.score) || null;
  const data = readReviewForUpdate(review.filePath);
  // BRO-1431: snapshot the body BEFORE any mutation below, so the stale-flag
  // neutralization call (after contentTier reclassification) can tell "this
  // fetch just filled/replaced the body" apart from an unrelated metadata-only
  // update. See scripts/lib/stale-flag-neutralization.js.
  const fullTextBeforeUpdate = data.fullText || '';
  const contentTierBeforeUpdate = data.contentTier || null;

  // EMPTY-WRITE GUARD (Joe Turner postmortem A #1, A #16) — never overwrite
  // an existing non-empty fullText with empty/whitespace, and never modify a
  // file the operator has pinned (_locked) or that holds user-pasted complete
  // text (manualContentTier === 'complete'). Push-action protection (commit
  // 6c34f1ebf7) catches this at push time; this stops the bleed at the source.
  const protectionGate = shouldSkipPollerUpdate(data, text);
  if (protectionGate.skip) {
    console.log(`    [PROTECTED] ${protectionGate.reason} — skipping updateReviewJson`);
    return;
  }

  // Get excerpt length for truncation detection
  const excerptLength = Math.max(
    (data.dtliExcerpt || '').length,
    (data.bwwExcerpt || '').length,
    (data.showScoreExcerpt || '').length
  );

  // RESCORE TRIGGER: If adding fullText to a review that was scored on excerpt
  const hadFullTextBefore = data.fullText && data.fullText.length > 500;
  // Read before fullText is replaced: the stale-body signal reads the OLD body.
  const urlCorrectedBefore = isUrlCorrectedRefetch(data);
  const hasLlmScore = data.llmScore && data.llmScore.score;
  const newTextIsSubstantial = text.length > 1000;

  // A legacy web-search row's score came from an excerpt that step made up
  // (BRO-5183), so any real page text (300+ chars, the bar the BRO-5107 guard
  // uses) must be rescored, not only text over 1000 chars.
  const legacyRowGotPage = isLegacyWebSearchOnly(data) && text.length >= 300;
  if (!hadFullTextBefore && hasLlmScore && (newTextIsSubstantial || legacyRowGotPage)) {
    // Review was scored on excerpt, now has fullText - flag for rescoring
    markRescoreNeeded(data, 'fullText added after excerpt-based scoring', undefined, { requeue: true });
    console.log(`    → Flagged for rescore: was scored at ${data.llmScore.score} on excerpt, now has ${text.length} char fullText`);
  }

  // Clean text (decode entities, strip control chars, collapse whitespace, strip junk) before classification
  // Remove the banner lines isGarbageContent() exempts as trailing/leading junk (BRO-2860)
  // Shared with verifyFetchedContent so the verifier judges the stored body (BRO-5243).
  let preCleanedText = preCleanForStorage(text);

  // Multi-show blog posts (interestedbystander): keep only THIS show's
  // section, or store nothing (BRO-4387 follow-up: until 2026-09-29 only
  // ingest-review-from-url.js isolated the section, so every collector
  // re-fetch pulled the whole post and scored other shows into the file).
  {
    const sid = review.showId || data.showId;
    let meta = null;
    try {
      if (!_showsJsonCache) _showsJsonCache = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
      meta = _showsJsonCache.shows.find(s => s.id === sid) || null;
    } catch (e) { /* shows.json unavailable */ }
    const iso = isolateMultiShowSection(data.url || review.url, preCleanedText, meta ? meta.title : '');
    if (iso.action === 'refuse') {
      console.log(`    [MULTI-SHOW] could not isolate this show's section in ${data.url || review.url} — not storing another show's text`);
      if (!data.fullText) {
        if (data.rescoreReason === 'fullText added after excerpt-based scoring' && !hadFullTextBefore) {
          delete data.needsRescore; delete data.rescoreReason; delete data.rescoreFlaggedAt; // set above for text we are not storing
        }
        data.incompleteReason = MULTI_SHOW_NOT_FOUND_REASON;
        data.incompleteDetail = 'multi-show post has no unique section for this show (isolateMultiShowSection)';
        persistReviewSnapshot({ filePath: review.filePath, data: data, trailingNewline: true });
      }
      return;
    }
    if (iso.action === 'isolated') {
      console.log(`    [MULTI-SHOW] kept this show's section (${iso.text.length} of ${preCleanedText.length} chars)`);
      preCleanedText = iso.text;
    }
  }

  // Text quality classification with truncation detection (also strips trailing junk)
  const qualityResult = classifyTextQuality(preCleanedText, review.showId || data.showId, validation.wordCount, excerptLength);

  // Use cleaned text (junk stripped) if available, otherwise pre-cleaned
  const cleanedText = qualityResult.cleanedText || preCleanedText;
  // Clear stale contentVerification when fullText changes (prevents wrongArticle from blocking valid new text)
  if (data.contentVerification && data.contentVerification.wrongArticle && data.fullText !== cleanedText) {
    console.log(`    → Clearing stale contentVerification.wrongArticle (fullText updated)`);
    // Only clear wrongArticle-related fields; preserve wrongProduction, isFilmTv, etc.
    delete data.contentVerification.wrongArticle;
    delete data.contentVerification.verifiedAt;
    delete data.contentVerification.verifiedBy;
    delete data.contentVerification.reasoning;
    delete data.contentVerification.confidence;
    delete data.contentVerification.isValid;
  }

  // When LLM verification was skipped this run (e.g. word count < 200), fall back to existing
  // contentVerification from the JSON file. This prevents heuristics from wiping fullText on
  // paywalled/truncated pages where a prior run already verified the content is legitimate.
  // Guard: only use existing if it's valid and not wrongArticle (wrongArticle means a different page entirely).
  const effectiveVerification = contentVerification || (
    data.contentVerification && !data.contentVerification.wrongArticle && data.contentVerification.isValid !== false
      ? data.contentVerification
      : null
  );

  // A forced refetch replaces text that came from the wrong page, so the score
  // read from that text is wrong too (the excerpt trigger above only fires
  // when there was no text before). BRO-5090.
  const forcedReplacement = shouldRescoreForcedReplacement(review, fullTextBeforeUpdate, cleanedText);
  if (forcedReplacement) {
    markRescoreNeeded(data, 'fullText replaced by forced refetch (stored text was from the wrong page)', undefined, { requeue: true });
    console.log(`    → Flagged for rescore: forced refetch replaced ${fullTextBeforeUpdate.length} chars with ${cleanedText.length}`);
  }
  // BRO-5348: overrides read from the replaced text must not outlive it.
  const staleOverrides = staleScoreOverridesAfterRefetch({
    forcedReplacement,
    humanReviewScore: data.humanReviewScore,
    humanReviewScoreProvisional: data.humanReviewScoreProvisional,
    originalScore: data.originalScore,
    humanVerifiedRating: require('./lib/verified-original-score').isHumanVerifiedRating(data),
  });
  if (staleOverrides.humanPin) {
    data.humanReviewScoreProvisional = true;
    data.humanReviewNote = `${data.humanReviewNote ? `${data.humanReviewNote} ` : ''}[provisional since a forced refetch replaced the text; the rescore of the new text wins (BRO-5348)]`;
    console.log(`    → humanReviewScore ${data.humanReviewScore} made provisional: set before the text was replaced (BRO-5348)`);
  }
  // Set aside, not cleared: the extractor below only runs without an originalScore.
  let staleOriginalScore = null;
  if (staleOverrides.originalScore) {
    staleOriginalScore = data.originalScore;
    data.originalScore = null;
    data.originalScoreNormalized = null;
    console.log(`    → originalScore "${staleOriginalScore}" set aside for re-extraction from the new page (BRO-5348)`);
  }
  if (forcedReplacement && data.crossOutletDuplicate === true && data.crossOutletPrimaryFile) {
    let primaryFingerprint = null;
    try {
      const primary = JSON.parse(fs.readFileSync(path.join(CONFIG.reviewTextsDir, data.crossOutletPrimaryFile), 'utf8'));
      primaryFingerprint = primary.fullText ? computeContentFingerprint(primary.fullText) : null;
    } catch { /* unreadable primary: keep the flag */ }
    if (staleCrossOutletFlagAfterRefetch({ forcedReplacement, crossOutletDuplicate: true, crossOutletMethod: data.crossOutletMethod, newFingerprint: computeContentFingerprint(cleanedText), primaryFingerprint })) {
      const { clearCrossOutletFields } = require('./lib/cascade-clear-duplicate-refs');
      console.log(`    → Cleared crossOutletDuplicate: forced refetch text no longer matches ${data.crossOutletPrimaryFile} (BRO-5348)`);
      clearCrossOutletFields(data, `forced refetch from own url replaced the text; no longer matches ${data.crossOutletPrimaryFile} (BRO-5348)`);
    }
  }
  if (!data.needsRescore && shouldRescoreCompletedTruncated({
    tierBefore: contentTierBeforeUpdate,
    hasScore: !!(data.llmScore && data.llmScore.score),
    textBefore: fullTextBeforeUpdate,
    textAfter: cleanedText,
  })) {
    markRescoreNeeded(data, 'fullText completed after truncated-text scoring', undefined, { requeue: true });
    console.log(`    → Flagged for rescore: truncated text (${fullTextBeforeUpdate.length} chars) replaced by ${cleanedText.length}`);
  }
  data.fullText = cleanedText;
  data.isFullReview = cleanedText.length > 1500;
  data.textWordCount = cleanedText.split(/\s+/).filter(w => w.length > 0).length;
  data.archivePath = archivePath;
  data.textFetchedAt = new Date().toISOString();
  // Consume the URL-correction refetch signal once we have fresh text from the
  // corrected URL — otherwise the needsRefetch bypass (skip logic above) would
  // refetch this file on every run forever.
  // BRO-5231: the score on a URL-corrected file belongs to the OLD article, so
  // the fresh body must be rescored (this fires only when text was replaced).
  if (urlCorrectedBefore && hadFullTextBefore && (data.llmScore || data.assignedScore != null)) {
    markRescoreNeeded(data, data.rescoreReason || 'fullText replaced after URL correction', undefined, { requeue: true });
  }
  if (data.needsRefetch) data.needsRefetch = false;

  // Show Score's "For a previous production" is not a date, but it is truthy,
  // so it used to block all three fallbacks below (BRO-4884). Look for a real
  // date; keep the sentinel only if none turns up, so the wrong-production
  // flagger still sees it.
  const sentinelPublishDate = evaluateShowScorePreviousProduction({ review: data, show: null }).flag ? data.publishDate : null;
  if (sentinelPublishDate) data.publishDate = null;
  // BRO-5081: an LLM-scoring guess or a roundup article's own date
  // (dateSource 'llm-scoring' / 'roundup-article') is a placeholder too. Let
  // the page or byline replace it; keep it only if neither finds a date.
  // BRO-5674: so is a date carried in from an aggregator, roundup, RSS feed or
  // SERP (most were written with no dateSource). The page's own dateline
  // replaces it; a page date ('html-page') is never replaced.
  const provisionalPublishDate = !sentinelPublishDate && isProvisionalPublishDate(data) ? data.publishDate : null;
  const carriedPublishDate = !sentinelPublishDate && !provisionalPublishDate && isReplaceableByPageDate(data) ? data.publishDate : null;
  const provisionalDateSource = provisionalPublishDate ? data.dateSource : null;
  const carriedDateSource = carriedPublishDate ? (data.dateSource || null) : null;
  if (provisionalPublishDate || carriedPublishDate) data.publishDate = null;

  // Extract publishDate from HTML if not already set. An archived copy is
  // stored as 'html-archive' (a live page may still replace it).
  let pageDateDiverged = false;
  // The API's webPublicationDate is the article's own date (no page HTML to read it from).
  if (!data.publishDate && apiMeta && apiMeta.publishDate) {
    const decision = resolvePageDateReplacement({ storedDate: carriedPublishDate, pageDate: apiMeta.publishDate });
    if (decision.replace) {
      data.publishDate = apiMeta.publishDate;
      data.dateSource = 'page-guardian-api';
      delete data.pageDateCandidate;
      delete data.pageDateCandidateSource;
      console.log(`    → publishDate from Guardian API: ${apiMeta.publishDate}`);
    } else {
      pageDateDiverged = true;
      data.pageDateCandidate = apiMeta.publishDate;
      data.pageDateCandidateSource = 'page-guardian-api';
    }
  }
  if (!data.publishDate && html) {
    const extractedDate = extractPublishDateFromHtml(html, data.url);
    if (extractedDate) {
      // BRO-5674: a page date more than 7 days from the carried date is not
      // trusted on its own: keep the carried date, record the candidate.
      const decision = resolvePageDateReplacement({ storedDate: carriedPublishDate, pageDate: extractedDate });
      if (decision.replace) {
        data.publishDate = extractedDate;
        data.dateSource = htmlDateSourceFor(method);
        delete data.pageDateCandidate;
        delete data.pageDateCandidateSource;
        console.log(`    → Extracted publishDate from HTML: ${extractedDate} (${data.dateSource})`);
      } else {
        pageDateDiverged = true;
        data.pageDateCandidate = extractedDate;
        data.pageDateCandidateSource = htmlDateSourceFor(method);
        console.log(`    → Page date ${extractedDate} is ${decision.divergentDays} days from carried ${carriedPublishDate}: kept, needsDateRecheck`);
      }
    }
  }
  // A carried date the page could not confirm stays as it was. Not replaced by
  // the body-text regex below (that can be a run or closing date, BRO-5090).
  if (carriedPublishDate && !data.publishDate) {
    data.publishDate = carriedPublishDate;
    if (carriedDateSource) data.dateSource = carriedDateSource; else delete data.dateSource;
  } else if (carriedPublishDate && data.publishDate !== carriedPublishDate) {
    console.log(`    → Replaced carried publishDate ${carriedPublishDate} (${carriedDateSource || 'no dateSource'}) with page date ${data.publishDate}`);
  }

  // Fallback: the byline date in the first 500 chars of fullText. Only when
  // exactly one date found. Rejects run/closing dates via context words.
  // Not over a provisional date: a roundup date is within days of the real
  // one, a regex hit in body text can be a run or closing date (BRO-5090).
  // BRO-5351: a URL-path date is never stored here (CLAUDE.md rule 3). It may
  // only veto a byline date that disagrees with it; the file then stays
  // dateless and the rebuild's backfill settles the derived date.
  let bylineVetoed = false;
  if (!data.publishDate && !provisionalPublishDate && data.fullText && data.fullText.length > 100) {
    const fallback = bodyPublishDateFallback({
      textDate: extractDateFromText(data.fullText),
      urlDate: data.url ? extractDateFromUrlCanonical(data.url) : null,
    });
    if (fallback.publishDate) {
      data.publishDate = fallback.publishDate;
      data.dateSource = fallback.dateSource;
      console.log(`    → Extracted publishDate from text: ${fallback.publishDate}`);
    } else if (fallback.reason === 'body-url-conflict') {
      bylineVetoed = true;
      console.log('    → Byline date disagrees with the URL path date: publishDate left empty for the rebuild backfill (BRO-5351)');
    }
  }
  if (sentinelPublishDate && !data.publishDate) data.publishDate = sentinelPublishDate;
  if (provisionalPublishDate && !data.publishDate) {
    data.publishDate = provisionalPublishDate;
    data.dateSource = provisionalDateSource;
  } else if (provisionalPublishDate && data.publishDate !== provisionalPublishDate) {
    console.log(`    → Replaced provisional publishDate ${provisionalPublishDate} (${provisionalDateSource}) with ${data.publishDate}`);
  }
  // BRO-5674: a date more than 2 days before opening night that the page did
  // not confirm is marked for re-extraction (backfill-review-dates.js
  // --recheck-dates), not trusted. Cleared once a page date is stored.
  {
    let showMeta = null;
    try {
      if (!_showsJsonCache) _showsJsonCache = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
      const sid = review.showId || data.showId;
      showMeta = _showsJsonCache.shows.find(s => s.id === sid) || null;
    } catch (e) { /* shows.json unavailable */ }
    if (pageDateDiverged) {
      data.needsDateRecheck = true;
    } else if (showMeta && needsOpeningWindowDateRecheck(data, showMeta)) {
      if (!data.needsDateRecheck) console.log(`    → publishDate ${data.publishDate} is >2 days before opening ${showMeta.openingDate} and not from the page: needsDateRecheck`);
      data.needsDateRecheck = true;
    } else if (showMeta && data.needsDateRecheck && !data.pageDateCandidate) {
      delete data.needsDateRecheck;
    }
  }

  // Schmigadoon 2026 postmortem Bug #5: anticipatory pre-opening-night posts.
  // For preview-heavy outlets (frontmezzjunkies, broadwaydirect, ...) require
  // publishDate >= openingDate. For all other outlets allow a 2-day grace (matches
  // the post-broadcast audit check at publish-date-pre-opening.check.js).
  // Rejected reviews have their fetched text stripped and are flagged so the
  // rebuild excludes them. Clearable via humanReviewedEarlyPublish=true.
  // Production-continuity exemption (Phase 1): skip the gate when publishDate
  // falls inside a declared priorRuns window — the show's earlier run is the
  // legitimate target. Without this, the ingest gate sets wrongProduction with
  // a wrongProductionReason that the rebuild's auto-clear refuses to undo,
  // creating a permanent re-flag loop. See scripts/lib/wrong-production-autoclear.js.
  {
    let showOpeningDate = null;
    let showPriorRuns = null;
    let showTourLegs = null;
    let showCategory = null;
    try {
      if (!_showsJsonCache) _showsJsonCache = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
      const showMeta = _showsJsonCache.shows.find(s => s.id === (data.showId || review.showId));
      showOpeningDate = showMeta?.openingDate || null;
      showPriorRuns = showMeta?.priorRuns || null;
      showTourLegs = showMeta?.tourLegs || null;
      showCategory = showMeta?.category || null;
    } catch (e) { /* shows.json unavailable — skip gate (fail-open) */ }

    // BRO-5351: a URL date is never stored, but the gate still judges on it in
    // memory when the page gave no date of its own (as the temporal override does).
    const gateDate = ingestGateDate(data, { bylineVetoed });
    const inPriorRun = isWithinPriorRun(gateDate, showPriorRuns) || isWithinTourLeg(gateDate, showTourLegs);
    const anticip = inPriorRun
      ? { rejected: false }
      : isAnticipatoryPreviewPost(
          gateDate,
          showOpeningDate,
          data.outletId || review.outletId,
          {
            humanReviewedEarlyPublish: data.humanReviewedEarlyPublish === true,
            category: showCategory,
          }
        );
    // BRO-2770: the body's own byline disagrees with publishDate and is NOT
    // anticipatory. publishDate is stale metadata from another article; the
    // rebuild's corroboration hold routes the file to repair. Flagging here
    // would null the real review's text off a date that isn't its own.
    const bodyMismatch = anticip.rejected ? detectBodyDateMismatch(data) : null;
    const bodyDateClears = bodyMismatch && !isAnticipatoryPreviewPost(
      bodyMismatch.bodyDate, showOpeningDate, data.outletId || review.outletId,
      { humanReviewedEarlyPublish: data.humanReviewedEarlyPublish === true, category: showCategory }
    ).rejected;
    if (bodyDateClears) {
      console.log(`  ⚠ STALE publishDate ${bodyMismatch.publishDate}: body byline says ${bodyMismatch.bodyDate} — not flagging anticipatory; held for date/url repair`);
    }
    // allowEarlyDate: operator approved the early date (BRO-720) — flagging again would re-loop with the rebuild auto-clear
    if (anticip.rejected && !shouldSkipWrongProductionAudit(data) && !data.allowEarlyDate && !bodyDateClears && !laneHeld(data, 'wrongProduction')) {
      console.log(`  ✗ ANTICIPATORY PRE-OPENING POST: ${anticip.reason}`);
      // Kept in wrongFullText like every other wrong-content verdict, so the
      // record does not read as never scraped (BRO-2788 cousin, BRO-5261 S11).
      if (!quarantineBody(data)) data.fullText = null;
      data.wrongProduction = true;
      invalidateWrongProductionAutoClear(data);
      data.wrongProductionReason = 'anticipatory_pre_opening_post';
      data.wrongProductionDetail = anticip.reason;
      data.wrongProductionDetectedAt = new Date().toISOString();
      data.wrongProductionDetectedBy = 'ingest-anticipatory-gate';
      data.anticipatoryGateOutletCategory = anticip.outletCategory;
      data.anticipatoryGateDaysBeforeOpening = anticip.daysBeforeOpening;
      // Preserve archivePath so curators can still audit the HTML.
      // Skip score routing and content verification — the rest of this
      // function still runs but the flagged fullText=null causes downstream
      // rebuild to exclude this review.
    }
  }

  // Clear a previous automated TEXT-QUALITY rejection (not_a_review /
  // garbage_text / truncated_text from the ensemble or a heuristic) so the
  // re-scraped body gets judged again: null-assigned (a delete is restored by
  // push-review-texts), the old-text score parked, needsRescore raised.
  // wrong_production / wrong_show verdicts, human rejections and rejections
  // with no rejectedBy (free-text, hand-written) are about the article, not
  // the fetch, and stay. scripts/clear-stale-automated-text-verdicts.js is the
  // daily backstop for writers that bypass this path.
  clearAutomatedTextRejectionOnRefetch(data);

  // Extract original score from HTML/text if not already present,
  // or if the existing score came from Show Score (SS assigns its own stars,
  // which are wrong ~11% of the time and invented for outlets without native ratings).
  // Re-extract to replace SS-assigned scores with verified outlet scores.
  // Phase 2a: Run both old regex AND new LLM extraction, log disagreements, use LLM result
  const isSSSource = data.source === 'show-score' || data.source === 'show-score-playwright' || data.source === 'showscore-roundup';
  // A rating a human verified against the outlet page (BRO-4849) is never superseded by extraction.
  const humanVerified = require('./lib/verified-original-score').isHumanVerifiedRating(data);
  const hasUnverifiedSSScore = isSSSource && data.originalScore && !humanVerified && !OUTLET_VERIFIED_SOURCES.has(data.scoreSource);
  // Skip re-extraction if score was deliberately cleared by P0 audit
  const wasCleared = data.originalScoreCleared === true;
  // BRO-2809: no-critic-rating outlets (london-theatre) never yield a verified score,
  // so an SS placeholder here would survive re-extraction as a P0 leak. Discard it.
  if (!wasCleared && discardNoRatingOutletScore(data)) {
    console.log(`    → Discarded originalScore on no-critic-rating outlet [${data.outletId}]`);
  }
  // An API rating also supersedes an unverified extracted score (the second-pass
  // supersede below needs page html, which the API path does not have).
  // Not over an aggregator-routed score: setExtractedScore would route the API
  // rating into aggregatorStars and lose the aggregator's own value.
  const apiScoreSupersedes = !!apiScore && !humanVerified && !OUTLET_VERIFIED_SOURCES.has(data.scoreSource)
    && !require('./lib/review-normalization').AGGREGATOR_SCORE_SOURCES.has(data.scoreSource);
  if (apiScoreSupersedes && data.originalScore && data.originalScore !== apiScore.originalScore) {
    console.log(`    → Guardian API rating ${apiScore.originalScore} replaces unverified ${data.originalScore} [${data.scoreSource || 'no source'}]`);
    data.previousExtractedScore = { value: data.originalScore, source: data.scoreSource || null };
  }
  if (!data.originalScoreCleared && (!data.originalScore || hasUnverifiedSSScore || apiScoreSupersedes) && (html || text)) {
    const outletId = data.outletId || review.outletId || '';

    // A rating the publisher's own API returned (Guardian starRating) beats
    // reading it back out of the text, so skip regex + LLM when one came in.
    // Old regex extraction (for comparison logging)
    // BRO-5223: the show title lets the fallthrough refuse another show's stars.
    const regexResult = apiScore ? null : extractScore(html, text, outletId, require('./lib/known-show-titles').showTitleForId(data.showId || review.showId));

    // New LLM extraction (primary — async)
    let llmResult = null;
    if (!apiScore) {
      try {
        llmResult = await extractExplicitScore({ text, html, outletId, showId: data.showId || review.showId });
      } catch (e) {
        console.log(`    ⚠ LLM score extraction failed: ${e.message}`);
      }
    }

    // Log disagreements between old and new
    if (regexResult && !llmResult) {
      console.log(`    ⚠ SCORE DIFF: regex found "${regexResult.originalScore}" but LLM returned null [${outletId}]`);
    } else if (!regexResult && llmResult) {
      console.log(`    ✦ SCORE DIFF: LLM found "${llmResult.originalScore}" (${llmResult.normalizedScore}) but regex returned null [${outletId}]`);
    } else if (regexResult && llmResult && regexResult.originalScore !== llmResult.originalScore) {
      console.log(`    ⚠ SCORE DIFF: regex="${regexResult.originalScore}" vs LLM="${llmResult.originalScore}" (${llmResult.normalizedScore}) [${outletId}]`);
    }

    // Use LLM result if available, otherwise fall back to regex
    const scoreResult = apiScore || llmResult || regexResult;
    if (scoreResult) {
      if (hasUnverifiedSSScore) {
        console.log(`    → Replacing SS score (${data.originalScore}) with verified: ${scoreResult.originalScore} (${scoreResult.normalizedScore}/100) [${scoreResult.source}]`);
        data.previousShowScoreRating = data.originalScore;
      } else {
        console.log(`    → Extracted score: ${scoreResult.originalScore} (${scoreResult.normalizedScore}/100) [${scoreResult.source}]`);
      }
      // Routes to originalScore unless EITHER the incoming source OR the
      // file's existing scoreSource is an aggregator. See lib/score-routing.js.
      const routed = setExtractedScore(data, {
        value: scoreResult.originalScore,
        normalizedValue: scoreResult.normalizedScore,
        source: scoreResult.source,
      });
      // Backward-compat: this script historically also wrote scoreSource so
      // downstream consumers see the new source on non-aggregator writes.
      if (!routed.wasAggregator) {
        data.scoreSource = scoreResult.source;
      }
      if (scoreResult.confidence) {
        data.scoreConfidence = scoreResult.confidence;
      }
    } else if (!hasUnverifiedSSScore) {
      // Both failed and no existing score — mark as pending for retry
      // Don't mark pending if we were trying to replace an SS score (keep SS as fallback)
      // Don't mark pending for noScoreExtractor outlets (text-only, no star ratings to find)
      const outletExtractor = OUTLET_EXTRACTORS[(data.outletId || review.outletId || '').toLowerCase()];
      // BRO-3139: london-theatre now has a dedicated extractor, but a page without a rating (about
      // 7% of reviews, plus non-review pages) is still text-only: nothing for a retry to find.
      if ((!outletExtractor || outletExtractor.name !== 'noScoreExtractor')
          && !publishesNoCriticRating(data.outletId || review.outletId || '')) {
        data.scoreExtractionPending = true;
      }
    }
  }

  // RH 2026 bug #22 fix: Second-pass extraction against saved fullText.
  //
  // The first pass above skips re-extraction when data.originalScore is already
  // set (even when the source is an aggregator thumb/excerpt). On opening night,
  // reviews land in review-texts/ with originalScore pre-populated from BWW
  // Roundup / DTLI / Show Score aggregator signals, then collect-review-texts
  // fetches the authoritative outlet page — but the extractor never re-runs
  // against that page, so the aggregator score sticks even when the outlet
  // published an explicit star rating we could read verbatim.
  //
  // This pass re-runs extractScore(html, fullText) and supersedes the current
  // score ONLY when the outlet has a dedicated extractor AND the existing
  // scoreSource is missing, aggregator-sourced, or not on the verified list.
  // Writes originalScore + starRating on success.
  {
    const outletId = (data.outletId || review.outletId || '').toLowerCase();
    const outletExtractor = OUTLET_EXTRACTORS[outletId];
    const hasReliableExtractor = outletExtractor && outletExtractor.name !== 'noScoreExtractor';
    const hasFullText = data.fullText && data.fullText.length > 500;
    const scoreSource = data.scoreSource;
    // LLM extraction already ran in the first pass (line ~4309) with access to
    // the same html+text we have here, and it beats regex on ambiguous cases
    // (e.g. "3.5 out of 4 stars" parses cleanly in LLM but hits the regex at
    // face value). Never supersede an LLM-extracted score with a regex pass.
    const isLlmSource = typeof scoreSource === 'string' && scoreSource.startsWith('llm-');
    const isUnverifiedOrAggregator =
      !isLlmSource && !humanVerified && (
        !data.originalScore ||
        !scoreSource ||
        AGGREGATOR_SCORE_SOURCES.has(scoreSource) ||
        !OUTLET_VERIFIED_SOURCES.has(scoreSource)
      );

    if (hasReliableExtractor && hasFullText && html && isUnverifiedOrAggregator && !wasCleared) {
      const rescoreResult = extractScore(html, data.fullText, outletId, require('./lib/known-show-titles').showTitleForId(data.showId));
      if (rescoreResult && rescoreResult.normalizedScore != null) {
        const prevScore = data.originalScore || '(none)';
        const prevSource = data.scoreSource || '(none)';
        console.log(`    → [RESCORE-FULLTEXT] ${outletId}: ${rescoreResult.originalScore} (${rescoreResult.normalizedScore}/100) via ${rescoreResult.source} — supersedes ${prevScore} [${prevSource}]`);
        const routed = setExtractedScore(data, {
          value: rescoreResult.originalScore,
          normalizedValue: rescoreResult.normalizedScore,
          source: rescoreResult.source,
        });
        if (!routed.wasAggregator) {
          data.scoreSource = rescoreResult.source;
        }
        // Persist starRating when the extracted score is a fractional star format
        // (e.g. "3/5 stars", "4/5"). Downstream display uses this as a badge.
        if (typeof rescoreResult.originalScore === 'string') {
          const starMatch = rescoreResult.originalScore.match(/^(\d)\/(\d)(?:\s*stars?)?$/i);
          if (starMatch) {
            data.starRating = `${starMatch[1]}/${starMatch[2]}`;
          }
        }
        // Clear pending flag — we just succeeded.
        delete data.scoreExtractionPending;
      }
    }
  }

  // Score-extractor pre-pass — Gap 2 (Lost Boys 2026-04-26 #8 defense).
  //
  // Mirrors the /ingest UI flow's gate (src/app/api/admin/ingest-review/route.ts:228-335).
  // The two preceding passes already tried extractScore against html+text and
  // (when html is present) re-extracted against fullText for outlets with a
  // dedicated extractor. This third pass is the last line of defense for
  // orchestrator-discovered files that landed with fullText but no html and
  // weren't covered by either earlier pass — typically BWW Review Roundup,
  // Playbill Verdict, and DTLI scrapes that wrote excerpts directly. Without
  // it, those files reach the LLM ensemble unscored, and if the ensemble
  // skips the file (budget cap, contentTier gate, dispatch failure), the
  // review never renders on the live page.
  //
  // Lost Boys 2026-04-26 burned amNY Matt Windman + Exeunt Loren Noveck this
  // way. Joe Turner 2026-04-25/26 had ~4-6 similar cases.
  //
  // Helper enforces the same gate /ingest does:
  //   - no humanReviewScore + no originalScore (never clobber prior reads)
  //   - score in 1-100
  //   - source in OUTLET_VERIFIED_SOURCES OR 'unicode-stars-fallthrough'
  // (Generic text-pattern fallthrough excluded — no positional anchor when
  // html='', FP risk on quoted critic mentions and page chrome.)
  {
    const outletIdForPrepass = (data.outletId || review.outletId || '').toLowerCase();
    const prepass = runScoreExtractorPrePass(data, {
      fullText: data.fullText,
      outletId: outletIdForPrepass,
    });
    if (prepass) {
      // Route via setExtractedScore so files whose existing scoreSource is
      // an aggregator (e.g. bww-roundup, dtli) land in aggregatorStars
      // instead of originalScore — preserves the validate-data.js
      // aggregator-vs-outlet invariant.
      const routed = setExtractedScore(data, {
        value: prepass.originalScore,
        normalizedValue: prepass.originalScoreNormalized,
        source: prepass.originalScoreSource,
      });
      // No humanReviewScore here (BRO-2882): that slot means a person
      // decided the score. originalScore already renders the review.
      delete data.scoreExtractionPending;
      console.log(
        `    → [TEXT-ONLY PRE-PASS] ${outletIdForPrepass}: ${prepass.originalScore} (${prepass.originalScoreNormalized}/100) via ${prepass.sourceLabel}` +
        (routed.wasAggregator ? ' [routed to aggregatorStars]' : '')
      );
    }
  }

  // BRO-5348: the new page had no rating, so the set-aside one came from the
  // replaced text. Clear it with its breadcrumb (a bare null is restored on write).
  if (staleOriginalScore != null && (data.originalScore == null || data.originalScore === '')) {
    require('./lib/verified-original-score').applyVerifiedOriginalScore(data, null,
      `"${staleOriginalScore}" was read from text a forced refetch replaced; the new page has no rating (BRO-5348)`);
    console.log(`    → originalScore "${staleOriginalScore}" cleared: the refetched page has no rating (BRO-5348)`);
  }

  // Extract designation (Critics_Pick, Must_See, etc.) if not already present
  if (!data.designation && (html || text)) {
    const outletId = data.outletId || review.outletId || '';
    const designation = extractDesignation(html, text, outletId);
    if (designation) {
      data.designation = designation;
      console.log(`    → Extracted designation: ${designation}`);
    }
  }

  // New tracking fields
  data.fetchMethod = method;
  data.fetchAttempts = attempts;
  data.fetchTier = method === 'guardian-api' ? 0 : method === 'playwright' ? 1 : method === 'browserbase' ? 1.5 : method === 'scrapingbee' ? 2 : method === 'brightdata' ? 3 : 4;

  // Set quality fields from earlier classification
  data.textQuality = qualityResult.quality;
  data.truncationSignals = qualityResult.truncationSignals;

  // Update textStatus based on quality
  if (qualityResult.quality === 'full') {
    data.textStatus = 'complete';
  } else if (qualityResult.quality === 'truncated') {
    data.textStatus = 'truncated';
  } else {
    data.textStatus = validation.valid ? 'partial' : 'incomplete';
  }

  data.sourceMethod = mapSourceMethod(method);

  if (archiveData.archiveTimestamp) {
    data.archiveOrgTimestamp = archiveData.archiveTimestamp;
    data.archiveOrgUrl = archiveData.archiveUrl;
  }

  if (validation.issues.length > 0) {
    data.textIssues = validation.issues;
  } else {
    delete data.textIssues;
    delete data.textIssue;
  }

  // ========================================
  // POST-SCRAPE VALIDATION FLAGS (Phase 1)
  // ========================================

  // 1A. Show title mention check
  // If LLM verified the content → trust LLM BUT still run keyword gate (LLM hallucinates
  // isValid:true ~48% of the time on garbage pages — browser-update prompts, paywall walls,
  // sidebar lists, wrong-show content). See feedback_llm_verifier_hallucinates.md and
  // checkLlmVerificationAgainstKeywords() in scripts/lib/review-guards.js.
  // If no LLM verification → fall back to heuristic title check
  // Uses effectiveVerification which falls back to existing JSON contentVerification when LLM was
  // skipped this run (word count < 200), preventing the heuristic from wiping valid paywalled text.
  if (effectiveVerification && effectiveVerification.verifiedBy?.startsWith('llm:')) {
    // Keyword final-mile gate against hallucinated LLM verdicts.
    // Check data.fullText (the freshly-scraped content). If LLM said valid but no show
    // keyword appears in the text, quarantine: move fullText → wrongFullText, set
    // showNotMentioned:true. Mirrors rebuild-all-reviews.js auto-clear protection.
    let llmKwCheck = null;
    try {
      const showIdForKw = data.showId || review.showId || '';
      if (!_showsJsonCache) _showsJsonCache = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
      const showForKw = _showsJsonCache.shows.find(s => s.id === showIdForKw) || null;
      if (showForKw) {
        llmKwCheck = checkLlmVerificationAgainstKeywords(showForKw, data.fullText, effectiveVerification);
      }
    } catch (e) { /* shows.json unavailable — skip check */ }

    if (llmKwCheck && !llmKwCheck.passed) {
      // LLM said isValid:true but no show keyword in fullText — high-confidence hallucination.
      console.log(`    ⚠ LLM-verified but no show keyword in text — quarantining as suspected hallucination`);
      console.log(`       keywords checked: ${llmKwCheck.keywordsChecked.slice(0, 8).join(', ')}${llmKwCheck.keywordsChecked.length > 8 ? '…' : ''}`);
      quarantineBody(data); // BRO-2788: records quarantinedWordCount
      data.showNotMentioned = true;
      data.suspectedLlmHallucination = true;
      data.contentTier = (data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt || data.lboRoundupExcerpt) ? 'excerpt' : 'needs-rescrape';
    } else {
      // LLM confirmed content is correct AND keyword gate passed (or was inapplicable).
      // Clear stale flag from previous bad fetches.
      if (data.showNotMentioned) {
        console.log(`    ✓ LLM verified correct show — clearing stale showNotMentioned flag`);
        delete data.showNotMentioned;
        delete data._showNotMentionedDiscoveryAttempted;
        if (data.wrongFullText && data.fullText && !data.wrongProduction && !data.wrongShow) {
          delete data.wrongFullText;
          console.log(`    → Cleared stale wrongFullText (LLM-verified content restored to fullText)`);
        }
      }
      if (data.suspectedLlmHallucination) {
        delete data.suspectedLlmHallucination;
      }
    }
  } else {
    // Heuristic show-mention check — only fires when text is substantive enough.
    // See evaluateShowMentionGuard() for the full reasoning behind the gates.
    const showId = data.showId || review.showId || '';
    let showMeta = null;
    try {
      if (!_showsJsonCache) _showsJsonCache = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
      showMeta = _showsJsonCache.shows.find(s => s.id === showId) || null;
    } catch (e) { /* shows.json unavailable */ }
    const showTitle = pickShowTitleForHeuristic(showId, showMeta);
    const cleanedWordCount = data.textWordCount || 0;
    // Plain check on purpose; see backfill-review-flags.js 1A (BRO-5395 rollback).
    const showCheck = validateShowMentioned(cleanedText, showTitle, showId);
    const guard = evaluateShowMentionGuard(data, cleanedText, cleanedWordCount, showCheck);

    if (guard.action === 'flag-needs-review') {
      // Already-scored review whose lede doesn't mention the title.
      // Don't destroy the score; flag for human review AND repair stale damage from prior runs.
      data.needsReview = true;
      data.needsReviewReason = `Heuristic: show not mentioned in text (${guard.reason}) but already scored — needs human verification`;
      console.log(`    ⚠ Heuristic: show not mentioned — but already scored, flagging for review instead of nulling`);

      if (guard.repairStaleFlags) {
        let repaired = false;
        if (data.showNotMentioned) {
          delete data.showNotMentioned;
          delete data._showNotMentionedDiscoveryAttempted;
          repaired = true;
        }
        // Restore fullText from wrongFullText if a prior run nulled it. Not
        // when a live wrong-content verdict quarantined it (this run's
        // anticipatory gate, BRO-5261 S11).
        if (!data.fullText && data.wrongFullText && !data.wrongProduction && !data.wrongShow) {
          data.fullText = data.wrongFullText;
          data.wrongFullText = null;
          repaired = true;
        }
        if (repaired) {
          console.log(`    → Repaired stale showNotMentioned/wrongFullText damage from prior run`);
        }
      }
    } else if (guard.action === 'null-text') {
      // Unscored review with substantive text that doesn't mention the show.
      data.showNotMentioned = true;
      quarantineBody(data); // BRO-2788: records quarantinedWordCount
      data.contentTier = (data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt || data.lboRoundupExcerpt) ? 'excerpt' : 'needs-rescrape';
      console.log(`    ⚠ Heuristic fallback — show not mentioned in text — fullText nulled: ${guard.reason}`);
    } else if (guard.action === 'skip' && guard.reason) {
      // Heuristic deferred (text too thin) — log so we can spot regressions
      console.log(`    → Show-mention heuristic skipped: ${guard.reason}`);
    } else {
      // showCheck passed (or wasn't decisive) — clear any stale flag from prior runs
      if (data.showNotMentioned) {
        delete data.showNotMentioned;
        delete data._showNotMentionedDiscoveryAttempted;
      }
    }
  }

  // 1A-bis. HIGH-CONFIDENCE AUTHOR OVERRIDE (runs before byline cross-check)
  // ------------------------------------------------------------------------
  // When the article's own per-article metadata (article:author meta or a
  // JSON-LD Person author node) disagrees with the stored criticName, the
  // stored name is almost certainly wrong — typically a SERP-derived site
  // masthead (NYTG "Gillian Russo", Vulture editor, etc.) that overwrote the
  // real review author. article:author and JSON-LD Person are the strongest
  // per-article signals available from the HTML.
  //
  // This fires BEFORE the byline text cross-check because extractByline reads
  // cleanedText (stripped of HTML) and fails on outlets that format the byline
  // in HTML that doesn't survive stripping (NYTG is one — its byline was
  // invisible to the text-based extractor in the 2026-04-19 FA case).
  //
  // Guards: HTML available, not manually set, stored name is concrete (not
  // Unknown), HC author differs from stored.
  if (html && !data.criticNameManual) {
    const hcAuthor = extractHighConfidenceAuthor(html);
    const storedCritic = data.criticName || review.critic || '';
    if (hcAuthor &&
        storedCritic &&
        storedCritic !== 'Unknown' &&
        !matchesCritic(hcAuthor.name, storedCritic)) {
      console.log(`    → HC author override: "${storedCritic}" → "${hcAuthor.name}" (${hcAuthor.source})`);
      data.criticName = hcAuthor.name;
      data.criticEnrichedFrom = `html-override:${hcAuthor.source}`;
      data._priorCriticName = storedCritic;
      // Clear any stale mismatch flags — stored name is now consistent with HTML
      delete data.misattributedFullText;
      delete data.extractedByline;
      delete data.expectedCritic;
      delete data.fullTextWrongAuthor;
      delete data.fullTextWrongAuthorAt;
      delete data._authorMismatch;

      // Rename the file to match the new canonical critic. On conflict,
      // sets data.duplicateOf so validate-review-texts skips it.
      renameReviewFileForCriticOverride(review, data, hcAuthor.name);
    }
  }

  // 1B. Byline cross-check (exclude cast/creative names to avoid false positives)
  const showIdForByline = data.showId || review.showId || '';
  let bylineExcludeNames = [];
  try {
    if (!_showsJsonCache) {
      _showsJsonCache = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
    }
    const showEntry = _showsJsonCache.shows.find(s => s.id === showIdForByline);
    if (showEntry) {
      bylineExcludeNames = [
        ...(showEntry.cast || []).map(c => c.name),
        ...(showEntry.creativeTeam || []).map(c => c.name)
      ];
    }
  } catch (e) { /* shows.json unavailable */ }
  const bylineResult = extractByline(cleanedText, { excludeNames: bylineExcludeNames });
  if (bylineResult.found) {
    const expectedCritic = data.criticName || review.critic || '';
    if (expectedCritic && expectedCritic !== 'Unknown' && !matchesCritic(bylineResult.name, expectedCritic)) {
      // HIGH-CONFIDENCE OVERRIDE: If the article's own metadata (article:author
      // meta or JSON-LD Person.@type) confirms the start-position byline name,
      // the stored criticName is wrong (typically a SERP-derived site-masthead
      // name like NYTG's "Gillian Russo" overwriting review-author "Allison
      // Considine"). Rewrite criticName rather than merely flagging the
      // fullText as misattributed. Guarded: only fire when (a) start-position
      // byline, (b) HC author matches byline, (c) manual flag not set.
      const hcAuthor = html ? extractHighConfidenceAuthor(html) : null;
      const hcConfirmsByline = hcAuthor && matchesCritic(hcAuthor.name, bylineResult.name);
      if (bylineResult.position === 'start' && hcConfirmsByline && !data.criticNameManual) {
        console.log(`    → Author override: "${expectedCritic}" → "${hcAuthor.name}" (byline=start + ${hcAuthor.source})`);
        data.criticName = hcAuthor.name;
        data.criticEnrichedFrom = `html-override:${hcAuthor.source}`;
        data._priorCriticName = expectedCritic;
        // Clear mismatch flags — now consistent
        delete data.misattributedFullText;
        delete data.extractedByline;
        delete data.expectedCritic;
        delete data.fullTextWrongAuthor;
        delete data.fullTextWrongAuthorAt;
        delete data._authorMismatch;
        // Rename the file to match the new canonical critic.
        renameReviewFileForCriticOverride(review, data, hcAuthor.name);
      } else {
        data.misattributedFullText = true;
        data.extractedByline = bylineResult.name;
        data.expectedCritic = expectedCritic;
        console.log(`    ⚠ Byline mismatch: found "${bylineResult.name}", expected "${expectedCritic}"`);
        // Strong mismatch at start of text = high confidence the fullText is from someone else.
        // Flag as fullTextWrongAuthor so rebuild keeps excerpts but distrusts fullText.
        // Only flag on position='start' (byline at top of article = strongest signal).
        if (bylineResult.position === 'start' && !data.fullTextWrongAuthor) {
          data.fullTextWrongAuthor = true;
          data._authorMismatch = `Byline at ${bylineResult.position}: "${bylineResult.name}", expected "${expectedCritic}"`;
          console.log(`    → Flagged fullTextWrongAuthor (byline at start of text)`);
        }
      }
    } else {
      delete data.misattributedFullText;
      delete data.extractedByline;
      delete data.expectedCritic;
      // Clear stale fullTextWrongAuthor if byline now matches (re-fetched correct text)
      if (data.fullTextWrongAuthor && data._authorMismatch && data._authorMismatch.startsWith('Byline at')) {
        delete data.fullTextWrongAuthor;
        delete data.fullTextWrongAuthorAt;
        delete data._authorMismatch;
      }
    }
  }

  // 1B-iii. AUTHOR ENRICHMENT — resolve "Unknown" critics from HTML metadata
  // Skip if criticNameManual is set — this means the name was manually verified and should not be overwritten
  if ((!data.criticName || data.criticName === 'Unknown') && html && !data.criticNameManual) {
    const extractedAuthor = extractAuthorFromHtml(html, cleanedText, {
      excludeNames: bylineExcludeNames,
      url: data.url,
      publishDate: data.publishDate,
    });
    if (extractedAuthor) {
      console.log(`    → Author enriched: "Unknown" → "${extractedAuthor}"`);
      data.criticName = extractedAuthor;
      data.criticEnrichedFrom = 'html-extraction';
      // Clear stale byline mismatch flag (it was "mismatched" against "Unknown")
      delete data.misattributedFullText;
      delete data.extractedByline;
      delete data.expectedCritic;

      // Rename file to match enriched critic name (prevents stale --unknown filenames).
      // Conflict-mode (post PR #290 revert): no inline merge — helper sets
      // data.duplicateOf on conflict and validate-review-texts skips the file.
      // Removing the merge eliminates the line-5069 corruption surface.
      renameReviewFileForCriticOverride(review, data, extractedAuthor);
    }
  }

  // 1B-iv. OUTLET ENRICHMENT — resolve "unknown" outlets from URL domain
  if ((!data.outletId || data.outletId === 'unknown') && data.url) {
    const resolved = resolveOutletFromUrl(data.url);
    if (resolved && resolved.outletId) {
      console.log(`    → Outlet enriched: "unknown" → "${resolved.outletId}" (${resolved.displayName || resolved.outletId})`);
      data.outletId = resolved.outletId;
      data.outlet = resolved.displayName || getOutletDisplayName(resolved.outletId) || resolved.outletId;
      data.outletEnrichedFrom = 'url-resolution';
    }
  }

  // 1C. Content hash dedup (per-show)
  // Skip if duplicateTextOf was intentionally cleared (manual override)
  const fingerprint = computeContentFingerprint(cleanedText);
  if (fingerprint && !data.duplicateTextOfCleared) {
    const showDir = path.dirname(review.filePath);
    const currentFile = path.basename(review.filePath);
    try {
      const siblingFiles = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== currentFile);
      for (const sibling of siblingFiles) {
        const siblingPath = path.join(showDir, sibling);
        try {
          const siblingData = JSON.parse(fs.readFileSync(siblingPath, 'utf8'));
          // This file is already that sibling's canonical: pointing back would
          // close a cycle the daily dedupe heal then has to clear (BRO-3102).
          // A back-pointer already on disk is dropped too, or a cycle written
          // before that fix survives every refetch (BRO-5261 S11: 3 pairs).
          if (pointsAtFile(siblingData, currentFile)) {
            const plan = planCanonicalPointerClear(data, { self: currentFile, clusterFiles: [sibling], siblings: { [sibling]: siblingData } });
            applyCanonicalPointerClear(data, { drop: plan.drop.filter(f => f === 'duplicateTextOf') });
            continue;
          }
          if (siblingData.fullText) {
            const siblingFingerprint = computeContentFingerprint(siblingData.fullText);
            if (siblingFingerprint && siblingFingerprint === fingerprint) {
              if (applyCrossOutletSkip(data, sibling, siblingData, {
                // A consent-salvage reuses the stored text: nothing was fetched, so it proves nothing.
                forcedRefetch: review._forceRefetch === true && !review._salvageUsed,
                hostMatches: hostMatchesOutletDomain(data.url, data.outletId, loadOutletRegistryForDedupe()),
              })) {
                console.log(`    ⚠ Same text as ${sibling} (${siblingData.outletId}); fresh fetch from this outlet's own domain, so not marking this file the copy${data.duplicateOf ? ' (duplicateOf still excludes it)' : ''} (BRO-5254)`);
                continue;
              }
              setDuplicateTextOf(data, sibling);
              console.log(`    ⚠ Duplicate text of ${sibling}`);
              break;
            }
          }
        } catch (e) {
          // Skip unreadable sibling files
        }
      }
      if (!data.duplicateTextOf) {
        delete data.duplicateTextOf;
      }
    } catch (e) {
      // Skip if can't read directory
    }
  }

  // 1D. Content-show match verification (heuristic fallback — skipped when LLM verified)
  // Uses weighted signals (title, director, venue, cast) to detect wrong-show content.
  // Only auto-nulls on confident_mismatch (score <= -3) with 2+ independent negative signals.
  if ((!effectiveVerification || !effectiveVerification.verifiedBy?.startsWith('llm:')) && cleanedText && cleanedText.length > 500 && data.fullText) {
    const showIdForContent = data.showId || review.showId || '';
    let showMeta = null;
    try {
      if (!_showsJsonCache) {
        _showsJsonCache = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
      }
      showMeta = _showsJsonCache.shows.find(s => s.id === showIdForContent);
    } catch (e) { /* shows.json unavailable */ }

    if (showMeta) {
      const contentMatch = verifyFullTextContent(cleanedText, showMeta);
      if (contentMatch.verdict === 'confident_mismatch' && contentMatch.negativeSignalCount >= 2) {
        const alreadyScored = !!(data.assignedScore && data.assignedScore >= 1 && data.assignedScore <= 100);
        if (alreadyScored) {
          // Don't destroy an already-scored review — flag for human review instead
          data.needsReview = true;
          data.needsReviewReason = `Heuristic: content mismatch (score ${contentMatch.score}: ${contentMatch.negativeSignals.join(', ')}) but already scored — needs human verification`;
          console.log(`    ⚠ Heuristic: content mismatch — but already scored, flagging for review instead of nulling`);
        } else {
          const hasExcerpts = !!(data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt || data.lboRoundupExcerpt);
          quarantineBody(data); // BRO-2788: records quarantinedWordCount
          data.contentMismatchNote = contentMatch.negativeSignals.join('; ');
          data.contentMismatchScore = contentMatch.score;
          data.contentTier = hasExcerpts ? 'excerpt' : 'needs-rescrape';
          console.log(`    ⚠ Heuristic fallback — content mismatch (score ${contentMatch.score}): ${contentMatch.negativeSignals.join(', ')}`);
        }
      } else if (contentMatch.verdict === 'confident_mismatch' || contentMatch.verdict === 'probable_mismatch') {
        console.log(`    ⚠ Heuristic fallback — content match warning (${contentMatch.verdict}, score ${contentMatch.score}): ${contentMatch.negativeSignals.join(', ')}`);
      }
    }
  }

  // Store LLM content verification results and ACT on high-confidence rejections
  if (contentVerification) {
    // BRO-4884: the verifier judged this a tour stop at the record's own venue.
    // The rebuild's fullText tour scan reads allowTourSignal, so record it or
    // the review is dropped there as tourContaminationInText.
    Object.assign(data, require('./lib/tour-stop-carveout').tourStopAllowFields(contentVerification, data));
    data.contentVerification = {
      isValid: contentVerification.isValid,
      confidence: contentVerification.confidence,
      truncated: contentVerification.truncated,
      wrongArticle: contentVerification.wrongArticle,
      wrongProduction: contentVerification.wrongProduction,
      articleType: contentVerification.articleType,
      articleTypeConfidence: contentVerification.articleTypeConfidence,
      isFilmTv: contentVerification.isFilmTv,
      issues: contentVerification.issues,
      reasoning: contentVerification.reasoning,
      verifiedBy: contentVerification.verifiedBy,
      // WE long-runner CV hardening issue #4 (task #1615): surface the
      // URL-year/publishDate conflict (if any) so it's visible on disk, not
      // just in the LLM prompt hint. Reverify scripts already persist this
      // via `...result` spreads — this keeps the main ingestion path in sync.
      urlYearConflict: contentVerification.urlYearConflict || null,
      reviewedVenue: contentVerification.reviewedVenue || null,
      // BRO-4563: a "not a review" verdict on a fetch cut off after the lede
      // of a /review/ URL. Rebuild reads this as advisory
      // (isCvVerdictFromPartialWindow), the collector below keeps the text.
      ...(isCvVerdictFromTruncatedFetch(contentVerification, cleanedText, data.url || review.url) ? { truncatedFetch: true } : {}),
      verifiedAt: new Date().toISOString(),
      // Stamp the hash over cleanedText (what's about to be stored as
      // data.fullText a few lines up), NOT contentVerification.contentHash —
      // that one was computed by verifyContent() over the pre-clean raw
      // scrapedText. cleanText()/classifyTextQuality() decode entities,
      // collapse whitespace, and strip trailing junk, which shifts characters
      // inside the hashed 2500-char window on many articles. Hashing the raw
      // text made rebuild-all-reviews.js's staleness guard see a mismatch on
      // the SAME write that created the file — not a later refetch — so ~192
      // of 203 CV-excluded reviews audited 2026-08 had no real staleness at
      // all (audit-stale-cv-hash.js). Hashing cleanedText keeps this stamp in
      // sync with the text the staleness guard actually compares against.
      contentHash: contentHash(cleanedText)
    };

    const isHighConfidence = contentVerification.confidence === 'high' || contentVerification.confidence === 'medium';

    // Bug #12 guard: never null fullText on a review that already has an assignedScore.
    // Text re-collection can fetch wrong content (paywalled, wrong page, wrong production) but
    // the LLM seeing garbage text is NOT a reason to destroy a review that was already scored.
    // Instead: flag for human review so the bad text can be investigated without losing the score.
    //
    // Balusters postmortem CLASS 1: also guard if the ensemble scored this with confidence
    // (llmScore.score finite + confidence ∈ {high, medium}) even before rebuild has written
    // assignedScore. Helen Shaw + Ron Fassler had llmScore=80/88 high-conf when CV re-ran
    // mid-session and would have nulled their fullText without this guard.
    const alreadyScored = !!(data.assignedScore && data.assignedScore >= 1 && data.assignedScore <= 100)
      || hasHighConfidenceLlmScore(data);

    // BRO-5805: a body naming most of THIS show's listed cast is about this show's production. The verifier has no
    // cast list and reads scrape chrome, so its wrong-production / film-TV verdicts are advisory
    // against that evidence.
    const ownShowEvidence = ownShowTextEvidence(data.fullText, _showsJsonCache?.shows?.find(s => s.id === data.showId)).strong;
    if (ownShowEvidence && (contentVerification.wrongProduction || contentVerification.isFilmTv)) {
      console.log(`    ⚠ LLM: verdict contradicted by the show's own cast named in the text — advisory, text kept`);
    }

    // Auto-invalidate on HIGH confidence wrong article type (preview, interview, news, etc.)
    // Medium confidence → log warning only (21% LLM error rate on article classification)
    if (contentVerification.wrongArticle) {
      const artConf = contentVerification.articleTypeConfidence || 'medium';
      const artType = contentVerification.articleType || 'unknown';
      if (data.contentVerification.truncatedFetch) {
        // The fetch stopped after the lede of a /review/ page and the verifier
        // said so itself: a truncated review, not a non-review (BRO-4563).
        // Keep the text; classifyContentTier below sets its tier.
        console.log(`    ⚠ LLM: "not a review" (${artType}, ${artConf}) judged on a cut-off fetch of a review URL — kept as truncated, not invalidated`);
      } else if (isCvVerdictFromPartialWindow(data.contentVerification, data.fullText, data)) {
        // BRO-6225: a preview/feature/news call on the head of a longer article
        // is advisory (BRO-4429); rebuild will not promote it, so parking the
        // body here only left a full review with no text to score.
        console.log(`    ⚠ LLM: "not a review" (${artType}, ${artConf}) judged on the head of a longer article — advisory, text kept`);
      } else if (artConf === 'high' && data.fullText && !laneHeld(data, 'nonReview')) {
        if (alreadyScored) {
          // Don't destroy an already-scored review — flag for human review instead
          data.needsReview = true;
          data.needsReviewReason = `Collector LLM: not a review (${artType}, ${artConf} conf) but already scored — needs human verification`;
          console.log(`    ⚠ LLM: Not a review (${artType}, ${artConf} conf) — but already scored, flagging for review instead of nulling`);
        } else {
          quarantineBody(data); // BRO-2788: records quarantinedWordCount
          data.contentTier = 'invalid';
          data.incompleteReason = 'non_review';
          data.wrongShowReason = `Collector LLM: not a review (${artType}, confidence: ${artConf}) — ${(contentVerification.reasoning || '').substring(0, 200)}`;
          console.log(`    ✗ LLM: Not a review — ${artType} (${artConf} confidence) — fullText nulled, contentTier=invalid`);
        }
      } else if (artConf === 'medium') {
        console.log(`    ⚠ LLM: Possibly not a review — ${artType} (medium confidence) — no action taken`);
      }
    }

    // Auto-null fullText on high/medium confidence wrong production (tour, regional, off-Broadway, etc.)
    // Off-Broadway shows are exempt: they commonly transfer from regional theaters,
    // so LLM often misidentifies the production as "wrong" when it's actually correct.
    // Human-verified files are also exempt (humanReviewedWrongProduction === false signals
    // a human has reviewed and confirmed this is NOT wrong production — DoaS Apr 9-10 #10).
    const showCat = _showsJsonCache?.shows?.find(s => s.id === data.showId)?.category;
    if (shouldSkipWrongProductionAudit(data) || laneHeld(data, 'wrongProduction')) {
      console.log(`    ⚠ wrongProduction override set (human-verified or manual) — skipping wrongProduction check`);
    } else if (contentVerification.wrongProduction && showCat !== 'off-broadway' && !ownShowEvidence &&
               ((isHighConfidence && data.fullText) || contentVerification.wrongArticle)) {
      // wrongArticle (completely wrong page fetched) bypasses the isHighConfidence+fullText
      // requirements — the temporal override can downgrade confidence to "low" and the
      // wrongArticle handler may have already nulled fullText, but a clearly wrong page
      // (e.g. Cats article filed under Proof) must still set the top-level flag so the
      // poller re-discovers the correct review URL. Bug surfaced Proof opening night Apr 16 2026.
      if (alreadyScored) {
        // Don't destroy an already-scored review — flag for human review instead
        data.needsReview = true;
        data.needsReviewReason = `Collector LLM: wrong production (${contentVerification.confidence} conf) but already scored — needs human verification`;
        console.log(`    ⚠ LLM: Wrong production (${contentVerification.confidence}) — but already scored, flagging for review instead of nulling`);
      } else {
        const hasExcerpts = !!(data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt || data.lboRoundupExcerpt);
        if (data.fullText) {
          quarantineBody(data); // BRO-2788: records quarantinedWordCount
        }
        data.wrongProduction = true;
        invalidateWrongProductionAutoClear(data);
        // Record the diagnostic reason so future audits can distinguish LLM-detected
        // wrong-production from silent (reason-less) guard fires. Before this line was
        // added, this code path stamped wrongProduction=true with no trail — reviews
        // were invisible in the composite with no way to tell why. See Notion card
        // "Recover wrongProduction false positives — 722 reviews invisible" (Apr 11 2026).
        data.wrongProductionReason = `Collector LLM: wrong production (${contentVerification.confidence}) — ${(contentVerification.reasoning || '').substring(0, 200)}`;
        data.contentTier = hasExcerpts ? 'excerpt' : 'needs-rescrape';
        console.log(`    ✗ LLM: Wrong production (${contentVerification.confidence}) — fullText nulled`);
      }
    } else if (contentVerification.wrongProduction && isHighConfidence && showCat === 'off-broadway') {
      console.log(`    ⚠ LLM: Wrong production detected but OB exempt — keeping fullText`);
    }

    // Auto-null fullText on high/medium confidence film/TV content
    if (contentVerification.isFilmTv && isHighConfidence && data.fullText && !ownShowEvidence && !laneHeld(data, 'wrongProduction')) {
      if (alreadyScored) {
        // Don't destroy an already-scored review — flag for human review instead
        data.needsReview = true;
        data.needsReviewReason = `Collector LLM: film/TV content (${contentVerification.confidence} conf) but already scored — needs human verification`;
        console.log(`    ⚠ LLM: Film/TV content (${contentVerification.confidence}) — but already scored, flagging for review instead of nulling`);
      } else if (!wrongShowCleared(data)) {
        const hasExcerpts = !!(data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt || data.lboRoundupExcerpt);
        quarantineBody(data); // BRO-2788: records quarantinedWordCount
        data.wrongShow = true;
        data.wrongShowReason = `Collector LLM: film/TV content (${contentVerification.confidence}) — ${(contentVerification.reasoning || '').substring(0, 200)}`;
        data.contentTier = hasExcerpts ? 'excerpt' : 'needs-rescrape';
        invalidateWrongShowAutoClear(data); // BRO-3225: re-flag must invalidate a still-fresh auto-clear stamp
        console.log(`    ✗ LLM: Film/TV content (${contentVerification.confidence}) — fullText nulled`);
      }
    }

    // Flag low-confidence rejections for manual review instead of auto-acting
    if (!contentVerification.isValid && !isHighConfidence) {
      data.flaggedForReview = true;
      data.flagReason = `LLM verification: ${contentVerification.issues.join(', ')} (${contentVerification.confidence} confidence)`;
      console.log(`    ⚠ LLM: Low confidence rejection — flagged for manual review`);
    }

    if (contentVerification.truncated && data.fullText) {
      data.textQuality = 'truncated';
    }
  }

  // 1E. Heuristic fallback: Tour/film/TV contamination check
  // Only runs when LLM verification was not available (no API key, error, etc.)
  if ((!contentVerification || !contentVerification.verifiedBy?.startsWith('llm:')) && data.fullText && data.fullText.length >= 200) {
    const introText = data.fullText.slice(0, 600);
    const showIdForTour = data.showId || review.showId || '';

    // Tour detection (skip tour-stop shows)
    let isTourStop = false;
    let tourShow = null;
    try {
      if (!_showsJsonCache) _showsJsonCache = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
      tourShow = _showsJsonCache.shows.find(s => s.id === showIdForTour) || null;
      if (tourShow && tourShow.status === 'tour-stop') isTourStop = true;
    } catch (e) { /* shows.json unavailable */ }

    if (!isTourStop) {
      const tourCheck = isTourReviewExcerpt(introText, tourContextForShow(tourShow));
      if (tourCheck.isTourReview) {
        data.possibleTourReview = true;
        data.tourSignal = tourCheck.signal;
        console.log(`    ⚠ Heuristic fallback — possible tour review: ${tourCheck.signal}`);
      }
    }

    // Film/TV detection
    const filmCheck = isFilmTvReview(introText);
    if (filmCheck.isFilmTv) {
      data.possibleFilmTvReview = true;
      data.filmTvSignals = filmCheck.signals;
      console.log(`    ⚠ Heuristic fallback — possible film/TV review: ${filmCheck.signals.join(', ')}`);
    }
  }

  // BRO-1431: neutralize stale exclusion state BEFORE reclassifying content
  // tier below — classifyContentTier()'s T5/invalid check
  // (isEffectivelyWrongProductionOrShow) reads wrongProduction/
  // wrongProductionAutoCleared directly, so clearing the flag AFTER
  // classification would classify against the stale flag and stay 'invalid'
  // for one extra run. A stub ingested via ingest-urls.js/gather-reviews.js
  // that this fetch fills in for the first time is the common trigger — see
  // stale-flag-neutralization.js for the full reasoning and guardrails.
  //
  // Only when NO fresh LLM verification ran this pass (Codex adversarial
  // review, BRO-1431 ship-check): the `if (contentVerification) {...}` block
  // above (~line 5063) already wrote data.contentVerification and any
  // wrongProduction stamp from a FRESH read of THIS body — that block IS the
  // "re-evaluate against the new text" step this module exists to unblock for
  // callers with no LLM verification of their own (e.g. ingest-urls.js).
  // Running this too would strip the fresh verdict it just computed.
  if (!contentVerification) {
    neutralizeStaleFlagsOnBodyReplacement(data, fullTextBeforeUpdate);
  }

  // Reclassify contentTier using canonical 5-tier system
  // This ensures contentTier stays in sync whenever fullText changes
  // Also runs when fullText is missing — catches stale contentTier=complete on empty files
  {
    const tierResult = classifyContentTier(data);
    data.contentTier = tierResult.contentTier;
    data.wordCount = tierResult.wordCount;
    data.truncationSignals = tierResult.truncationSignals;
    data.tierReason = tierResult.tierReason;
    data.contentTierReason = tierResult.tierReason;

    // Sync legacy fields with contentTier — rebuild-all-reviews reads textStatus at lines 492/2359
    const tierToTextStatus = { complete: 'complete', truncated: 'truncated', excerpt: 'incomplete', stub: 'incomplete' };
    const tierToTextQuality = { complete: 'full', truncated: 'truncated', excerpt: 'excerpt', stub: 'stub' };
    if (tierToTextStatus[data.contentTier]) {
      data.textStatus = tierToTextStatus[data.contentTier];
    }
    if (tierToTextQuality[data.contentTier]) {
      data.textQuality = tierToTextQuality[data.contentTier];
    }
    data.isFullReview = data.contentTier === 'complete';
  }

  // Paywall truncation override: proxy scrapers (BD, SB) often return truncated text
  // from paywalled outlets that passes generic quality thresholds but is actually
  // missing 30-70% of the review. For known long-form paywalled outlets, enforce
  // minimum char counts when text came from a proxy source.
  if (data.contentTier === 'complete' && data.fullText && data.url) {
    // Conservative thresholds: below these, the review is almost certainly truncated.
    // Only applies to proxy/browser-scraped text.
    // Hard-paywall domains (NYT, New Yorker, WSJ, WaPo, Chicago Tribune) use
    // the completeness assessment in lib/paywall-completeness.js (BRO-4334):
    // per-domain floor (NYT 4,500) unless the text ends with the production
    // info box, and a trailing byline / missing end punctuation on a short
    // text counts as a cut-off. The table below covers the remaining
    // long-form paywalled outlets with the original plain length floor.
    const PAYWALL_MIN_CHARS = require('./lib/paywall-completeness').SOFT_PAYWALL_MIN_CHARS;
    // Includes playwright/browserbase: paywall truncation is just as common from authenticated
    // browser sessions as from proxy requests (short text = paywall hit, not a capsule review)
    const PROXY_METHODS = SCRAPED_SOURCE_METHODS;
    try {
      const urlHost = new URL(data.url).hostname.replace(/^www\./, '');
      const isProxy = PROXY_METHODS.has(data.sourceMethod);
      let truncReason = null;
      if (isProxy && isHardPaywallUrl(data.url)) {
        const pa = assessPaywallCompleteness(data.fullText, data.url, { criticName: data.criticName || review.criticName });
        if (!pa.complete) {
          truncReason = `Paywall truncation: ${pa.reasons.join(', ')} for ${urlHost} (source: ${data.sourceMethod})`;
        }
      } else {
        const minChars = PAYWALL_MIN_CHARS[urlHost];
        if (minChars && isProxy && data.fullText.length < minChars) {
          truncReason = `Paywall truncation: ${data.fullText.length} chars < ${minChars} min for ${urlHost} (source: ${data.sourceMethod})`;
        }
      }
      if (truncReason) {
        data.contentTier = 'truncated';
        data.tierReason = truncReason;
        data.contentTierReason = data.tierReason;
        data.textStatus = 'truncated';
        data.textQuality = 'truncated';
        data.isFullReview = false;
        console.log(`    ⚠ ${truncReason}`);
      }
    } catch (e) { /* invalid URL — skip */ }
  }

  // NYT Critics' Pick: structural HTML check at collection time, plus URL-list belt-and-suspenders.
  // HTML check (data-testid, JSON-LD, CSS class) is structural — no prose FP risk.
  if (data.url && /nytimes\.com/.test(data.url) && !data.isCriticsPick) {
    if (html && extractNYTCriticsPick(html, null)) {
      data.isCriticsPick = true;
      console.log(`    ★ NYT Critics' Pick (HTML): ${data.url}`);
    } else {
      const normalizedUrl = data.url.replace(/[?#].*$/, '').replace(/\/$/, '');
      if (getNytCriticsPicks().has(normalizedUrl)) {
        data.isCriticsPick = true;
        console.log(`    ★ NYT Critics' Pick (URL list): ${normalizedUrl}`);
      }
    }
  }

  // Re-derive incompleteReason for this text, as rebuild does: set it, or
  // remove one the classifier no longer gives (BRO-5261).
  if (data.contentTier && data.contentTier !== 'complete') {
    applyIncompleteReason(data, null);
  } else {
    delete data.incompleteReason;
    delete data.incompleteDetail;
  }

  // Pattern Card #1: clear stale failure-state flags proactively on the success path.
  // safeWriteReview's merge behavior would copy them back from disk if not explicitly set.
  // skipIncompleteReasonClear: the reason was just re-derived above, so the
  // generic stale-clear must not null it on the same write (BRO-2241).
  clearFailureFlags(data, { skipIncompleteReasonClear: true });

  // NOTE: Do NOT extract years from URLs to flag wrong production.
  // URL patterns are inconsistent across outlets (republished content, migrated URLs,
  // article IDs that resemble years, etc.). Use publish date or review text content instead.

  // Normalize stored URL: strip browser-only fragments that HTTP servers never receive.
  // Only rewrite if there was actually a fragment to avoid unnecessary diffs.
  if (data.url && /#/.test(data.url)) {
    data.url = data.url.replace(/#[^#]*$/, '');
  }

  // Detect prose-style multi-show articles via structural bold headers (**Title**).
  // Only set isMultiShowReview if not already flagged and text has 2+ distinct shows
  // with bold headers. split-multi-show-roundups.js (CI) handles the actual split.
  if (!data.isMultiShowReview && !data.isRoundupArticle && data.fullText && data.fullText.length >= 1000) {
    const splitterShows = loadSplitterShows();
    const boldHeaders = findBoldHeaderAnchors(data.fullText, splitterShows);
    // Require 2+ distinct POSITIONS, not just 2+ show IDs. The same bold title
    // (e.g. "**Miss Saigon**") matches all productions of that show, so distinctShows
    // alone would flag a single-show review as multi-show whenever the title has
    // multiple productions in the catalogue.
    const distinctPositions = new Set(boldHeaders.map(a => a.position));
    const distinctShows = new Set(boldHeaders.map(a => a.showId));
    if (distinctPositions.size >= 2 && distinctShows.size >= 2) {
      data.isMultiShowReview = true;
      console.log(`    ↔ Bold-header multi-show detected (${distinctPositions.size} positions, ${distinctShows.size} shows): ${[...distinctShows].join(', ')}`);
    }
  }

  // Stamped at the write so toLength names the text written (BRO-5254); the
  // multi-show fan-out below re-stamps if it cuts the text again.
  if (forcedReplacement) {
    const trim = forcedRefetchTrim(fullTextBeforeUpdate, data.fullText);
    if (trim) data.fullTextTrimmed = trim;
  }
  persistReviewSnapshot({ filePath: review.filePath, data: data });

  // BRO-4431: a multi-show article (photo-caption sections, capsule round-ups
  // split by a rule, or a column that introduces each show in turn) is filed
  // under EVERY show it reviews: this file keeps its own section and sibling
  // files are written for the others. Before this, the split only ran in an
  // offline backfill no workflow called, so the other shows never got it.
  try {
    const fan = applyMultiShowFanoutToFile(review.filePath, { shows: loadSplitterShows() });
    if (fan.applied) {
      console.log(`    ↔ Multi-show article (${fan.strategy}): ${fan.children.map((c) => `${c.showId}=${c.action}`).join(', ')}`);
      // The fan-out may cut this file down to its own section: the trim
      // breadcrumb must name the text now on disk (BRO-5254).
      if (forcedReplacement) {
        const after = readReviewForUpdate(review.filePath);
        const trim = forcedRefetchTrim(fullTextBeforeUpdate, after.fullText);
        const t = after.fullTextTrimmed;
        if (trim && !(t && t.fromLength === trim.fromLength && t.toLength === trim.toLength)) {
          after.fullTextTrimmed = trim;
          persistReviewSnapshot({ filePath: review.filePath, data: after });
        }
      }
    }
  } catch (e) {
    console.log(`    ⚠ multi-show fan-out failed: ${e.message}`);
  }

  try {
    emitStage({
      showId: data.showId || review.showId,
      reviewKey: `${data.outletId || review.outletId}:${data.criticName || review.critic}:${data.url || review.url || ''}`,
      stage: 'review-text-collected',
      metadata: { textLength: data.fullText ? data.fullText.length : 0 },
    });
  } catch (e) { process.stderr.write(`[stage-latency] collect emit failed: ${e.message}\n`); }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

function loadState() {
  const statePath = path.join(CONFIG.stateDir, 'progress.json');
  if (fs.existsSync(statePath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const startTime = new Date(saved.startTime);
      const hoursSinceStart = (Date.now() - startTime.getTime()) / (1000 * 60 * 60);
      if (hoursSinceStart < 24) {
        state = saved;
        // Ensure tierBreakdown and all sub-arrays exist (older state files may be missing keys)
        if (!state.tierBreakdown) {
          state.tierBreakdown = { playwright: [], amp: [], browserbase: [], directCookies: [], scrapingdog: [], scrapingbee: [], brightdata: [], archiveToday: [], archive: [] };
        } else {
          for (const key of ['playwright', 'amp', 'browserbase', 'scrapingdog', 'scrapingbee', 'brightdata', 'archiveToday', 'archive']) {
            if (!state.tierBreakdown[key]) state.tierBreakdown[key] = [];
          }
        }
        if (!state.log) state.log = [];
        // BRO-3024: a resumed file may already carry duplicates written by a
        // CONCURRENT run (per-show concurrency groups share this one file) or
        // by an earlier RETRY_FAILED=true pass. Normalise BEFORE the resume
        // line below reports a count, so the run never prints a pre-dedupe
        // and a post-dedupe figure for the same array one line apart.
        const inherited = dedupeAttemptState(state);
        console.log(`Resuming from previous run (${state.processed.length} already processed)`);
        if (inherited.processed || inherited.failed || inherited.succeededAfterFailure || inherited.tierBreakdown) {
          console.log(`  Normalised inherited attempt state: dropped ${inherited.processed} duplicate processed, ${inherited.failed} duplicate failed, ${inherited.tierBreakdown} duplicate tier entries; moved ${inherited.succeededAfterFailure} failed-then-succeeded into recoveredAfterFailure (${state.recoveredAfterFailure?.length || 0} total)`);
        }
        return true;
      }
    } catch (e) {
      console.log('Could not load previous state, starting fresh');
    }
  }
  return false;
}

function saveState() {
  // BRO-3024: dedupe at the WRITE, not only at the read. The in-process
  // shouldSkipAlreadyAttempted() guard is bypassed by design under
  // RETRY_FAILED=true and cannot see a concurrent run's appends at all, so
  // this is the only point that holds under both mechanisms — whichever run
  // serialises last writes a unique-only array. Also makes the "(N failed)"
  // figure in each "chore: Checkpoint" commit message truthful.
  dedupeAttemptState(state);
  fs.mkdirSync(CONFIG.stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(CONFIG.stateDir, 'progress.json'),
    JSON.stringify(state, null, 2)
  );

  // Write a human-readable progress log for real-time monitoring
  // (committed with each checkpoint so progress is visible via git log)
  const log = {
    updatedAt: new Date().toISOString(),
    processed: state.processed?.length || 0,
    failed: state.failed?.length || 0,
    successRate: state.processed?.length
      ? `${((state.processed.length / (state.processed.length + (state.failed?.length || 0))) * 100).toFixed(1)}%`
      : '0%',
    tierBreakdown: {
      playwright: state.tierBreakdown?.playwright?.length || 0,
      amp: state.tierBreakdown?.amp?.length || 0,
      browserbase: state.tierBreakdown?.browserbase?.length || 0,
      directCookies: state.tierBreakdown?.directCookies?.length || 0,
      scrapingdog: state.tierBreakdown?.scrapingdog?.length || 0,
      scrapingbee: state.tierBreakdown?.scrapingbee?.length || 0,
      brightdata: state.tierBreakdown?.brightdata?.length || 0,
      archiveToday: state.tierBreakdown?.archiveToday?.length || 0,
      archive: state.tierBreakdown?.archive?.length || 0,
    },
    browserbaseSessions: stats.browserbaseSessionsUsed || 0,
    recentActivity: (state.log || []).slice(-20),
  };
  fs.writeFileSync(
    path.join(CONFIG.stateDir, 'live-progress.json'),
    JSON.stringify(log, null, 2)
  );
}

/**
 * Push local commits to the public repo remote.
 * Separated from commitChanges so pushes can be less frequent than commits.
 *
 * Conflict resolution: collection-state/ files are per-run state that should
 * always keep the current run's version. During rebase, "theirs" = our commits
 * being replayed, so --theirs keeps our data. During merge, "ours" = our branch.
 */
function _pushToRemote(processed) {
  // Task #420: this used to hand-roll fetch → rebase -X theirs → merge fallback
  // → push. The shared helper does all of that AND the four fixes this copy
  // never received: the explicit-destination fetch refspec (#394), the
  // single-timeout fetch (#464), the shallow depth bound (#466) and HEAD
  // preservation (#543). The depth bound is the load-bearing one here — this
  // script runs in 11 workflows, 5 of them on the default `fetch-depth: 1`
  // checkout, where a bare `git fetch origin main` makes upload-pack send the
  // whole ~2.1 GB / 165k-commit repo instead of the ~500-object delta
  // (measured on a real runner, run 30218025467: 1365 MB before a 180s kill).
  // Its conflict policy matches the one deleted here for THIS call site: keep
  // the local run's data for data/collection-state/ and data/audit/, accept
  // remote for everything else. (That equivalence is specific to this block —
  // rediscover/verify had different hand-rolled policies; see their comments.)
  const { ok, stderr } = pushWithRetry({ branch: 'HEAD:main', retries: 5 });
  if (ok) {
    console.log(`  ✓ Pushed checkpoint to remote (${processed} reviews)`);
  } else {
    console.log(`    ⚠ Checkpoint push failed (will be caught by final workflow commit): ${stderr.split('\n').slice(-3).join(' ')}`);
  }
  return ok;
}

/**
 * Commit changes to git (for incremental saving during long runs).
 *
 * Local commit happens every batch, but AMENDS the not-yet-pushed commit
 * instead of creating a new one each time. GH Actions runners are ephemeral —
 * an unpushed local commit has no crash-safety edge over an uncommitted
 * change, both vanish with the container — so batching several batches'
 * worth of data/collection-state/ changes into one commit costs nothing on
 * that front, while cutting what lands on origin/main once pushed. Before
 * this, a fresh commit per batch was landing as ~267 separate "chore:
 * Checkpoint" commits/day on main, starving other jobs' pushes (BRO-2983).
 *
 * The public-repo push (this script's only main-branch write) is throttled
 * to a wall-clock interval (CONFIG.mainPushIntervalMs, default 30min)
 * instead of a batch count. This is decoupled from the private review-texts
 * repo checkpoint below, which keeps its existing every-pushEveryNBatches
 * cadence — that one guards actual scraped review text, the crash-safety-
 * relevant data; data/collection-state/ is just resume bookkeeping, and
 * losing up to one throttle interval of it on a crash means some reviews
 * get reprocessed on resume, not lost.
 */
let _batchesSinceLastPush = 0;
let _hasPendingMainCommit = false;
let _lastMainPushAt = Date.now();

function commitChanges(processed, forcePush = false) {
  const { execSync } = require('child_process');

  try {
    // Check if we're in a git repo and in CI
    if (!process.env.GITHUB_ACTIONS) {
      console.log('  (Skipping git commit - not in GitHub Actions)');
      return;
    }

    // Stage changes
    // Note: data/review-texts/ and data/archives/ are in .gitignore (review-texts pushed to private repo)
    // The provider ledger too: the checkpoint push runs push-with-retry.sh, and with
    // scraper-spend-ledger.jsonl left unstaged its rebase refusal / reset+cherry-pick
    // path wiped this run's provider rows (2026-09-29: Collect Review Texts made
    // Scrapingdog calls, 0 ledger rows landed). Only that file: the rest of
    // data/audit/ (e.g. the 23MB stage-latency.jsonl) would disqualify the API
    // fallback and bloat every amend; the workflow's final commit stages it.
    execSync('git add data/collection-state/ data/audit/scraper-spend-ledger.jsonl', {
      stdio: 'pipe'
    });

    // Check if there are staged changes
    const status = execSync('git diff --staged --quiet || echo "changes"', {
      encoding: 'utf8',
      stdio: 'pipe'
    }).trim();

    if (status === 'changes') {
      // Configure git (in case not already done)
      try {
        execSync('git config user.email "action@github.com"', { stdio: 'pipe' });
        execSync('git config user.name "GitHub Action"', { stdio: 'pipe' });
      } catch (e) {
        // Already configured
      }

      // Build descriptive commit message with tier stats
      const bbUsed = stats.browserbaseSessionsUsed || 0;
      const failCount = state.failed?.length || 0;
      const tierInfo = [];
      if ((state.tierBreakdown?.playwright?.length || 0) > 0) tierInfo.push(`PW:${state.tierBreakdown.playwright.length}`);
      if (bbUsed > 0) tierInfo.push(`BB:${bbUsed}`);
      if ((state.tierBreakdown?.brightdata?.length || 0) > 0) tierInfo.push(`BD:${state.tierBreakdown.brightdata.length}`);
      if ((state.tierBreakdown?.archive?.length || 0) > 0) tierInfo.push(`Ar:${state.tierBreakdown.archive.length}`);
      const tierStr = tierInfo.length ? ` [${tierInfo.join(',')}]` : '';
      const failStr = failCount > 0 ? ` (${failCount} failed)` : '';
      const ctFilter = CONFIG.contentTierFilter ? ` (${CONFIG.contentTierFilter})` : '';
      const msg = `chore: Checkpoint - collected ${processed} review texts${ctFilter}${tierStr}${failStr}`;

      if (_hasPendingMainCommit) {
        execSync(`git commit --amend -m ${JSON.stringify(msg)}`, { stdio: 'pipe' });
      } else {
        execSync(`git commit -m ${JSON.stringify(msg)}`, { stdio: 'pipe' });
        _hasPendingMainCommit = true;
      }

      console.log(`  ✓ Committed checkpoint locally (${processed} reviews)`);
    } else {
      console.log('  (No changes to commit)');
    }

    // Push to main at most every mainPushIntervalMs (or when forced, e.g. the
    // final commit) — the amend above means at most one commit reaches
    // origin/main per push cycle, regardless of how many batches ran since
    // the last one.
    const elapsedSinceMainPush = Date.now() - _lastMainPushAt;
    if (_hasPendingMainCommit && (forcePush || elapsedSinceMainPush >= CONFIG.mainPushIntervalMs)) {
      // Only clear the pending-commit flag / reset the clock on a CONFIRMED
      // push. On failure, leave both as-is: the next batch's amend keeps
      // accumulating on the same still-unpushed commit, and — since
      // _lastMainPushAt was never bumped — the very next batch retries the
      // push immediately rather than waiting out a fresh mainPushIntervalMs.
      if (_pushToRemote(processed)) {
        _hasPendingMainCommit = false;
        _lastMainPushAt = Date.now();
      }
    }

    // Private repo review-texts checkpoint: separate cadence (every
    // pushEveryNBatches), unaffected by the main-repo throttle above.
    _batchesSinceLastPush++;
    if (forcePush || _batchesSinceLastPush >= CONFIG.pushEveryNBatches) {
      _batchesSinceLastPush = 0;
      pushReviewTextsCheckpoint(processed);
    }

  } catch (e) {
    console.error(`  ✗ Git commit/push FAILED: ${e.message}`);
    console.error(`    This means work may be lost if the job times out!`);
    console.error(`    Check workflow permissions: needs 'contents: write'`);
    // Don't throw - we don't want to stop the collection
  }
}

/**
 * Push review-texts to private repo as a checkpoint.
 * Runs at every checkpoint so data is saved incrementally, not just at the end.
 */
function pushReviewTextsCheckpoint(processed) {
  const gate = shouldPushReviewTextsCheckpoint(process.env);
  if (!gate.ok) {
    // BRO-2381: this used to be a bare `return` — several workflow steps
    // invoke this script without REVIEW_TEXTS_TOKEN in their env, so the
    // mid-run checkpoint silently no-op'd for the whole run with nothing in
    // the job log to show it. Logging makes that visible without changing
    // behavior for the correctly-configured case.
    console.log(`  (Skipping review-texts checkpoint push — ${gate.reason})`);
    return;
  }

  const rtDir = path.join(process.cwd(), 'data', 'review-texts');
  if (!fs.existsSync(path.join(rtDir, '.git'))) {
    console.log('  (No private repo checkout — skipping review-texts push)');
    return;
  }

  const { execSync } = require('child_process');

  try {
    // Configure git for private repo
    execSync('git config user.name "GitHub Action"', { cwd: rtDir, stdio: 'pipe' });
    execSync('git config user.email "action@github.com"', { cwd: rtDir, stdio: 'pipe' });

    // Ensure remote uses the token
    const remoteUrl = `https://x-access-token:${process.env.REVIEW_TEXTS_TOKEN}@github.com/thomaspryor/broadway-review-texts.git`;
    try {
      execSync(`git remote set-url origin "${remoteUrl}"`, { cwd: rtDir, stdio: 'pipe' });
    } catch (e) {
      execSync(`git remote add origin "${remoteUrl}"`, { cwd: rtDir, stdio: 'pipe' });
    }

    // ROOT-CAUSE GUARD (2026-05-27, mirrors .github/actions/push-review-texts):
    // the review-texts data repo contains ONLY JSON review files — never
    // symlinks. A stray symlink committed via `git add -A` from a local
    // session once dangled in CI and crashed the collection pipeline for
    // ~8h. This checkpoint previously never reached here in practice (the
    // REVIEW_TEXTS_TOKEN gate above silently no-op'd on every workflow this
    // script runs in until BRO-2381), so it never carried this guard — now
    // that the gate is fixed and this path actually runs mid-collection,
    // it needs the same protection the final push action has.
    const strayLinks = execSync("find . -type l -not -path './.git/*'", { cwd: rtDir, stdio: 'pipe' }).toString().trim();
    if (strayLinks) {
      console.log(`  ⚠ Removing stray symlink(s) before checkpoint commit: ${strayLinks.split('\n').join(', ')}`);
      execSync("find . -type l -not -path './.git/*' -delete", { cwd: rtDir, stdio: 'pipe' });
    }

    // Stage all changes
    execSync('git add -A', { cwd: rtDir, stdio: 'pipe' });

    // BRO-2559: `git add -A` stages a deletion for ANY tracked file this
    // job's local working copy happens to be missing — regardless of why
    // (this checkpoint runs mid-collection on whatever subset of shows the
    // process touched; a file this job never fetched into its own working
    // tree is indistinguishable to `git add -A` from one someone deleted on
    // purpose). A hand-flagged wrongProduction/wrongShow verdict living only
    // in that file is silently discarded the moment this commits — safe
    // WriteReview never runs, so its disk-level protection never gets a
    // chance to fire. Reverse any such deletion for a file that still
    // carries a protected field at HEAD before it can land.
    const restoredDeletions = protectStagedDeletions(rtDir);
    if (restoredDeletions.length > 0) {
      console.log(`  ⚠ Restored ${restoredDeletions.length} file(s) staged for deletion with protected fields (BRO-2559): ${restoredDeletions.slice(0, 5).join(', ')}${restoredDeletions.length > 5 ? '…' : ''}`);
    }

    // Check if there are changes
    let hasStagedChanges = false;
    try {
      execSync('git diff --staged --quiet', { cwd: rtDir, stdio: 'pipe' });
    } catch (e) {
      hasStagedChanges = true;
    }

    // BRO-3599: a clean index is not "nothing to push". An earlier
    // checkpoint whose push failed left its commit local-only; push it now.
    const action = decideCheckpointAction({
      hasStagedChanges,
      unpushedCommits: hasStagedChanges ? null : countUnpushedCommits(rtDir, 'main'),
    });
    if (action === 'skip') return;

    if (action === 'commit-and-push') {
      const msg = `chore: Checkpoint review texts (${processed} collected)`;
      execSync(`git commit -m "${msg}"`, { cwd: rtDir, stdio: 'pipe' });
    } else {
      console.log('  ↻ Retrying push of an earlier unpushed review-texts checkpoint commit');
    }

    // Push through the shared helper (task #420). This block used to hand-roll
    // `git pull --rebase -X theirs` + protected-field restore + modify/delete
    // conflict resolution + a 3-attempt loop — every one of which push-with-
    // retry.sh already does, plus the fixes this copy never got. The
    // review-texts checkout is ALSO shallow by default (.github/actions/
    // checkout-review-texts sets fetch-depth: 1), so the unbounded pull here
    // had the same whole-repo-transfer exposure as the main-repo fetch above.
    // The helper's restore_protected_fields() runs the same
    // lib/restore-protected-fields.js this used to invoke by hand, and it
    // additionally runs validate-added-review-ownership.js for this remote.
    //
    // DELIBERATE POLICY CHANGE (Codex ship-check, 2026-07-26): on a
    // modify/delete conflict the old hand-rolled loop kept whatever file was
    // still on disk, which RESURRECTS a tombstone the remote deleted on
    // purpose — the --unknown.json -> --named-critic.json rename case
    // push-with-retry.sh documents. The helper accepts the remote deletion
    // instead. That is the repo's intended behaviour (memory/feedback_outlet_
    // merge_no_flag_and_keep.md), so this is a fix, not a regression.
    const rtPush = pushWithRetry({ cwd: rtDir, branch: 'main', retries: 3 });
    if (rtPush.ok) {
      markReviewTextsPushed(); // BRO-5308: final push-review-texts reports pushed=true
      console.log(`  ✓ Pushed review-texts checkpoint to private repo`);
      return;
    }
    console.log(`  ⚠ Failed to push review-texts checkpoint (will retry at next checkpoint): ${rtPush.stderr.split('\n').slice(-3).join(' ')}`);
  } catch (e) {
    console.log(`  ⚠ Review-texts checkpoint push error: ${e.message}`);
  }
}

// ============================================================================
// FIND REVIEWS TO PROCESS
// ============================================================================

/** Reviews whose show the opening-night lane does not hold right now (lease-guard writableShowIds). */
function dropLeasedReviews(reviews, opts) {
  const ok = new Set(require('./lib/opening-night-lane/lease-guard').writableShowIds([...new Set(reviews.map(r => r.showId))], { label: 'collect', ...opts }));
  return reviews.filter(r => ok.has(r.showId));
}

function findReviewsToProcess() {
  const reviews = [];

  if (!fs.existsSync(CONFIG.reviewTextsDir)) {
    console.log(`Creating ${CONFIG.reviewTextsDir} directory...`);
    fs.mkdirSync(CONFIG.reviewTextsDir, { recursive: true });
    return reviews;
  }

  // Load show statuses + recency dates so we can prioritize recent shows.
  // Recency falls back openingDate → previewsStartDate: a show still in
  // previews has no openingDate, and keying it on the 1900 sentinel sorted it
  // behind all ~2,800 dated shows, so with max_reviews=300 its reviews were
  // never collected at all. See scripts/lib/collection-priority.js.
  const openShowIds = new Set();
  const showOpeningDates = new Map(); // showId → recency key (YYYY-MM-DD)
  // showId → show object, for the fetch-retry lifecycle gate below (BRO-787).
  const showsById = new Map();
  try {
    const showsData = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
    const allShows = showsData.shows || showsData;
    allShows.forEach(s => {
      if (s.status === 'open' || s.status === 'previews') openShowIds.add(s.id);
      showsById.set(s.id, s);
    });
    for (const [id, key] of buildShowRecencyMap(allShows)) showOpeningDates.set(id, key);
    console.log(`  Prioritizing ${openShowIds.size} open/preview shows`);
  } catch (e) {
    console.log('  ⚠ Could not load shows.json for prioritization');
  }

  if (CONFIG.reviewFilter.size > 0) {
    console.log(`  🎯 FAST PATH: Only processing ${CONFIG.reviewFilter.size} specific file(s): ${[...CONFIG.reviewFilter.files, ...CONFIG.reviewFilter.keys].join(', ')}${CONFIG.reviewFilter.force.size ? ` (${CONFIG.reviewFilter.force.size} forced)` : ''}`);
  }

  // listShowDirs tolerates dangling symlinks / stray files (one bad entry
  // crashed the whole 3×-daily pipeline for ~8h on 2026-05-27).
  const shows = listShowDirs(CONFIG.reviewTextsDir);

  // Load failed fetches. Lifecycle-tiered abandonment (BRO-787): a single
  // gate, shouldRetryFetch, replaces the old flat isPermanentlyFailed
  // pre-filter (3 dead/garbage, 5 everything else) so there is exactly one
  // source of truth for "how many retries does this review get" — not two
  // independently-tuned thresholds that could drift apart. This scan can only
  // evaluate the count-vs-tiered-max part (no review file loaded yet); the
  // per-file loop below applies the FULL gate (adds cooldown +
  // urlCorrectedRefetch bypass) once each review's own JSON is available —
  // see the fetchGate check near "Skip if no URL".
  const failedFetches = new Set();  // For retry mode: IDs to include
  const failedFetchesByReviewId = new Map(); // reviewId → ledger entry, for the per-file gate below
  let permanentSkipCount = 0;
  // Per-run caps on retry work that must hit the network (BRO-4185): the
  // consent/garbage drain and the one-time stale-mismatch reopen. Uncapped,
  // the 2026-09-28 12:39 run spent its whole 300-min job budget on
  // WhatsOnStage URLs timing out at 90s each and was cancelled. Applied AFTER
  // sorting (below), so candidates dropped by later filters or the maxReviews
  // slice never use a slot. Stored-text re-verifies need no fetch: uncapped.
  const DRAIN_NETWORK_PER_RUN = 15;
  const MISMATCH_REOPEN_PER_RUN = 20;
  const failedPath = path.join(CONFIG.reviewTextsDir, 'failed-fetches.json');
  if (fs.existsSync(failedPath)) {
    try {
      const failed = JSON.parse(fs.readFileSync(failedPath, 'utf8'));
      for (const f of failed) {
        const id = f.reviewId || `${f.showId}/${f.file}`;
        const entry = { failureReason: effectiveFailureReason(f), failureCount: f.failureCount || 1, url: f.url || null, lastFailedAt: f.lastFailedAt || null, lastCappedAt: f.lastCappedAt || null };
        failedFetchesByReviewId.set(id, entry);
        // budget_capped entries are excluded here as well as at write time:
        // belt-and-braces, so a ledger written before this fix still can't
        // retire a URL the breaker merely deferred.
        // `{}`: the review file isn't loaded yet, so pre-publication
        // failures (BRO-4281) aren't subtracted here. That can only over-skip
        // RETRY_FAILED's already-complete-text refetch; the per-file fetchGate
        // below sees the real tally.
        const gate = shouldRetryFetch(showsById.get(f.showId) || null, {}, entry);
        if (!gate.shouldRetry) {
          permanentSkipCount++;
        } else if (CONFIG.retryFailed) {
          failedFetches.add(id);
        }
      }
    } catch (e) {}
  }
  if (permanentSkipCount > 0) {
    console.log(`  Skipping ${permanentSkipCount} permanently failed reviews (lifecycle-tiered thresholds, BRO-787)`);
  }

  for (const showId of shows) {
    if (!isInShowScope(showId, CONFIG.showFilterSet, CONFIG.showFilter)) continue;
    if (CONFIG.marketFilter && !showId.includes(CONFIG.marketFilter)) continue;

    const showDir = path.join(CONFIG.reviewTextsDir, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      // Skip if review_filter is active and this file isn't in it
      if (!matchesReviewFilter(CONFIG.reviewFilter, showId, file)) continue;

      const filePath = path.join(showDir, file);
      const reviewId = `${showId}/${file}`;

      // Permanently-failed / cooldown skip (lifecycle-tiered, BRO-787) lives
      // further down as `fetchGate`, once `data` (the review file) is loaded —
      // it needs the review's own fetchRetryAfter/fetchDiscoveryAbandoned
      // state and the urlCorrectedRefetch bypass, neither available here.
      // Skip already processed/failed in this session (BRO-3024: shared with
      // the per-attempt guard below so both loops agree on one definition).
      if (shouldSkipAlreadyAttempted(state, reviewId, CONFIG.retryFailed)) continue;

      try {
        const data = readReviewForUpdate(filePath);

        // Skip duplicateOf tombstones: rebuild excludes them entirely, so
        // collecting text is wasted fetch budget — and worse, the
        // show-not-mentioned recovery can SERP-flip their URL, which clears
        // duplicateOf via the url-change invariant (it's URL-derived) and
        // resurrects the duplicate until the next write re-tombstones it
        // (the-enormous-crocodile london-theatre--unknown weekly oscillation,
        // 2026-08-01). Explicit --review or --show targeting bypasses (same
        // pattern as the fetchGate skip below), so manual recovery of
        // a wrongly tombstoned file still works.
        if (data.duplicateOf && CONFIG.reviewFilter.size === 0 && !isShowFilterActive(CONFIG.showFilterSet, CONFIG.showFilter)) {
          logExclusion({ script: 'collect-review-texts', showId, file, reason: 'skippedDuplicateOf', details: { url: data.url, duplicateOf: data.duplicateOf } });
          continue;
        }

        // Skip fabricated entries unless a reason_filter is active (enables targeted recovery)
        if (data.fabricatedEntry === true && CONFIG.incompleteReasonFilter.length === 0) {
          logExclusion({ script: 'collect-review-texts', showId, file, reason: 'skippedFabricatedEntry', details: { url: data.url, outletId: data.outletId } });
          continue;
        }

        // Skip permanently retired URLs (broken redirects, etc.) — these are in failed-fetches.json
        // too, but checking the file field avoids re-reading failed-fetches for files added after load
        if ((data.incompleteReason === 'permanently_unavailable' || data.incompleteReason === MULTI_SHOW_NOT_FOUND_REASON) && CONFIG.incompleteReasonFilter.length === 0) {
          logExclusion({ script: 'collect-review-texts', showId, file, reason: data.incompleteReason === MULTI_SHOW_NOT_FOUND_REASON ? 'skippedMultiShowSectionNotFound' : 'skippedPermanentlyUnavailable', details: { url: data.url, outletId: data.outletId } });
          continue;
        }

        // Skip misattributed/wrong reviews (unless explicitly targeting wrong_content)
        // EXCEPTION: if a human reviewed and verified the production (humanReviewedWrongProduction:false)
        // or set humanReviewScore, the wrongProduction flag is a false-positive — allow re-fetch.
        const isHumanVerified = data.humanReviewedWrongProduction === false
          || data.humanReviewScore != null;
        const isWrongContent = (data.wrongAttribution || data.wrongProduction || data.wrongShow)
          && !isHumanVerified;
        // A URL-corrected review must be refetched immediately: its wrongShow /
        // stale-text flags describe the content of the OLD url, not the corrected
        // one. `needsRefetch` is set by the URL-correction paths
        // (review-normalization.js, gather-reviews.js, retry-wrong-urls.js) but was
        // read by nothing here — so a corrected review (e.g. the NYT Helen Shaw
        // review whose url was upgraded from the preview) sat behind the 14-day
        // wrongShow cooldown, unfetched, with the preview author's byline frozen in
        // (girl-interrupted 2026-06-05). When set, bypass the wrong-content cooldown
        // AND the "already has good text" short-circuit below.
        const urlCorrectedRefetch = isUrlCorrectedRefetch(data);
        // Set before the gate so the wrong_content-filtered pass also fetches a
        // dateless-revival hold's stored url instead of SERP-rediscovering it.
        if (shouldRetryDatelessHoldFetch(data)) data._datelessDateRetry = true;
        if (isWrongContent && !CONFIG.incompleteReasonFilter.includes('wrong_content')) {
          // Allow retry for collector-flagged wrongShow files (bad scrape of correct URL)
          // These have wrongShowReason starting with "Collector LLM" — distinguishes from
          // cross-show collisions ("Cross-show") and scorer flags (no wrongShowReason)
          const isCollectorFlagged = data.wrongShow && typeof data.wrongShowReason === 'string'
            && data.wrongShowReason.startsWith('Collector LLM');
          const retryAge = data.wrongShowRetryAt ? Date.now() - new Date(data.wrongShowRetryAt).getTime() : Infinity;
          // Consent-backlog auto-drain: a flagged review whose stored text is
          // garbage (empty capture / consent-wall) was flagged on content the
          // consent-dismissing scraper can now recover. Re-fetch it (cooldown-
          // gated). Safe because isGarbageContent has 0% FP — a flag on a review
          // with real buried text (isGarbage=false) is NOT matched. 2026-06-28.
          // Cooldown reuses the EXISTING wrongShowRetryAt field: the post-fetch
          // block (search _wrongShowRetrying) stamps it when a retry still fails,
          // so the same 14-day clock that gates collector-flagged retries gates
          // these. A separate field didn't survive the fetch path's rewrite
          // (verified 2026-06-28 — consentRefetchAt was dropped, re-fetch looped).
          // A stored text that OPENS with a strippable IAB consent layer counts
          // too (BRO-4185 A): the article sits after the block, but the verifier
          // read only the consent text and flagged the review. Quarantined text
          // (fullText nulled into wrongFullText) is checked the same way.
          const storedTextIsGarbage = storedTextNeedsConsentRefetch(data);
          let garbageRetryAllowed = shouldRetryGarbageConsentWall({
            hasGarbageStoredText: storedTextIsGarbage,
            lastRetryMs: data.wrongShowRetryAt ? new Date(data.wrongShowRetryAt).getTime() : null,
            nowMs: Date.now(),
          });
          const storedSalvageable = !!salvageConsentPrefixedStoredText(data);
          if (storedSalvageable) {
            // No fetch involved: the network cooldown does not apply, and the
            // once-per-stored-text stamp (consentSalvageVerifiedHash) stops repeats.
            garbageRetryAllowed = true;
          } else if (garbageRetryAllowed) {
            data._networkDrain = true;
          }
          // 14-day cooldown for collector-flagged retries; a URL correction is a
          // strong signal the next fetch will succeed, so it bypasses the cooldown.
          // BRO-4430: a dateless-revival hold only lifts when a publish date
          // arrives, and the url is not in doubt, so fetch the stored url for
          // its date (14-day cooldown on the same wrongShowRetryAt clock).
          // Before this the hold was reachable only through the wrong_content
          // SERP rediscovery, and once that abandoned the review stayed held
          // forever (An American Daughter, NY Sun).
          const datelessHoldRetry = data._datelessDateRetry === true;
          const retryAllowed = (isCollectorFlagged && retryAge > 14 * 24 * 60 * 60 * 1000)
            || urlCorrectedRefetch || garbageRetryAllowed || datelessHoldRetry;
          if (!retryAllowed) {
            logExclusion({ script: 'collect-review-texts', showId, file, reason: 'skippedWrongContent', details: { url: data.url, outletId: data.outletId, wrongShow: data.wrongShow, wrongProduction: data.wrongProduction } });
            continue;
          }
          // Mark retry attempt — the post-fetch handler stamps wrongShowRetryAt
          // (success clears the flag; failure starts the 14-day cooldown).
          data._wrongShowRetrying = true;
          // Either field: a clean refilled fullText can sit beside the
          // consent-captured wrongFullText the flag was set on.
          if (hasStrippableConsentLayer(data.fullText || '') || hasStrippableConsentLayer(data.wrongFullText || '')) data._consentLayerRetry = true;
        }

        // Skip if already has good text (unless retrying failed or filtering by reason)
        // When filtering by incompleteReason, trust the reason field instead of re-checking text length
        // (important: wrong_content reviews may have long text from the *wrong* page)
        // force: entries skip the has-good-text checks below: the stored text
        // is known to come from the wrong page (BRO-5090).
        const forcedRefetch = isForcedRefetch(CONFIG.reviewFilter, showId, file);
        if (forcedRefetch) console.log(`  ↻ ${file}: forced refetch (REVIEW_FILTER force:)`);
        if (CONFIG.incompleteReasonFilter.length === 0 && !forcedRefetch) {
          const textLen = data.fullText ? data.fullText.length : 0;
          // BRO-4334: inside the opening window, a hard-paywall text labelled
          // 'complete' that fails the completeness assessment (e.g. page one of
          // an NYT review) is re-fetched like a truncated one.
          const paywallRecheck = needsPaywallRecheck(data);
          if (paywallRecheck) {
            console.log(`  ↻ ${file}: stored hard-paywall text looks partial — re-fetching`);
            data._paywallRecheck = true;
          }
          const isTruncated = data.textQuality === 'truncated' || data.textStatus === 'truncated'
            || data.contentTier === 'truncated' || data.contentTier === 'needs-rescrape' || paywallRecheck;
          // Re-process showNotMentioned reviews for URL discovery (even if they have long text)
          const needsUrlDiscovery = data.showNotMentioned === true && !data._showNotMentionedDiscoveryAttempted;
          // Re-collect if existing fullText is garbage (cookie consent, GDPR banners, etc.)
          let hasGarbageText = textLen > 0 && (isGarbageContent(data.fullText).isGarbage || isSoft404Body(data.fullText));
          if (!hasGarbageText && textLen > 0 && hasStrippableConsentLayer(data.fullText)) {
            // Consent-prefixed text: free when the stored article can be
            // re-verified, otherwise a capped network refetch.
            hasGarbageText = true;
            if (!salvageConsentPrefixedStoredText(data)) data._networkDrain = true;
          }
          if (hasStrippableConsentLayer(data.fullText || '') || hasStrippableConsentLayer(data.wrongFullText || '')) data._consentLayerRetry = true;
          // BRO-5166: a truncated page the ensemble just rejected (a listing page
          // with no review yet) waits out the hold instead of being refetched
          // every run; other refetch triggers still apply.
          if (isTruncated && !paywallRecheck && !needsUrlDiscovery && !hasGarbageText && !urlCorrectedRefetch
              && !data._datelessDateRetry && isRejectedRefetchOnHold(data)) {
            continue;
          }
          // Always re-try truncated/needs-rescrape reviews - they have text but it's incomplete or garbage
          if (!isTruncated && !needsUrlDiscovery && !hasGarbageText && !urlCorrectedRefetch && !data._datelessDateRetry && (data.isFullReview === true || data.textQuality === 'full' || textLen > 1500) && !failedFetches.has(reviewId)) {
            continue;
          }
          // Skip complete reviews even if they appear in failedFetches — the failure entry is stale
          // from URL discovery before a different source (Theatre Record, WET, etc.) provided full text.
          // Prevents wasted Browserbase sessions on reviews that don't need re-collection.
          // Guard: never re-fetch a review that has an assigned score + reasonable text, even if it
          // appears in failedFetches. Re-collection can destroy live scored reviews by fetching garbage
          // and triggering LLM rejection flags that null fullText and delete assignedScore.
          // Override: explicit reviewFilter (specific file targeting) bypasses this guard.
          // Override: truncated reviews always need re-collection (scored on partial text is wrong).
          // BRO-5231: neither skip applies to a URL-corrected review, its complete-looking
          // text and score belong to the OLD url (decision lives in lib/url-corrected-refetch.js).
          if (mayShortCircuitCollected(data, {
            isTruncated,
            hasGarbageText,
            datelessDateRetry: !!data._datelessDateRetry,
            completeSkip: data.contentTier === 'complete' || data.textQuality === 'full',
            scoredSkip: shouldSkipScoredReview(data, CONFIG.reviewFilter.size),
          })) {
            continue;
          }
        }

        // Lifecycle-tiered fetch retry gate (BRO-787): once a review has a
        // failed-fetches.json entry, don't keep burning Browserbase/BD/SB
        // spend retrying it forever — closed-old shows with a confirmed-dead
        // URL get 0 further retries, and every other lifecycle gets a
        // cooldown between attempts. Runs AFTER the has-good-text checks
        // above (a stale ledger entry on an already-complete review must not
        // be gated — those checks already let it through) and bypasses on
        // urlCorrectedRefetch, same as the wrongContent cooldown above: a
        // corrected URL is a strong signal the next fetch will succeed, and
        // the OLD url's failure history says nothing about the NEW one.
        const fetchFailureEntry = failedFetchesByReviewId.get(reviewId);
        // A content mismatch judged by an older version of the content check
        // gets one fresh fetch under the current rule (BRO-4185 H).
        // Capped per run; the once-per-version stamp is written when the
        // review is actually processed (processReview), so a reopen that
        // falls past this run's review limit keeps its attempt.
        const reopenStaleMismatch = shouldReopenStaleContentMismatch(fetchFailureEntry, data, URL_CONTENT_CHECK_VERSION);
        // A stored-text re-verify fetches nothing, so the fetch-retry
        // lifecycle (abandonment/cooldown) does not apply to it.
        const storedTextOnly = data._consentLayerRetry === true && !!salvageConsentPrefixedStoredText(data);
        // The ledger entry may describe a URL the review no longer carries (BRO-3319).
        const ledgerForOtherUrl = isFetchLedgerEntryForOtherUrl(fetchFailureEntry, data);
        if (fetchFailureEntry && !bypassesFetchFailureGate(data) && !reopenStaleMismatch && !storedTextOnly && !ledgerForOtherUrl) {
          let fetchGate = shouldRetryFetch(showsById.get(showId) || null, data, fetchFailureEntry);
          // A route capped today is capped until the UTC reset (BRO-5222).
          if (fetchGate.shouldRetry && isRouteCapCooldownActive(fetchFailureEntry)) {
            fetchGate = { shouldRetry: false, reason: 'route_cap_cooldown', nextAttemptAt: null };
          }
          const gateBypassed = shouldBypassFetchGate({
            reviewTargeted: CONFIG.reviewFilter.size > 0,
            showFilterActive: isShowFilterActive(CONFIG.showFilterSet, CONFIG.showFilter),
            show: showsById.get(showId) || null,
          });
          if (!fetchGate.shouldRetry && !gateBypassed) {
            logExclusion({
              script: 'collect-review-texts',
              showId,
              file,
              reason: fetchGate.reason === 'abandoned' || fetchGate.reason === 'max_retries_reached'
                ? 'skippedFetchAbandoned' : 'skippedFetchCooldown',
              details: {
                url: data.url,
                failureReason: fetchFailureEntry.failureReason,
                failureCount: fetchFailureEntry.failureCount,
                nextAttemptAt: fetchGate.nextAttemptAt,
              },
            });
            if (fetchGate.updates) {
              try {
                Object.assign(data, fetchGate.updates);
                persistReviewSnapshot({ filePath: filePath, data: data, trailingNewline: true });
              } catch (e) {}
            }
            continue;
          }
        }

        // Skip if no URL (unless explicitly targeting no_url reviews for SERP discovery)
        if (!data.url && !CONFIG.incompleteReasonFilter.includes('no_url')) {
          logExclusion({ script: 'collect-review-texts', showId, file, reason: 'skippedNoUrl', details: { outletId: data.outletId, criticName: data.criticName } });
          continue;
        }

        // Skip print-only outlets — no online content exists, SERP discovery wastes API credits
        if (UNCOLLECTABLE_OUTLETS.has((data.outletId || '').toLowerCase())) {
          logExclusion({ script: 'collect-review-texts', showId, file, reason: 'skippedUncollectableOutlet', details: { url: data.url, outletId: data.outletId } });
          continue;
        }

        // Determine outlet tier
        const outletId = (data.outletId || '').toLowerCase();
        const isTier1 = CONFIG.tier1Outlets.some(t => outletId.includes(t));
        const isTier2 = CONFIG.tier2Outlets.some(t => outletId.includes(t));
        const isTier3 = CONFIG.tier3Outlets.some(t => outletId.includes(t));

        // Determine tier number (1, 2, 3, or 4 for unknown)
        let tierNum = 4; // Default to unknown tier
        if (isTier1) tierNum = 1;
        else if (isTier2) tierNum = 2;
        else if (isTier3) tierNum = 3;

        // Apply priority filter
        if (CONFIG.priority === 'tier1' && !isTier1) continue;

        // Apply outlet tier filter (for parallel matrix strategy)
        if (CONFIG.outletTier) {
          if (CONFIG.outletTier === 'tier1' && tierNum !== 1) continue;
          if (CONFIG.outletTier === 'tier2' && tierNum !== 2) continue;
          if (CONFIG.outletTier === 'tier3' && (tierNum !== 3 && tierNum !== 4)) continue;
        }

        // Apply content tier filter (for targeted runs: excerpt, truncated, needs-rescrape)
        if (CONFIG.contentTierFilter) {
          const ct = data.contentTier || '';
          if (CONFIG.contentTierFilter === 'excerpt' && ct !== 'excerpt') continue;
          if (CONFIG.contentTierFilter === 'truncated' && ct !== 'truncated') continue;
          if (CONFIG.contentTierFilter === 'needs-rescrape' && ct !== 'needs-rescrape') continue;
        }

        // Apply domain filter (for targeted soft-paywall collection runs)
        if (CONFIG.domainFilter.length > 0 && data.url) {
          try {
            const urlDomain = new URL(data.url).hostname.replace(/^www\./, '');
            if (!CONFIG.domainFilter.some(d => urlDomain === d || urlDomain.endsWith('.' + d))) continue;
          } catch (e) {
            continue; // Skip reviews with unparseable URLs when domain filter is active
          }
        }

        // Apply domain exclusion filter (for free-outlet collection — exclude paywall domains)
        if (CONFIG.excludeDomains.length > 0 && data.url) {
          try {
            const urlDomain = new URL(data.url).hostname.replace(/^www\./, '');
            if (CONFIG.excludeDomains.some(d => urlDomain === d || urlDomain.endsWith('.' + d))) continue;
          } catch (e) {
            // Keep reviews with unparseable URLs when using exclusion mode
          }
        }

        // Apply incompleteReason filter
        if (CONFIG.incompleteReasonFilter.length > 0) {
          const reason = data.incompleteReason || '';
          if (!CONFIG.incompleteReasonFilter.includes(reason)) continue;
        }

        // Parse publish date for archive-first logic
        let publishDate = null;
        if (data.publishDate) {
          publishDate = parseDate(data.publishDate);
        }

        // Count previous fetch attempts (from file + failed-fetches.json)
        const fileAttempts = Array.isArray(data.fetchAttempts) ? data.fetchAttempts.length : 0;

        reviews.push({
          reviewId,
          filePath,
          showId,
          file,
          outlet: data.outlet,
          outletId: data.outletId,
          critic: data.criticName,
          url: data.url,
          isTier1,
          tierNum,
          priority: tierNum,
          publishDate,
          showNotMentioned: data.showNotMentioned || false,
          isOpenShow: openShowIds.has(showId),
          recencyDate: showOpeningDates.get(showId) || NO_DATE_SENTINEL,
          incompleteReason: data.incompleteReason || null,
          fabricatedEntry: data.fabricatedEntry || false,
          fetchAttempts: fileAttempts,
          wrongShow: data.wrongShow || false,
          wrongShowReason: data.wrongShowReason || null,
          // Retry markers set by the gates above. They were never copied onto
          // the queued review, so the post-fetch outcome handler (clear on
          // success, cooldown stamp on failure) only ran for the SERP path.
          _wrongShowRetrying: data._wrongShowRetrying === true,
          _consentLayerRetry: data._consentLayerRetry === true,
          _mismatchReopen: reopenStaleMismatch,
          _networkDrain: data._networkDrain === true,
          _storedSalvage: data._consentLayerRetry === true && !!salvageConsentPrefixedStoredText(data),
          _paywallRecheck: data._paywallRecheck === true,
          _datelessDateRetry: data._datelessDateRetry === true,
          _forceRefetch: forcedRefetch,
          // What the file already holds (BRO-5222): a Time Out refetch that
          // finds a listing blurb keeps a stored review instead of failing it.
          _needsRefetch: isNeedsRefetchDrainCandidate(data, failedFetchesByReviewId.get(reviewId)),
          // BRO-6123: aged never-attempted stub, drained from a reserved slice.
          _agedStub: isAgedNeverAttemptedStub(data),
          _storedTier: data.contentTier || null,
          _storedTextLength: typeof data.fullText === 'string' ? data.fullText.length : 0,
          // Stored text that may not be this url's review (repointed url, show
          // never named) must not be kept over a refetch (BRO-5261). Not
          // wrongFullText: that holds an old quarantined text, not this one.
          _storedTextSuspect: data.needsRefetch === true || isUrlCorrectedRefetch(data) || !!data.showNotMentioned,
        });
      } catch (e) {
        console.error(`Error reading ${filePath}: ${e.message}`);
      }
    }
  }

  // Sort: open/preview shows first (unless CLOSED_SHOW_MODE),
  // then newest shows first (by recencyDate desc),
  // then never-attempted before previously-attempted,
  // then by outlet tier priority
  const closedShowMode = process.env.CLOSED_SHOW_MODE === 'true';
  reviews.sort((a, b) => compareReviewPriority(a, b, { closedShowMode }));
  // BRO-6648 S1-T2: the opening-night lane writes the shows it holds. Drop them before the reserved
  // slices and per-run caps below, so a held review never takes a slot.
  {
    const kept = dropLeasedReviews(reviews);
    reviews.length = 0;
    reviews.push(...kept);
  }
  // BRO-6123: closed-show stubs with a URL and zero attempts ranked behind the
  // whole open-show backlog and never reached the cut. Reserve a capped slice.
  // Applied BEFORE the salvage and needsRefetch promotions so those stay ahead.
  {
    const promoted = promoteAgedStubs(reviews);
    const n = promoted.filter(r => r._agedStub).slice(0, AGED_STUB_DRAIN_PER_RUN).length;
    if (n) console.log(`  aged-stub drain: ${n} never-attempted stub(s) queued first (cap ${AGED_STUB_DRAIN_PER_RUN}/run)`);
    reviews.length = 0;
    reviews.push(...promoted);
  }
  // Stored-text re-verifies (consent-prefixed captures, BRO-4185 A) need no
  // fetch, only one verification call, so they go first: ranked by show
  // recency they sat past the 300-review cut on older shows run after run.
  {
    const salvage = reviews.filter(r => r._storedSalvage);
    if (salvage.length) {
      const rest = reviews.filter(r => !r._storedSalvage);
      reviews.length = 0;
      reviews.push(...salvage, ...rest);
      console.log(`  Stored-text re-verifies queued first: ${salvage.length}`);
    }
  }
  // BRO-4426: textless needsRefetch reviews ranked by their show's recency and
  // sat past the max_reviews cut forever. Reserve a capped slice at the front.
  {
    const promoted = promoteNeedsRefetch(reviews);
    const n = promoted.filter(r => r._needsRefetch).slice(0, NEEDS_REFETCH_DRAIN_PER_RUN).length;
    if (n) console.log(`  needsRefetch drain: ${n} textless review(s) queued first (cap ${NEEDS_REFETCH_DRAIN_PER_RUN}/run)`);
    reviews.length = 0;
    reviews.push(...promoted);
  }
  // Per-run caps, applied in priority order (see DRAIN_NETWORK_PER_RUN).
  {
    let drain = 0, reopen = 0, dropped = 0;
    const kept = reviews.filter(r => {
      if (r._networkDrain && ++drain > DRAIN_NETWORK_PER_RUN) { dropped++; return false; }
      if (r._mismatchReopen && ++reopen > MISMATCH_REOPEN_PER_RUN) { dropped++; return false; }
      return true;
    });
    if (dropped) console.log(`  Deferred ${dropped} network retries past this run's caps (drain ${DRAIN_NETWORK_PER_RUN}, reopen ${MISMATCH_REOPEN_PER_RUN})`);
    reviews.length = 0;
    reviews.push(...kept);
  }


  // Log sort stats
  const neverAttempted = reviews.filter(r => r.fetchAttempts === 0).length;
  const previouslyAttempted = reviews.length - neverAttempted;
  console.log(`  Queue: ${reviews.length} reviews (${neverAttempted} never attempted, ${previouslyAttempted} previously attempted)`);

  // Apply max limit
  if (CONFIG.maxReviews > 0) {
    return reviews.slice(0, CONFIG.maxReviews);
  }

  return reviews;
}

// ============================================================================
// BROWSER SETUP
// ============================================================================

async function setupBrowser() {
  if (collectorShuttingDown) {
    throw new Error('collector is shutting down — not launching a new browser');
  }
  console.log('\nLaunching browser with stealth...');
  const myGeneration = ++browserGeneration;

  const newBrowser = await chromium.launch({
    headless: true,
    ...require('./lib/playwright-exe').launchExtras(chromium),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  const newContext = await newBrowser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    geolocation: { latitude: 40.7128, longitude: -74.0060 },
    permissions: ['geolocation'],
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    },
  });

  // Enhanced stealth scripts (even with playwright-extra)
  await newContext.addInitScript(() => {
    // Override webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Override plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ],
    });

    // Override languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

    // Override platform
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });

    // Override hardware concurrency
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });

    // Override device memory
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

    // Override maxTouchPoints
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });

    // Chrome runtime
    window.chrome = {
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
      app: {},
    };

    // Permissions query
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );

    // WebGL vendor/renderer
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.apply(this, arguments);
    };
  });

  // Inject cookies for paywalled domains (bypasses login entirely)
  for (const domain of Object.keys(COOKIE_DOMAIN_MAP)) {
    const injected = await injectCookies(newContext, domain);
    if (injected) {
      cookieInjectedDomains.add(domain);
      loggedInDomains.add(domain); // Mark as "logged in" so loginToSite() is skipped
    }
  }

  const newPage = await newContext.newPage();

  if (myGeneration !== browserGeneration) {
    // A newer restart (closeBrowser()/another setupBrowser()) superseded this
    // one while we were launching — this instance is stale. Tear it down
    // instead of clobbering the globals a later restart already set.
    console.log('  ⚠ Stale browser launch superseded by a newer restart — discarding');
    try { await newBrowser.close(); } catch (_) {}
    return;
  }

  browser = newBrowser;
  context = newContext;
  page = newPage;
  console.log('✓ Browser ready');
}

async function closeBrowser() {
  browserGeneration++; // Invalidate any setupBrowser() still launching in the background.
  const toClose = browser;
  browser = null;
  context = null;
  page = null;
  if (toClose) {
    try {
      await toClose.close();
    } catch (e) {
      // Browser may already be closed
    }
  }
}

/**
 * Check if browser is healthy, restart if crashed
 */
async function ensureBrowserHealthy() {
  try {
    // Quick health check - try to get browser contexts
    if (!browser || !context || !page) {
      throw new Error('Browser not initialized');
    }
    // Try a simple operation to verify browser is responsive
    await page.evaluate(() => true).catch(() => {
      throw new Error('Page not responsive');
    });
    return true;
  } catch (e) {
    console.log(`  ⚠ Browser unhealthy: ${e.message}`);
    browserCrashCount++;

    if (browserCrashCount > MAX_BROWSER_CRASHES) {
      console.log(`  ✗ Too many browser crashes (${browserCrashCount}), skipping Playwright tier`);
      return false;
    }

    console.log(`  → Restarting browser (crash #${browserCrashCount})...`);
    // Bounded — same hang class as the REVIEW_TIMEOUT recovery path (see
    // comment there); this is the higher-traffic sibling, hit by every
    // Tier-1 Playwright call via fetchWithPlaywright().
    try { await withTimeout(closeBrowser(), 30000, 'closeBrowser'); } catch (_) {}
    await sleep(2000); // Brief pause before restart

    try {
      await withTimeout(setupBrowser(), 60000, 'setupBrowser');
      console.log(`  ✓ Browser restarted successfully`);
      return true;
    } catch (restartError) {
      console.log(`  ✗ Browser restart failed: ${restartError.message}`);
      return false;
    }
  }
}

// ============================================================================
// PERMANENT FAILURE TRACKING
// ============================================================================

/**
 * Record a fetch failure to failed-fetches.json with failure count tracking.
 * Increments failureCount on each call. After 3+ failures, the review will
 * be skipped on future runs (permanent failure).
 */
function recordFailedFetch(review, reason, details = {}) {
  const failedFetchesPath = path.join(CONFIG.reviewTextsDir, 'failed-fetches.json');
  let failedFetches = [];
  if (fs.existsSync(failedFetchesPath)) {
    try {
      failedFetches = JSON.parse(fs.readFileSync(failedFetchesPath, 'utf8'));
    } catch (e) {
      failedFetches = [];
    }
  }

  // Find existing entry for this review
  const existingIdx = failedFetches.findIndex(f => f.reviewId === review.reviewId);
  const existing = existingIdx >= 0 ? failedFetches[existingIdx] : null;
  const prevCount = existing?.failureCount || 0;

  // budget_capped does NOT increment failureCount (S2-T5). We chose not to pay
  // for this fetch; that is not evidence the URL is dead, and four capped
  // attempts plus one transient failure would otherwise retire it permanently.
  // Excluded at the COUNTER, not merely at the read threshold — a write-time
  // increment is damage a read-time filter can no longer undo once the reason
  // field is overwritten by the next, genuine failure.
  // A capped-route deferral is allowed MAX_ROUTE_CAPPED_DEFERRALS times, then
  // recorded as an ordinary failure so a row can't defer forever (BRO-5222).
  const capped = applyRouteCapDeferralLimit(reason, existing);
  reason = capped.reason;
  const counts = shouldCountFailure(reason);
  const entry = {
    reviewId: review.reviewId,
    showId: review.showId,
    outlet: review.outlet,
    critic: review.critic,
    url: review.url,
    failureReason: reason,
    ...(reason === 'url_content_mismatch' ? { checkVersion: URL_CONTENT_CHECK_VERSION } : {}),
    failureCount: counts ? prevCount + 1 : prevCount,
    lastFailedAt: new Date().toISOString(),
    firstFailedAt: existing?.firstFailedAt || new Date().toISOString(),
    ...(counts || reason === 'soft_404' ? {} : { lastCappedAt: new Date().toISOString() }),
    ...(capped.cappedDeferrals ? { cappedDeferrals: capped.cappedDeferrals } : {}),
    ...(capped.codeErrorDeferrals ? { codeErrorDeferrals: capped.codeErrorDeferrals } : {}),
    ...details,
  };

  if (existingIdx >= 0) {
    failedFetches[existingIdx] = entry;
  } else {
    failedFetches.push(entry);
  }

  // Remove any duplicate entries for this reviewId (cleanup for historical bug)
  const finalIdx = failedFetches.findIndex(f => f.reviewId === review.reviewId);
  failedFetches = failedFetches.filter((f, i) => f.reviewId !== review.reviewId || i === finalIdx);

  try {
    fs.writeFileSync(failedFetchesPath, JSON.stringify(failedFetches, null, 2));
  } catch (e) {
    // Non-fatal — don't crash the run over tracking
  }

  // Set incompleteReason on the review source file, and advance the
  // lifecycle-tiered fetch retry gate state (fetchRetryAfter /
  // fetchDiscoveryAbandoned — BRO-787). Both live on the same file, so one
  // read+write covers them.
  // The on-disk file is read first so recordFetchAttempt sees its
  // fetchPrePubFailures counter (BRO-4281), not a possibly stale in-memory copy.
  const reviewFilePath = path.join(CONFIG.reviewTextsDir, review.reviewId);
  let reviewData = null;
  try {
    if (fs.existsSync(reviewFilePath)) reviewData = readReviewForUpdate(reviewFilePath);
  } catch (e) {
    reviewData = null;
  }
  let fetchAttemptUpdates = {};
  if (counts || reason === 'soft_404') {
    try {
      if (!_showsJsonCache) _showsJsonCache = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
      const showMeta = _showsJsonCache.shows.find(s => s.id === review.showId) || null;
      fetchAttemptUpdates = recordFetchAttempt(showMeta, reviewData || review, entry);
    } catch (e) {
      // Non-fatal — worst case, no cooldown/abandonment is stamped this run
    }
  }
  try {
    if (reviewData) {
      const reasonResult = classifyIncompleteReason(reviewData, entry);
      if (reasonResult) {
        reviewData.incompleteReason = reasonResult.incompleteReason;
        reviewData.incompleteDetail = reasonResult.incompleteDetail;
      }
      if (Object.keys(fetchAttemptUpdates).length > 0) {
        Object.assign(reviewData, fetchAttemptUpdates);
      }
      if (reasonResult || Object.keys(fetchAttemptUpdates).length > 0) {
        persistReviewSnapshot({ filePath: reviewFilePath, data: reviewData, trailingNewline: true });
      }
    }
  } catch (e) {
    // Non-fatal
  }

  if (fetchAttemptUpdates.fetchPrePubFailures) {
    console.log(`    ⏳ Pre-publication fetch failure — cooldown until ${fetchAttemptUpdates.fetchRetryAfter} (capped at the publication moment; ${entry.failureCount} attempts, reason: ${reason})`);
  } else if (fetchAttemptUpdates.fetchDiscoveryAbandoned || (!fetchAttemptUpdates.fetchRetryAfter && isPermanentlyFailed(entry))) {
    // fetchRetryAfter present = recordFetchAttempt decided NOT to abandon
    // (e.g. pre-publication failures don't count, BRO-4281), so the raw
    // ledger count alone must not claim "permanently failed".
    console.log(`    ⚠ Permanently failed (${entry.failureCount} attempts, reason: ${reason}) — will skip on future runs`);
  } else if (!counts && reason !== 'soft_404') {
    console.log(reason === 'code_error'
      ? `    ⏸ Recorded as code_error (our own exception, deferral ${entry.codeErrorDeferrals}; failureCount held at ${entry.failureCount}) — fix the code, the row is retried`
      : `    ⏸ Recorded as ${reason} (failureCount held at ${entry.failureCount}) — retried normally once the cap lifts`);
  } else if (fetchAttemptUpdates.fetchRetryAfter) {
    console.log(`    ⏳ Fetch cooldown until ${fetchAttemptUpdates.fetchRetryAfter} (${entry.failureCount} attempts, reason: ${reason})`);
  }
}

/**
 * Remove a review from failed-fetches.json when it succeeds.
 */
function clearFailedFetch(reviewId) {
  const failedFetchesPath = path.join(CONFIG.reviewTextsDir, 'failed-fetches.json');
  if (!fs.existsSync(failedFetchesPath)) return;
  try {
    const failedFetches = JSON.parse(fs.readFileSync(failedFetchesPath, 'utf8'));
    const filtered = failedFetches.filter(f => f.reviewId !== reviewId);
    if (filtered.length < failedFetches.length) {
      fs.writeFileSync(failedFetchesPath, JSON.stringify(filtered, null, 2));
    }
  } catch (e) {
    // Non-fatal
  }
}

// ============================================================================
// PROCESS REVIEW
// ============================================================================


// Once-per-stored-text stamp for consent-layer re-verifies (BRO-4185 A).
function stampSalvage(review) {
  if (!review || !review.filePath) return;
  try {
    const d = readReviewForUpdate(review.filePath);
    d.consentSalvageVerifiedHash = salvageSourceHash(d);
    d.consentSalvageVerifiedAt = new Date().toISOString();
    persistReviewSnapshot({ filePath: review.filePath, data: d, trailingNewline: true });
  } catch (e) {}
}

// BRO-4430: cooldown stamp for a dateless-revival hold's stored-url fetch
// (read by review-slot-guards shouldRetryDatelessHoldFetch).
function stampDatelessRetry(filePath) {
  try {
    const d = readReviewForUpdate(filePath);
    d.wrongShowRetryAt = new Date().toISOString();
    persistReviewSnapshot({ filePath: filePath, data: d, trailingNewline: true });
  } catch (e) { /* non-fatal: next run re-evaluates */ }
}

/**
 * Run the content verifier (LLM, heuristic fallback) on a fetched page for
 * this review. Shared by the main fetch path and the discovered-url retry
 * (BRO-5183: the retry used to store a searched-up page with no verification
 * at all, so a 2018 touring review landed on the 2015 Broadway show).
 * Returns null when the text is under 200 words or the verifier threw.
 */
async function verifyFetchedContent(review, result, validation, { discoveredUrl = null } = {}) {
  let contentVerification = null;
  if (validation.wordCount >= 200) {
    console.log(`  LLM Verification...`);
    try {
      // Get excerpt and show metadata from existing review data
      const reviewData = JSON.parse(fs.readFileSync(review.filePath, 'utf8'));
      const excerpt = verifierExcerpt(reviewData);
      const showId = reviewData.showId || review.showId || '';

      // Look up show metadata for richer context
      let showMeta = null;
      try {
        if (!_showsJsonCache) _showsJsonCache = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
        showMeta = _showsJsonCache.shows.find(s => s.id === showId);
      } catch (e) { /* shows.json unavailable */ }

      // The body as stored (junk/chrome stripped, multi-show section isolated
      // with the same url and title the save path uses), not the raw fetch: a
      // verdict on text we then strip described a different body (BRO-5243).
      const stored = storedTextForm(result.text, { url: discoveredUrl || reviewData.url || review.url, showTitle: showMeta ? showMeta.title : '' });
      // A multi-show post with no section for this show is refused by the save
      // path; verifying it would be a wasted LLM call (BRO-5261).
      if (stored.refused) {
        console.log('  LLM Verification skipped: multi-show post has no unique section for this show');
        return null;
      }
      contentVerification = await verifyContent({
        scrapedText: stored.text || result.text,
        excerpt: excerpt,
        showTitle: showMeta?.title || showId.replace(/-\d{4}$/, '').replace(/-/g, ' '),
        outletName: review.outlet,
        criticName: review.critic,
        openingDate: showMeta?.openingDate || null,
        venue: showMeta?.venue || null,
        // Opera shows (type='opera') get the 'opera' market, and shows at known
        // prestige/arena venues (Radio City, Park Ave Armory, Carnegie Hall, NYU
        // Skirball, NYC Center) get 'special-venue' — both tell the LLM the named
        // venue IS canonical instead of flagging wrong PRODUCTION/VENUE on every
        // mention. See resolveCvMarket() in lib/content-verifier.js.
        market: resolveCvMarket(showMeta),
        // Long-runners (Mousetrap 1952, Phantom WE 1986, etc.) get a prompt
        // adjustment that tells the LLM not to flag wrongProduction based on
        // publishDate-vs-openingDate age gap alone. See scripts/lib/long-runner-registry.js
        // and WE long-runner CV hardening card issue #3.
        isLongRunningProduction: showMeta ? _isLongRunner(showMeta) : false,
        // Pass publishDate so applyTemporalOverrides can downgrade wrongProduction
        // confidence on opening-week reviews (DoaS Apr 9-10 postmortem #9: missing
        // publishDate caused legitimate revival reviews to have their text nulled).
        // Falls back to textFetchedAt, then today, only for a current show (lib/verification-publish-date.js).
        // On opening night, fresh stubs have publishDate=null and textFetchedAt=null —
        // without this fallback, temporal override never fires and the LLM's high-confidence
        // wrongProduction FP (44% rate; Proof 2026-04-17) stamps the file immediately.
        // BRO-4884: read the page's own date first (it used to be extracted
        // only at save, after this call) and drop the today fallback for a
        // long-closed show, whose reviews were otherwise "written in 2026".
        publishDate: verificationPublishDate({
          // A discovered page is judged on its own date and url, never the old
          // row's (a stored 2015 date made a 2018 tour review look like an
          // opening-week review, BRO-5183).
          storedDate: discoveredUrl ? null : reviewData.publishDate,
          derivedDate: extractPublishDateFromHtml(result.html, discoveredUrl || reviewData.url)
            || (() => { const pageUrl = discoveredUrl || reviewData.url; const u = pageUrl ? extractDateFromUrlCanonical(pageUrl) : null; return u && /^\d{4}-\d{2}-\d{2}$/.test(u.date || '') ? u.date : null; })()
            || (result.text && result.text.length > 100 ? extractDateFromText(result.text) : null),
          textFetchedAt: discoveredUrl ? null : reviewData.textFetchedAt,
          show: showMeta,
          today: new Date().toISOString().slice(0, 10),
        }),
        // URL passed in so verifyContent can surface URL-year-vs-publishDate
        // conflicts to the LLM (issue #4, Mamma Mia WE 2021 case). Not used to
        // override — the LLM decides with both dates in hand. See CLAUDE.md rule 3.
        url: discoveredUrl || reviewData.url || null,
        // BRO-989: foreign-roundup bypass of the temporal override.
        bwwRoundupUrl: reviewData.bwwRoundupUrl || null,
        otherShowTitles: (_showsJsonCache?.shows || []).filter(s => s.id !== showId && s.title && s.title.length >= 6).map(s => s.title),
        // Show metadata passed in so applyTemporalOverrides can run the named-entity
        // bypass (Hamlet 2026-05-08 FRC class): if CV reasoning names a "directed by X"
        // that doesn't match show.creativeTeam directors AND the actual director
        // isn't mentioned ≥2x in scrapedText, keep wrongProduction at full confidence.
        show: showMeta || null,
      });

      const verifier = contentVerification.verifiedBy?.startsWith('llm:') ? `LLM (${contentVerification.verifiedBy.split(':')[1]})` : 'Heuristic';
      console.log(`  ${verifier} Verify: ${contentVerification.isValid ? 'VALID' : 'REJECTED'} (${contentVerification.confidence} confidence)`);
      if (contentVerification.issues.length > 0) {
        console.log(`  Issues: ${contentVerification.issues.join(', ')}`);
      }
      if (contentVerification.reasoning) {
        console.log(`  Reasoning: ${contentVerification.reasoning}`);
      }
    } catch (e) {
      console.log(`  LLM Verify error: ${e.message}`);
    }
  }
  return contentVerification;
}

async function processReview(review) {
  // BRO-4334: fetchReviewText's partial-text deadline counts from here (main()
  // stamps it just before the REVIEW_TIMEOUT race; this covers other callers).
  if (!Number.isFinite(review._reviewStartedAt)) review._reviewStartedAt = Date.now();
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`Processing: ${review.outlet} - ${review.critic}`);
  console.log(`URL: ${review.url}`);

  // Create a fresh page for each review to prevent state contamination
  try {
    if (context && page) {
      await page.close().catch(() => {});
      page = await context.newPage();
    }
  } catch (e) {
    // Browser likely crashed — try full restart before giving up.
    // Bounded — same hang class as ensureBrowserHealthy()/REVIEW_TIMEOUT.
    console.log(`  ⚠ Could not create fresh page: ${e.message}`);
    try {
      await withTimeout(closeBrowser(), 30000, 'closeBrowser');
      await withTimeout(setupBrowser(), 60000, 'setupBrowser');
    } catch (restartErr) {
      console.log(`  ⚠ Browser restart failed: ${restartErr.message}`);
    }
  }

  // Reason-aware URL discovery: no_url, wrong_content, and fabricated entries need SERP search before fetch
  // A dateless-revival hold (BRO-4430) needs only its stored url's date: no SERP.
  const needsSerpDiscovery = !review._datelessDateRetry
    && (review.incompleteReason === 'no_url' || review.incompleteReason === 'wrong_content' || review.fabricatedEntry);
  if (needsSerpDiscovery && review.filePath) {
    const reason = review.fabricatedEntry ? 'fabricated' : review.incompleteReason;
    console.log(`  [${reason}] Attempting URL discovery before fetch...`);
    const discoveredUrl = await discoverCorrectUrl(review);

    if (discoveredUrl === '__SERP_UNAVAILABLE__') {
      stats.totalFailed++;
      return { success: false, error: 'serp_unavailable' };
    }

    if (discoveredUrl) {
      console.log(`  [${reason}] Discovered: ${review.url || '(none)'} → ${discoveredUrl}`);
      // URL-change invariant (Notion 39a637c5): this write moves the file to a
      // different article, so old-URL-derived state (flags, excerpts, stars,
      // scores, old text) clears with a durable breadcrumb. The previous inline
      // write deliberately KEPT wrong-content flags "until fetch succeeds" —
      // the invariant closes that race harder: the old fullText clears too, so
      // a failed fetch leaves an unflagged textless stub the rebuild can't
      // score, instead of wrong text guarded only by a flag.
      try {
        // stampOnNoop is REQUIRED here: this path exists for no_url /
        // fabricatedEntry recovery, where the existing url is empty or broken
        // — the invariant doesn't apply (nothing to clear), but the discovered
        // url and the fabricated-flag clears must still persist.
        updateFileUrlWithInvariant(review.filePath, discoveredUrl, {
          urlDiscoveredAt: new Date().toISOString(),
          urlDiscoveryMethod: 'google-serp-reason-recovery',
          // Clear fabricated flags on successful URL discovery (undefined
          // values are dropped by JSON serialization = deletion).
          fabricatedEntry: undefined,
          fabricatedReason: undefined,
        }, { stampOnNoop: true, oldUrlProvenWrong: true });
      } catch (e) {}
      review._urlCosmeticOnly = review._urlCosmeticOnly !== false && !isDifferentArticleRecovery(review.url, discoveredUrl);
      review.url = discoveredUrl;
      review._urlDiscovered = true;
      review.fabricatedEntry = false; // prevent re-triggering SERP on retry
    } else {
      // For collector-flagged wrongShow files with existing URLs, fall through to re-fetch
      // (the URL is correct, the scraper just got wrong content last time)
      const isCollectorFlagged = review.wrongShow && typeof review.wrongShowReason === 'string'
        && review.wrongShowReason.startsWith('Collector LLM');
      if (isCollectorFlagged && review.url) {
        console.log(`  [${reason}] No new URL via SERP — re-fetching existing URL (collector-flagged)`);
        review._wrongShowRetrying = true;
      } else {
        console.log(`  [${reason}] No URL found via SERP, skipping`);
        stats.totalFailed++;
        return { success: false, error: `${reason}_no_url_discovered` };
      }
    }
  }

  // showNotMentioned URL recovery: discover correct URL before wasting bandwidth re-fetching the wrong one
  if (review.showNotMentioned && review.filePath) {
    console.log('  [showNotMentioned] Attempting URL discovery before fetch...');

    // Mark as attempted to prevent infinite retries. Also capture whether the
    // file already had a publishDate BEFORE the fetch: updateReviewJson fills
    // publishDate only when absent, so a date that appears between now and the
    // post-fetch url flip was extracted from the NEW article and must survive
    // the flip (while a pre-existing date is the OLD article's and must clear).
    try {
      const fileData = readReviewForUpdate(review.filePath);
      review._hadPublishDateBeforeFetch = !!fileData.publishDate;
      fileData._showNotMentionedDiscoveryAttempted = true;
      persistReviewSnapshot({ filePath: review.filePath, data: fileData, trailingNewline: true });
    } catch (e) {}

    const discoveredUrl = await discoverCorrectUrl(review);
    // SERP providers down — don't mark as attempted, let it retry next run
    if (discoveredUrl === '__SERP_UNAVAILABLE__') {
      try {
        const fileData = readReviewForUpdate(review.filePath);
        delete fileData._showNotMentionedDiscoveryAttempted;
        persistReviewSnapshot({ filePath: review.filePath, data: fileData, trailingNewline: true });
      } catch (e) {}
      stats.totalFailed++;
      return { success: false, error: 'serp_unavailable' };
    }
    if (discoveredUrl && discoveredUrl !== review.url) {
      console.log(`  [showNotMentioned] Discovered: ${review.url} → ${discoveredUrl}`);
      review._previousUrl = review.url;
      review._urlCosmeticOnly = review._urlCosmeticOnly !== false && !isDifferentArticleRecovery(review.url, discoveredUrl);
      review.url = discoveredUrl;
      review._urlDiscovered = true;
    } else {
      console.log('  [showNotMentioned] No alternative URL found, skipping fetch');
      stats.totalFailed++;
      return { success: false, error: 'show_not_mentioned_no_url' };
    }
  }

  // Stale-mismatch reopen (BRO-4185 H): stamp the once-per-version attempt now
  // that this review is really being fetched.
  if (review._mismatchReopen && review.filePath) {
    try {
      const d = readReviewForUpdate(review.filePath);
      d.contentMismatchReopenedFor = URL_CONTENT_CHECK_VERSION;
      persistReviewSnapshot({ filePath: review.filePath, data: d, trailingNewline: true });
    } catch (e) {}
  }

  // Safety: no URL means we can't fetch (prevents crash on no_url reviews that missed SERP)
  if (!review.url) {
    console.log('  ✗ No URL available — skipping');
    stats.totalFailed++;
    return { success: false, error: 'no_url' };
  }

  // Bright Data cap accounting (S2-T5): snapshot the withheld-request counter
  // so the catch below can tell "this URL is dead" from "we chose not to pay
  // for it right now". Sampled per review rather than per run — a run that hits
  // the breaker midway must not retroactively excuse earlier genuine failures.
  const bdBlockedBefore = getScraperStats().bdBlocked || 0;

  try {
    // Consent-prefixed capture: the article is already on disk behind the
    // consent layer. Re-verify that stored text first; fetch only when it
    // doesn't strip to a usable article (BRO-4185 A).
    let result = null;
    if (review._consentLayerRetry && review.filePath) {
      try {
        const stored = salvageConsentPrefixedStoredText(JSON.parse(fs.readFileSync(review.filePath, 'utf8')));
        if (stored) {
          // Stamped only once verification has returned (stampSalvage below).
          review._salvageUsed = true;
          result = { text: stored, method: 'stored-text-consent-stripped', html: null, attempts: null };
          console.log(`  ↺ Using stored text with the consent layer stripped (${stored.length} chars) — no refetch`);
        }
      } catch (e) { /* fall through to a normal fetch */ }
    }
    if (!result) result = await fetchReviewText(review);

    // BRO-4334: a re-fetch of a truncated hard-paywall review that again got
    // only partial text must not overwrite a stored text that is as good or
    // better (complete beats partial, otherwise longer wins). In the
    // opening-window recheck path (stored text already failed the assessment)
    // the new text must ALSO be strictly longer than the stored text — a
    // re-fetch that returns less is never an improvement.
    if ((result.partial || review._paywallRecheck) && review.filePath) {
      try {
        const stored = readReviewForUpdate(review.filePath);
        const storedLen = (stored.fullText || '').length;
        // A COMPLETE re-fetch always wins over a stored partial; only a
        // partial one has to be strictly longer (ship-check P2, BRO-4334).
        const notLonger = result.partial && review._paywallRecheck && storedLen > 0 && (result.text || '').length <= storedLen;
        if (notLonger || shouldKeepStoredText({ storedText: stored.fullText, newText: result.text, url: review.url, criticName: stored.criticName || review.criticName })) {
          console.log(`  ↺ Re-fetch (${result.text.length} chars via ${result.method}) is no better than the stored text (${storedLen} chars) — keeping stored text`);
          // A stored text still labelled 'complete' is re-labelled truncated so
          // reviews.json / the opening-window refetch see it as incomplete.
          const patch = truncatedTierPatch(stored);
          if (patch) {
            Object.assign(stored, patch);
            persistReviewSnapshot({ filePath: review.filePath, data: stored, trailingNewline: true });
            console.log(`    → Re-labelled stored text: ${patch.tierReason}`);
          }
          // Feed the BRO-787 retry gate, else every collector run re-picks the
          // file and re-runs the escalated chain (Browserbase included).
          recordFailedFetch(review, 'partial_no_improvement', { storedLength: storedLen, newLength: result.text.length, method: result.method });
          return { success: false, error: 'partial_no_improvement' };
        }
      } catch (e) { /* unreadable file — fall through to the normal write */ }
    }

    console.log(`  ✓ SUCCESS via ${result.method} (${result.text.length} chars)`);

    // Content quality check - detect garbage/invalid content before saving
    const { showId: qualityShowId, showTitle } = resolveShowIdentity(review.showId);
    // BRO-3116: a not-found template served as HTTP 200 is "not published
    // yet", not a review. Write nothing; short cooldown, never abandoned.
    if (isSoft404Body(result.text)) {
      console.log(`  ✗ SOFT-404 body (${result.text.length} chars) — not saving, retry after cooldown`);
      recordFailedFetch(review, 'soft_404', { method: result.method, textLength: result.text.length });
      stats.totalFailed++;
      return { success: false, error: 'soft_404' };
    }

    const qualityCheck = assessTextQuality(result.text, qualityShowId, showTitle, qualityOptsFor(review));

    if (qualityCheck.quality === 'garbage' && qualityCheck.confidence === 'high') {
      // Don't save garbage content as fullText - log as failed fetch
      console.log(`  ✗ GARBAGE CONTENT DETECTED: ${qualityCheck.issues[0] || 'invalid content'}`);
      console.log(`    Reason: ${qualityCheck.issues.join(', ')}`);

      // A registration-walled The Stage page still carries the article's
      // date, byline and standfirst above the wall. Salvage them so the
      // review doesn't go live with no date, critic or quote (walled-page-
      // meta.js; reader report 2026-09-26). Gap-fill only, never overwrites.
      if (result.html && review.filePath) {
        try {
          const { salvageWalledPageMetaToFile } = require('./lib/walled-page-meta');
          const { resolveShowMeta } = require('./lib/show-identity');
          const salvaged = salvageWalledPageMetaToFile(review.filePath, result.html, { showTitle, show: resolveShowMeta(qualityShowId), expectedUrl: review.url });
          const suspect = salvaged.find((s) => s.endsWith('Suspect'));
          if (suspect) {
            console.log(`    ⚠ Walled page ${suspect} for "${showTitle}" — metadata not applied`);
          } else if (salvaged.length) {
            console.log(`    ↳ Salvaged walled-page metadata: ${salvaged.join(', ')}`);
          }
        } catch (e) {
          console.log(`    ⚠ walled-page metadata salvage failed: ${e.message}`);
        }
      }

      // BRO-4431: other tier-1/2 star outlets (Times, Sunday Times, FT, i,
      // Mail) wall their text too, but may still carry the critic's rating in
      // the page's structured data. Save that as the score (gap-fill only)
      // so the review isn't an unscored stub that never reaches the site.
      if (result.html && review.filePath && review.outletId !== 'thestage') {
        try {
          const { pageStarPatch } = require('./lib/paywall-stub-score');
          const stored = readReviewForUpdate(review.filePath);
          const showEntry = _showsJsonCache ? _showsJsonCache.shows.find((s) => s.id === review.showId) : null;
          const patch = pageStarPatch(stored, result.html, { show: showEntry });
          if (patch) {
            const { safeWriteReview } = require('./lib/review-write-guard');
            safeWriteReview(review.filePath, { ...stored, ...patch });
            console.log(`    ↳ Paywalled page rating saved: ${patch.originalScore} (${patch.originalScoreSource})`);
          }
        } catch (e) {
          console.log(`    ⚠ paywalled-page rating salvage failed: ${e.message}`);
        }
      }

      // Record as failed fetch with reason (increments failure count)
      recordFailedFetch(review, 'garbage_content', {
        method: result.method,
        garbageReason: qualityCheck.issues.join('; '),
        textLength: result.text.length,
      });

      stats.totalFailed++;
      return { success: false, error: 'garbage_content', reason: qualityCheck.issues.join('; ') };
    }

    if (qualityCheck.quality === 'suspicious') {
      // Log warning but continue processing
      console.log(`  ⚠ SUSPICIOUS CONTENT: ${qualityCheck.issues.join(', ')}`);
    }

    // Archive HTML
    const archivePath = result.html ? archiveHtml(result.html, review, result.method) : null;

    // Post-fetch URL→content sanity check (Schmigadoon 2026 Bug #2).
    // BrightData/ScrapingBee occasionally returns a completely different article
    // under our target URL (CDN misroute, stale cache, slug redirect). The LLM
    // verifier catches SOME of these but is expensive and can be defeated by
    // adversarial text. A cheap deterministic mention-count + HTML-<title>
    // guard catches the class before we persist fullText or burn CV tokens.
    {
      const canonicalTitle = _showsJsonCache
        ? (_showsJsonCache.shows.find(s => s.id === review.showId)?.title || showTitle)
        : showTitle;
      const trustHtmlTitle = !UNRELIABLE_TITLE_OUTLETS.has((review.outletId || '').toLowerCase());
      const sanity = validateContentMentionsShow(
        result.text,
        trustHtmlTitle ? titleHtmlFor(result) : null,
        canonicalTitle,
        review.showId
      );
      if (!sanity.valid && guardianMentionWaiver(result, canonicalTitle)) {
        console.log(`  ↪ Mention check (${sanity.reason}) waived: Guardian API headline leads with the show title ("${result.pageTitle}")`);
        sanity.valid = true;
      }
      if (!sanity.valid && !laneHeld(review, 'headlineBackstop')) {
        console.log(`  ✗ URL→CONTENT MISMATCH: ${sanity.reason}`);
        if (sanity.htmlTitle) console.log(`    HTML <title>: "${sanity.htmlTitle}"`);
        // Stored text failing the mention check says nothing about the URL
        // (nothing was fetched): stamp it done instead of counting a fetch
        // failure toward abandoning the URL.
        if (review._salvageUsed) {
          stampSalvage(review);
          stats.totalFailed++;
          return { success: false, error: 'url_content_mismatch', reason: sanity.reason };
        }
        recordFailedFetch(review, 'url_content_mismatch', {
          method: result.method,
          mismatchReason: sanity.reason,
          mentionCount: sanity.mentionCount,
          threshold: sanity.threshold,
          htmlTitle: sanity.htmlTitle,
          htmlTitleMatch: sanity.htmlTitleMatch,
          textLength: result.text.length,
          archivePath,
        });
        stats.totalFailed++;
        return { success: false, error: 'url_content_mismatch', reason: sanity.reason };
      }
    }

    // Time Out serves listing capsules and real reviews at the same URL shape;
    // only the page tells them apart. A capsule (or review) signed by another
    // critic, or a post-2014 listing capsule, is not this row's review
    // (BRO-5222: once-2012, the-minutes-2022).
    if (result.html && isTimeoutUrl(review.url) && !review._salvageUsed) {
      const showYearMatch = String(review.showId || '').match(/-(\d{4})$/);
      const timeoutPage = classifyTimeoutPage({
        html: result.html,
        critic: review.critic,
        showYear: showYearMatch ? Number(showYearMatch[1]) : null,
      });
      // Time Out swaps a closed show's review for a listing blurb at the same
      // url (the-present-2017 stores the 3,140-char review; the page is now a
      // 2-line capsule). The blurb says nothing against text already held.
      if (timeoutPage.verdict === 'listing_capsule' && keepsStoredTimeoutReview({ tier: review._storedTier, textLength: review._storedTextLength, suspect: review._storedTextSuspect })) {
        console.log(`  ↷ TIME OUT PAGE: ${timeoutPage.reason}; keeping the stored ${review._storedTier} text`);
        // Feed the BRO-787 retry gate like the BRO-4334 keep path, else every
        // run re-picks a truncated row and re-runs the paid chain (BRO-5261).
        recordFailedFetch(review, 'partial_no_improvement', { storedLength: review._storedTextLength, newLength: result.text.length, method: result.method, timeoutPage: timeoutPage.reason });
        return { success: false, error: 'timeout_listing_capsule_kept_existing', reason: timeoutPage.reason };
      }
      if (timeoutPage.verdict === 'wrong_critic' || timeoutPage.verdict === 'listing_capsule') {
        console.log(`  ✗ TIME OUT PAGE: ${timeoutPage.reason}`);
        recordFailedFetch(review, 'url_content_mismatch', {
          method: result.method,
          mismatchReason: `timeout_${timeoutPage.verdict}: ${timeoutPage.reason}`,
          textLength: result.text.length,
        });
        stats.totalFailed++;
        return { success: false, error: 'url_content_mismatch', reason: timeoutPage.reason };
      }
    }

    // Validate
    const validation = validateReviewText(result.text, review);
    console.log(`  Validation: ${validation.valid ? 'PASS' : 'ISSUES'} (${validation.wordCount} words)`);
    if (!validation.valid) {
      console.log(`  Issues: ${validation.issues.join(', ')}`);
    }

    // LLM-based content verification (runs by default, falls back to heuristic without API key)
    const contentVerification = await verifyFetchedContent(review, result, validation, { discoveredUrl: review._urlDiscovered ? review.url : null });
    if (review._urlDiscovered) {
      // no_url / fabricated / showNotMentioned recovery switched to a SERP hit:
      // the search has to prove the page before its text is stored (BRO-5183).
      const verdict = discoveredPageVerdict(contentVerification);
      if (!verdict.accept) {
        console.log(`  ✗ DISCOVERED PAGE REFUSED: ${verdict.reason}`);
        stats.totalFailed++;
        return { success: false, error: 'discovered_url_unverified', reason: verdict.reason };
      }
    }

    // Update JSON (pass HTML for score extraction)
    await updateReviewJson(review, result.text, validation, archivePath, result.method, result.attempts, result.archiveData || {}, result.html || '', contentVerification, result.apiMeta || null);

    // Persist URL discovery metadata if URL was changed via showNotMentioned recovery.
    // ORDERING NOTE: updateReviewJson above already wrote the NEW article's
    // text + verification into the file (still under the old url) — those
    // fields are new-era and must survive the url flip; the invariant's
    // preserveFields exempts them. What still clears: old-URL leftovers the
    // fetch didn't overwrite (aggregator excerpts, aggregatorStars, old
    // llmScore, wrong flags) — the exact JCS suppression state.
    if (review._urlDiscovered && review.filePath) {
      try {
        const { NEW_ERA_FETCH_FIELDS } = require('./lib/url-change-invariant');
        const preserve = new Set(NEW_ERA_FETCH_FIELDS);
        // A publishDate that appeared during this run was extracted from the
        // NEW article by updateReviewJson (it only fills absent dates) — it
        // must survive the url flip. A date that predated the fetch is the
        // OLD article's and clears (/code-review 2026-07-11).
        if (review._hadPublishDateBeforeFetch === false) preserve.add('publishDate');
        const updated = updateFileUrlWithInvariant(review.filePath, review.url, {
          urlDiscoveredAt: new Date().toISOString(),
          urlDiscoveryMethod: 'show-not-mentioned-recovery',
        }, { preserveFields: preserve, stampOnNoop: true, oldUrlProvenWrong: true });
        if (updated) console.log(`    → URL updated: ${review._previousUrl} → ${review.url}`);
      } catch (e) {
        console.log(`    ⚠ Could not persist URL discovery: ${e.message}`);
      }
    }

    // Track tier breakdown (normalize hyphenated method names to camelCase keys)
    const methodKey = result.method === 'direct-cookies' ? 'directCookies' : result.method;
    if (methodKey && state.tierBreakdown[methodKey]) {
      state.tierBreakdown[methodKey].push(review.reviewId);
    }

    // Clear any previous failure tracking on success
    clearFailedFetch(review.reviewId);

    // For wrong_content: now safe to clear flags (content fetched and validated from new URL)
    // DoaS Apr 9-10 #11: also clear stale rejection metadata so the file isn't permanently
    // skipped on next run. Without clearing incompleteReason/incompleteDetail/contentTier,
    // the next collect cycle would re-skip the file via line 5067's isWrongContent guard.
    if (review.incompleteReason === 'wrong_content' && review._urlDiscovered && review.filePath) {
      try {
        const postData = readReviewForUpdate(review.filePath);
        // BRO-2828: this recovery answers ONE question — did re-fetching from
        // the corrected URL produce the right article? A flag set from data
        // that is not the article body and not the URL is not answered by it,
        // and deleting such a flag here silently un-excludes the review. The
        // live case was the anticipatory pre-opening gate, stamped moments
        // earlier in this same pass from publishDate vs openingDate, wiped by
        // a cosmetic /comment-page-1/ suffix strip on the same article.
        const preserve = shouldPreserveExclusionFlagsOnUrlRecovery(postData);
        // BRO-2869: a cosmetic url flip (same canonical article) is not a
        // recovery of a DIFFERENT article, so the content/exclusion verdicts
        // stay. Only the retry-state clears below still run (re-selecting the
        // file every wrong_content drain can make no progress).
        if (!review._urlCosmeticOnly) {
          if (!preserve.wrongProduction) {
            delete postData.wrongProduction;
            delete postData.wrongProductionReason;
          }
          if (!preserve.wrongShow) {
            delete postData.wrongShow;
            delete postData.wrongShowReason;
          }
          delete postData.showNotMentioned;
          delete postData.contentMismatchNote;
        }
        // incompleteReason/incompleteDetail/contentTier are cleared even when
        // the flag is preserved, and that is deliberate. Keeping
        // incompleteReason='wrong_content' would re-select this file on EVERY
        // targeted INCOMPLETE_REASON_FILTER=wrong_content drain (the filter
        // above matches on exactly that value), re-fetching it forever at real
        // scraper cost with no possible progress: a publishDate-vs-openingDate
        // verdict cannot be changed by fetching the page again. Clearing them
        // leaves the file skipped by the default pass via the isWrongContent
        // guard above — which is what "correctly excluded" is supposed to look
        // like, not a stranding. The clear path for a preserved flag is the
        // rebuild's anticipatory auto-clear, which re-derives from shows.json
        // and needs no re-fetch at all. (Codex adversarial review caught this;
        // an earlier reviewer had argued the opposite and was wrong.)
        delete postData.incompleteReason;
        delete postData.incompleteDetail;
        if (postData.contentTier === 'invalid' || postData.contentTier === 'needs-rescrape') {
          delete postData.contentTier;
        }
        if (preserve.wrongProduction) {
          postData.wrongProductionPreservedOnUrlRecoveryAt = new Date().toISOString();
        }
        if (preserve.wrongShow) {
          postData.wrongShowPreservedOnUrlRecoveryAt = new Date().toISOString();
        }
        persistReviewSnapshot({ filePath: review.filePath, data: postData, trailingNewline: true });
        console.log(preserve.wrongProduction || preserve.wrongShow
          ? `    ✓ wrong_content recovered — ${[preserve.wrongProduction && `wrongProduction (${postData.wrongProductionReason})`, preserve.wrongShow && `wrongShow (${postData.wrongShowReason})`].filter(Boolean).join(' + ')} PRESERVED: not a content verdict, re-fetch is no evidence against it`
          : `    ✓ wrong_content recovered — cleared incompleteReason/contentTier so future collects won't re-skip`);
      } catch (e) {
        // Recovery cleanup failed — preserve original state. Log so we know why next-cycle still skips.
        console.log(`    ⚠ wrong_content recovery cleanup failed (${e.message}) — file state preserved`);
      }
    }

    // Retry outcome for flagged reviews: release verifier-set flags on a clean
    // verdict (with the auto-clear breadcrumbs the push-time restore honours),
    // else start the cooldown. See applyVerifiedRetryOutcome.
    if (review._wrongShowRetrying && review.filePath) {
      try {
        const postData = readReviewForUpdate(review.filePath);
        const outcome = applyVerifiedRetryOutcome(postData, new Date().toISOString());
        if (outcome.clearedWrongShow) console.log(`    ✓ wrongShow cleared — retry passed content verification`);
        if (outcome.clearedWrongProduction) console.log(`    ✓ wrongProduction cleared — retry passed content verification (right production)`);
        if (!outcome.clearedWrongShow && !outcome.clearedWrongProduction && postData.wrongShowRetryAt) {
          console.log(`    ✗ retry did not clear the flag — next retry in 14 days`);
        }
        delete postData._wrongShowRetrying;
        persistReviewSnapshot({ filePath: review.filePath, data: postData, trailingNewline: true });
      } catch (e) {}
    }

    // BRO-4430: a dateless-hold fetch stamps its cooldown whatever the verdict.
    // applyVerifiedRetryOutcome above clears wrongShowRetryAt on a clean
    // verdict, and a page with no extractable date would otherwise be
    // refetched (paid) on every run, filtered or not.
    if (review._datelessDateRetry && review.filePath) stampDatelessRetry(review.filePath);

    // Consent-layer refetch (BRO-4185 A): the "not a review" verdict that set
    // isNonReview judged a consent banner. A fresh, clean, high-confidence
    // verdict on the stripped article releases it.
    if (review._consentLayerRetry && review.filePath) {
      try {
        const postData = readReviewForUpdate(review.filePath);
        if (shouldReleaseConsentLayerNonReview(postData)) {
          postData.isNonReview = false;
          if (postData.rejectionReason === 'not_a_review') postData.rejectionReason = null;
          postData.isNonReviewReason = null;
          postData.nonReviewOverride = 'collect-review-texts: consent-layer refetch re-verified as a review (BRO-4185 A)';
          postData.nonReviewOverrideAt = new Date().toISOString();
          persistReviewSnapshot({ filePath: review.filePath, data: postData, trailingNewline: true });
          console.log('    ✓ isNonReview cleared — consent-layer refetch re-verified as a review');
        }
      } catch (e) {}
    }

    // Stored-text re-verify done: stamp the final stored state so it is not
    // re-verified until the text changes. Not stamped when verification threw.
    if (review._salvageUsed && contentVerification) stampSalvage(review);

    return { success: true, method: result.method, validation };

  } catch (error) {
    console.log(`  ✗ FAILED: ${error.message}`);

    // URL Discovery: If the failure was a 404 and we haven't retried yet, try to find the correct URL
    if (error.message.includes('404') && !review._discoveryAttempted && review.filePath) {
      review._discoveryAttempted = true;

      // Try outlet-specific URL resolution first (no API cost)
      console.log('\n  [URL Resolution] Trying known URL patterns...');
      let discoveredUrl = await resolveTimeoutListingUrl(review);

      // Fall back to SERP-based discovery
      if (!discoveredUrl) {
        console.log('  [URL Discovery] Attempting to find correct URL via Google...');
        discoveredUrl = await discoverCorrectUrl(review);
      }

      // SERP providers all down — don't penalize this review, just skip it for this run
      if (discoveredUrl === '__SERP_UNAVAILABLE__') {
        console.log('  [URL Discovery] SERP unavailable — will retry next run without penalty');
        stats.totalFailed++;
        return { success: false, error: 'serp_unavailable' };
      }

      if (discoveredUrl) {
        const originalUrl = review.url;
        review.url = discoveredUrl;
        console.log(`  [Retry] Re-attempting fetch with discovered URL...`);

        try {
          const retryResult = await fetchReviewText(review);
          console.log(`  ✓ SUCCESS via ${retryResult.method} with discovered URL (${retryResult.text?.length || 0} chars)`);

          // Check for garbage content BEFORE writing URL to file
          // (prevents cost leak: if we write the URL first and content is garbage,
          // future runs would re-discover the same URL and waste SERP credits)
          const { showId: qualityShowId, showTitle } = resolveShowIdentity(review.showId);
          const qualityCheck = assessTextQuality(retryResult.text, qualityShowId, showTitle);
          if (qualityCheck.quality === 'garbage' && qualityCheck.confidence === 'high') {
            console.log(`  ✗ GARBAGE CONTENT from discovered URL: ${qualityCheck.issues[0]}`);
            review.url = originalUrl; // restore before failing
            stats.totalFailed++;
            return { success: false, error: 'garbage_content_from_discovered_url' };
          }

          const archivePath = retryResult.html ? archiveHtml(retryResult.html, review, retryResult.method) : null;

          // Post-fetch URL→content sanity check (Bug #2) — also on retry path
          const retryCanonicalTitle = _showsJsonCache
            ? (_showsJsonCache.shows.find(s => s.id === review.showId)?.title || showTitle)
            : showTitle;
          const retryTrustHtmlTitle = !UNRELIABLE_TITLE_OUTLETS.has((review.outletId || '').toLowerCase());
          const retrySanity = validateContentMentionsShow(
            retryResult.text,
            retryTrustHtmlTitle ? titleHtmlFor(retryResult) : null,
            retryCanonicalTitle,
            review.showId
          );
          if (!retrySanity.valid && guardianMentionWaiver(retryResult, retryCanonicalTitle)) {
            console.log(`  ↪ Mention check (${retrySanity.reason}) waived: Guardian API headline leads with the show title ("${retryResult.pageTitle}")`);
            retrySanity.valid = true;
          }
          if (!retrySanity.valid && !laneHeld(review, 'headlineBackstop')) {
            console.log(`  ✗ URL→CONTENT MISMATCH (retry): ${retrySanity.reason}`);
            recordFailedFetch(review, 'url_content_mismatch', {
              method: retryResult.method,
              mismatchReason: retrySanity.reason,
              mentionCount: retrySanity.mentionCount,
              threshold: retrySanity.threshold,
              htmlTitle: retrySanity.htmlTitle,
              textLength: retryResult.text.length,
              archivePath,
              retry: true,
            });
            stats.totalFailed++;
            return { success: false, error: 'url_content_mismatch_retry', reason: retrySanity.reason };
          }

          // A searched-up page must pass the content verifier (right show, right
          // production, right article) before it takes the slot (BRO-5183).
          const validation = validateReviewText(retryResult.text, review);
          const retryVerification = await verifyFetchedContent(review, retryResult, validation, { discoveredUrl });
          const discoveredVerdict = discoveredPageVerdict(retryVerification);
          if (!discoveredVerdict.accept) {
            console.log(`  ✗ DISCOVERED PAGE REFUSED: ${discoveredVerdict.reason}`);
            review.url = originalUrl;
            if (!discoveredVerdict.retry) {
              recordFailedFetch(review, 'discovered_url_unverified', {
                method: retryResult.method,
                discoveredUrl,
                reason: discoveredVerdict.reason,
                textLength: retryResult.text.length,
                archivePath,
                retry: true,
              });
            }
            stats.totalFailed++;
            return { success: false, error: 'discovered_url_unverified', reason: discoveredVerdict.reason };
          }

          // Content is good and about this show — update the review file's URL
          // (atomic write inside the helper). Done AFTER the content sanity check
          // above so a mismatched page never takes the slot (BRO-4131). Disk
          // still holds the OLD article's text/state here (the fresh
          // retryResult.text is written by updateReviewJson just below), so the
          // URL-change invariant applies: old-URL flags and text clear with a
          // durable breadcrumb. The old url 404'd and the outlet's own page
          // replaced it, so this is the same review at a new address: its
          // aggregator excerpts/stars/score describe the review and survive
          // (same rule as rediscover-review-urls.js).
          let urlWritten = null;
          try {
            const { AGGREGATOR_FIELDS } = require('./lib/rediscovery-candidate');
            urlWritten = updateFileUrlWithInvariant(review.filePath, discoveredUrl, {
              urlDiscoveredAt: new Date().toISOString(),
              urlDiscoveryMethod: 'google-serp',
            }, { stampOnNoop: true, preserveFields: new Set(AGGREGATOR_FIELDS) });
            if (urlWritten) console.log(`    → Updated review URL: ${originalUrl} → ${discoveredUrl}`);
          } catch (writeErr) {
            console.log(`    ⚠ Could not update URL in file: ${writeErr.message}`);
          }
          if (!urlWritten) {
            // Refused (cross-outlet, aggregator page, another critic's url, or
            // score loss): writing the new page's text now would attach it to
            // the OLD url (BRO-4132 Gap 2 shape).
            console.log(`  ✗ URL write refused — not storing ${discoveredUrl}'s text under ${originalUrl}`);
            review.url = originalUrl;
            stats.totalFailed++;
            return { success: false, error: 'discovered_url_write_refused' };
          }

          await updateReviewJson(review, retryResult.text, validation, archivePath, retryResult.method, retryResult.attempts, retryResult.archiveData || {}, retryResult.html || '', retryVerification, retryResult.apiMeta || null);

          const retryMethodKey = retryResult.method === 'direct-cookies' ? 'directCookies' : retryResult.method;
          if (retryMethodKey && state.tierBreakdown[retryMethodKey]) {
            state.tierBreakdown[retryMethodKey].push(review.reviewId);
          }

          return { success: true, method: retryResult.method + '+url-discovery', validation };
        } catch (retryErr) {
          // Discovered URL also failed — restore original and fall through to normal failure
          review.url = originalUrl;
          console.log(`    ✗ Discovered URL also failed: ${retryErr.message}`);
        }
      }
    }

    stats.totalFailed++;

    // Record permanent failure (increments count — after 3, review is skipped)
    // A Bright Data request withheld by the daily breaker or per-run budget is
    // not evidence about the URL. A confirmed 404 still wins — that IS evidence
    // — but any other failure that happened while BD was capped is recorded as
    // budget_capped so it never counts toward permanent retirement (S2-T5).
    // Same for a Browserbase route skipped at a session cap (BRO-5222).
    const bdWasCapped = (getScraperStats().bdBlocked || 0) > bdBlockedBefore;
    const routeCapped = review._browserbaseCapSkipped || null;
    const failReason = classifyFetchFailure({ message: error.message, bdWasCapped, routeCapped, codeError: isOwnCodeException(error) });
    recordFailedFetch(review, failReason, {
      errorMessage: error.message.slice(0, 200),
      ...(routeCapped ? { routeCapped } : {}),
    });

    // Track failures by outlet for end-of-run reporting
    const outletName = review.outlet || review.outletId || 'unknown';
    const urlDomain = (() => { try { return new URL(review.url).hostname.replace('www.', ''); } catch(e) { return 'unknown'; } })();
    if (!stats.failuresByOutlet[outletName]) {
      const paywallCreds = getPaywallCredentials(review.url);
      stats.failuresByOutlet[outletName] = {
        count: 0,
        domain: urlDomain,
        hasCredentials: paywallCreds ? !!(paywallCreds.email && paywallCreds.password) : false,
        isPaywalled: !!paywallCreds,
        isKnownBlocked: CONFIG.knownBlockedSites.some(s => urlDomain.includes(s)),
      };
    }
    stats.failuresByOutlet[outletName].count++;

    if (review._datelessDateRetry && review.filePath) stampDatelessRetry(review.filePath);

    // For wrongShow retries that failed: update retry timestamp to enforce cooldown
    if (review._wrongShowRetrying && review.filePath) {
      try {
        const postData = readReviewForUpdate(review.filePath);
        postData.wrongShowRetryAt = new Date().toISOString();
        delete postData._wrongShowRetrying;
        persistReviewSnapshot({ filePath: review.filePath, data: postData, trailingNewline: true });
      } catch (e) {}
    }

    return { success: false, error: error.message };
  }
}

// ============================================================================
// TEST URL MODE
// ============================================================================

async function testUrl(url) {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  TEST URL MODE                                             ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`URL: ${url}\n`);

  await setupBrowser();

  const fakeReview = {
    reviewId: 'test/test.json',
    filePath: null,
    showId: 'test',
    outlet: 'Test',
    outletId: 'test',
    critic: 'Test',
    url: url,
  };

  const results = [];

  // Test each tier
  const tiers = [
    { name: 'Playwright', fn: () => fetchWithPlaywright(url, fakeReview) },
    { name: 'Scrapingdog', fn: () => fetchWithScrapingdogText(url), requires: process.env.SCRAPINGDOG_API_KEY },
    { name: 'ScrapingBee', fn: () => fetchWithScrapingBee(url), requires: CONFIG.scrapingBeeKey },
    { name: 'Bright Data', fn: () => fetchWithBrightData(url), requires: CONFIG.brightDataKey },
    { name: 'Archive.org', fn: () => fetchFromArchive(url) },
  ];

  for (const tier of tiers) {
    if (tier.requires === undefined || tier.requires) {
      console.log(`\n[Testing ${tier.name}]`);
      try {
        const start = Date.now();
        const result = await tier.fn();
        const duration = Date.now() - start;
        const wordCount = result.text.split(/\s+/).length;
        console.log(`  ✓ SUCCESS in ${duration}ms`);
        console.log(`  Text length: ${result.text.length} chars, ${wordCount} words`);
        console.log(`  Preview: ${result.text.substring(0, 200)}...`);
        results.push({ tier: tier.name, success: true, duration, chars: result.text.length, words: wordCount });
      } catch (e) {
        console.log(`  ✗ FAILED: ${e.message}`);
        results.push({ tier: tier.name, success: false, error: e.message });
      }
    } else {
      console.log(`\n[${tier.name}] Skipped - not configured`);
      results.push({ tier: tier.name, success: false, error: 'Not configured' });
    }
  }

  await closeBrowser();

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('RESULTS SUMMARY:');
  console.log('═'.repeat(60));
  for (const r of results) {
    const status = r.success ? '✓' : '✗';
    const details = r.success ? `${r.words} words in ${r.duration}ms` : r.error;
    console.log(`${status} ${r.tier}: ${details}`);
  }

  const successCount = results.filter(r => r.success).length;
  console.log(`\n${successCount}/${results.length} tiers succeeded`);
}

// ============================================================================
// GENERATE REPORT
// ============================================================================

function generateReport() {
  const report = {
    runDate: new Date().toISOString(),
    config: {
      batchSize: CONFIG.batchSize,
      maxReviews: CONFIG.maxReviews,
      priority: CONFIG.priority,
      showFilter: CONFIG.showFilter,
      aggressive: CLI.aggressive,
      scrapingBeeEnabled: !!CONFIG.scrapingBeeKey,
      brightDataEnabled: !!CONFIG.brightDataKey,
      stealthPluginLoaded: stealthLoaded,
    },
    summary: {
      // BRO-2691: this process's attempts only; resumed progress.json state is under cumulativeResumedState.
      processed: runProcessed.length,
      failed: runFailed.length,
      skipped: state.skipped.length,
      successRate: runProcessed.length > 0
        ? ((runProcessed.length / (runProcessed.length + runFailed.length)) * 100).toFixed(1) + '%'
        : '0%',
    },
    tierBreakdown: {
      playwright: state.tierBreakdown.playwright?.length || 0,
      amp: state.tierBreakdown.amp?.length || 0,
      browserbase: state.tierBreakdown.browserbase?.length || 0,
      directCookies: state.tierBreakdown.directCookies?.length || 0,
      scrapingdog: state.tierBreakdown.scrapingdog?.length || 0,
      scrapingbee: state.tierBreakdown.scrapingbee?.length || 0,
      brightdata: state.tierBreakdown.brightdata?.length || 0,
      archiveToday: state.tierBreakdown.archiveToday?.length || 0,
      archive: state.tierBreakdown.archive?.length || 0,
    },
    statistics: {
      tier1Attempts: stats.tier1Attempts,
      tier1Success: stats.tier1Success,
      ampAttempts: stats.ampAttempts,
      ampSuccess: stats.ampSuccess,
      tier1_5Attempts: stats.tier1_5Attempts,
      tier1_5Success: stats.tier1_5Success,
      tier1_9Attempts: stats.tier1_9Attempts,
      tier1_9Success: stats.tier1_9Success,
      tier2Attempts: stats.tier2Attempts,
      tier2Success: stats.tier2Success,
      tier3Attempts: stats.tier3Attempts,
      tier3Success: stats.tier3Success,
      tier3_6Attempts: stats.tier3_6Attempts,
      tier3_6Success: stats.tier3_6Success,
      tier4Attempts: stats.tier4Attempts,
      tier4Success: stats.tier4Success,
      totalFailed: stats.totalFailed,
      scrapingBeePageCredits: stats.scrapingBeePageCredits,
      scrapingBeeSerpCredits: stats.scrapingBeeSerpCredits,
      browserbaseSessionsUsed: stats.browserbaseSessionsUsed,
      browserbaseMinutesUsed: Math.round(stats.browserbaseMinutesUsed * 10) / 10,
      urlDiscoveryAttempts: stats.urlDiscoveryAttempts,
      urlDiscoverySuccess: stats.urlDiscoverySuccess,
      urlDiscoveryCapped: stats.urlDiscoveryCapped,
    },
    // BRO-2691: processed/failed below are the RESUMED cumulative state
    // (progress.json <24h). thisRun is what THIS process attempted.
    thisRun: summarizeRunScope({ runProcessed, runFailed, filterSet: CONFIG.showFilterSet, rawFilter: CONFIG.showFilter, resumedProcessed: resumedCounts.processed, resumedFailed: resumedCounts.failed }),
    processed: runProcessed,
    failed: runFailed,
    cumulativeResumedState: { processed: state.processed, failed: state.failed },
    tierDetails: state.tierBreakdown,
    failuresByOutlet: stats.failuresByOutlet,
    urlDiscoveries: stats.urlDiscoveryDetails,
  };

  const date = new Date().toISOString().split('T')[0];
  const reportPath = path.join(CONFIG.auditDir, `collection-report-${date}.json`);
  fs.mkdirSync(CONFIG.auditDir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n${'╔' + '═'.repeat(58) + '╗'}`);
  console.log(`║${'COLLECTION REPORT'.padStart(38).padEnd(58)}║`);
  console.log(`${'╠' + '═'.repeat(58) + '╣'}`);
  console.log(`║ Processed: ${String(report.summary.processed).padStart(44)} ║`);
  console.log(`║ Failed:    ${String(report.summary.failed).padStart(44)} ║`);
  console.log(`║ Success Rate: ${String(report.summary.successRate).padStart(41)} ║`);
  console.log(`${'╠' + '═'.repeat(58) + '╣'}`);
  console.log(`║ TIER BREAKDOWN                                           ║`);
  console.log(`║ ├─ Tier 1 (Playwright):  ${String(report.tierBreakdown.playwright).padStart(31)} ║`);
  console.log(`║ ├─ Tier 1.1 (AMP):       ${String(report.tierBreakdown.amp).padStart(31)} ║`);
  console.log(`║ ├─ Tier 1.5 (Browserbase):${String(report.tierBreakdown.browserbase).padStart(30)} ║`);
  console.log(`║ ├─ Tier 1.8 (Direct+Cook):${String(report.tierBreakdown.directCookies).padStart(30)} ║`);
  console.log(`║ ├─ Tier 1.9 (Scrapingdog):${String(report.tierBreakdown.scrapingdog).padStart(30)} ║`);
  console.log(`║ ├─ Tier 2 (ScrapingBee): ${String(report.tierBreakdown.scrapingbee).padStart(31)} ║`);
  console.log(`║ ├─ Tier 3 (Bright Data): ${String(report.tierBreakdown.brightdata).padStart(31)} ║`);
  console.log(`║ ├─ Tier 3.6 (archive.ph):${String(report.tierBreakdown.archiveToday).padStart(31)} ║`);
  console.log(`║ └─ Tier 4 (Archive.org): ${String(report.tierBreakdown.archive).padStart(31)} ║`);
  console.log(`${'╠' + '═'.repeat(58) + '╣'}`);
  console.log(`║ API USAGE                                                ║`);
  console.log(`║ ├─ SB page credits:    ${String(stats.scrapingBeePageCredits).padStart(32)} ║`);
  console.log(`║ ├─ SB SERP credits:    ${String(stats.scrapingBeeSerpCredits).padStart(32)} ║`);
  console.log(`║ └─ Browserbase sessions: ${String(stats.browserbaseSessionsUsed).padStart(31)} ║`);
  if (stats.urlDiscoveryAttempts > 0) {
    console.log(`${'╠' + '═'.repeat(58) + '╣'}`);
    console.log(`║ URL DISCOVERY                                            ║`);
    console.log(`║ ├─ Attempted: ${String(stats.urlDiscoveryAttempts).padStart(42)} ║`);
    console.log(`║ ├─ Found: ${String(stats.urlDiscoverySuccess).padStart(46)} ║`);
    if (stats.urlDiscoveryCapped > 0) {
      console.log(`║ ├─ Skipped (cap reached): ${String(stats.urlDiscoveryCapped).padStart(30)} ║`);
    }
    const rate = stats.urlDiscoveryAttempts > 0
      ? ((stats.urlDiscoverySuccess / stats.urlDiscoveryAttempts) * 100).toFixed(0) + '%'
      : 'N/A';
    console.log(`║ └─ Success rate: ${String(rate).padStart(39)} ║`);
    if (stats.urlDiscoveryDetails.length > 0) {
      for (const d of stats.urlDiscoveryDetails) {
        console.log(`║   ${d.reviewId.substring(0, 54).padEnd(55)}║`);
      }
    }
  }
  console.log(`${'╚' + '═'.repeat(58) + '╝'}`);

  // Cookie expiry alert — fires via stderr + GITHUB_STEP_SUMMARY if cookies expired.
  // Signal to ops: paywall cookies need refreshing (NYT, Vulture, WSJ, New Yorker).
  // (Postmortem audit fix: _cookiesExpired was set but never read/alerted.)
  if (stats.cookieExpiryCount > 0) {
    const domains = Object.entries(stats.cookieExpiries)
      .map(([domain, count]) => `${domain} (${count}x)`)
      .join(', ');
    console.warn(`\n⚠️  COOKIE EXPIRY ALERT: ${stats.cookieExpiryCount} expiry events across: ${domains}`);
    console.warn(`   Reviews from these outlets degraded to ScrapingBee/BrightData tiers.`);
    console.warn(`   Action: refresh cookies via check-cookie-health workflow or local extraction.`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
          `\n## ⚠️ Cookie Expiry Alert\n\n${stats.cookieExpiryCount} expiry events across: ${domains}\n\nRefresh cookies via check-cookie-health workflow.\n`);
      } catch {}
    }
    // Emit GHA warning annotation so it surfaces in the PR/run UI
    console.log(`::warning::Cookie expiry detected for ${Object.keys(stats.cookieExpiries).length} outlet(s): ${domains}`);
  }

  // Print failures by outlet - helps identify which sites need subscriptions or better scraping
  const outletFailures = Object.entries(stats.failuresByOutlet)
    .sort((a, b) => b[1].count - a[1].count);
  if (outletFailures.length > 0) {
    console.log(`\n${'╔' + '═'.repeat(58) + '╗'}`);
    console.log(`║${'FAILURES BY OUTLET'.padStart(38).padEnd(58)}║`);
    console.log(`${'╠' + '═'.repeat(58) + '╣'}`);
    for (const [outlet, info] of outletFailures.slice(0, 15)) {
      const status = info.isPaywalled
        ? (info.hasCredentials ? '🔑 has creds (login issue?)' : '🔒 NEEDS SUBSCRIPTION')
        : (info.isKnownBlocked ? '🚫 bot-blocked' : '❌ scraping failed');
      console.log(`║ ${String(info.count).padStart(3)} fails: ${outlet.padEnd(22)} ${status.padEnd(23)}║`);
    }
    console.log(`${'╚' + '═'.repeat(58) + '╝'}`);
  }

  console.log(`Report saved: ${reportPath}`);

  return report;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  // --help/-h is checked BEFORE loadDependencies/loadState/any network or fs
  // work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(args)) { console.log(USAGE); return; }

  // Test URL mode
  if (CLI.testUrl) {
    await loadDependencies();
    await testUrl(CLI.testUrl);
    return;
  }

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  REVIEW TEXT COLLECTION - Multi-Tier Fallback System       ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`Config: batch=${CONFIG.batchSize}, max=${CONFIG.maxReviews}, priority=${CONFIG.priority}`);
  console.log(`Flags: aggressive=${CLI.aggressive}, forceTier=${CLI.forceTier || 'auto'}`);
  if (CONFIG.domainFilter.length > 0) {
    console.log(`Domain filter: ${CONFIG.domainFilter.join(', ')}`);
  }
  if (CONFIG.excludeDomains.length > 0) {
    console.log(`Excluding domains: ${CONFIG.excludeDomains.join(', ')}`);
  }

  // Load dependencies
  await loadDependencies();

  console.log(`\nAPI Status:`);
  console.log(`  ScrapingBee: ${CONFIG.scrapingBeeKey ? '✓ configured' : '✗ not configured'}`);
  console.log(`  Bright Data: ${CONFIG.brightDataKey ? '✓ configured' : '✗ not configured'}`);
  console.log(`  Browserbase: ${CONFIG.browserbaseEnabled ? `✓ enabled (limit: ${CONFIG.browserbaseMaxSessionsPerDay}/day)` : '✗ disabled'}`);
  console.log(`  Stealth Plugin: ${stealthLoaded ? '✓ loaded' : '⚠ using fallback'}`);
  console.log(`  URL Discovery Limit: ${URL_DISCOVERY_MAX_PER_RUN}/run`);

  // Validate cookie secrets — fail loudly if any are corrupted
  console.log(`\nCookie Status:`);
  let cookieErrors = 0;
  const seenEnvVars = new Set();
  for (const [domain, config] of Object.entries(COOKIE_DOMAIN_MAP)) {
    if (seenEnvVars.has(config.envVar)) continue; // Skip aliases (nymag→VULTURE, huffingtonpost→HUFFPOST)
    seenEnvVars.add(config.envVar);
    const envVal = process.env[config.envVar];
    if (envVal) {
      try {
        const decoded = Buffer.from(envVal, 'base64').toString('utf-8');
        const cookies = JSON.parse(decoded);
        if (Array.isArray(cookies) && cookies.length > 0) {
          console.log(`  🍪 ${config.envVar}: ✓ ${cookies.length} cookies`);
        } else {
          console.log(`  ⚠ ${config.envVar}: decoded but empty/invalid array`);
          cookieErrors++;
        }
      } catch (e) {
        console.log(`  ✗ ${config.envVar}: CORRUPTED — ${e.message}`);
        cookieErrors++;
      }
    }
    // Don't log missing — most domains won't have env vars set locally
  }
  if (cookieErrors > 0) {
    console.log(`\n  ⚠ WARNING: ${cookieErrors} cookie secret(s) are CORRUPTED — they will NOT work.`);
    console.log(`  Re-upload with: base64 < data/cookies/FILE.json | gh secret set SECRET_NAME`);
  }

  // Load previous state if resuming
  loadState();
  resumedCounts = { processed: state.processed.length, failed: state.failed.length };

  // Load Browserbase usage tracking (for spending limits)
  if (CONFIG.browserbaseEnabled) {
    await loadBrowserbaseUsage();
  }

  // Find reviews to process
  const reviews = findReviewsToProcess();
  console.log(`\nFound ${reviews.length} reviews to process`);

  if (reviews.length === 0) {
    console.log('No reviews to process. Exiting.');
    return;
  }

  // Setup browser
  await setupBrowser();

  const startTime = Date.now();

  try {
    let batchCount = 0;

    for (let i = 0; i < reviews.length; i++) {
      if (isTimeBudgetExceeded({ startTime, now: Date.now(), maxDurationMs: CONFIG.maxDurationMs })) {
        console.log(`\n⏱ Time budget reached (${Math.round(CONFIG.maxDurationMs / 1000)}s) — stopping early with a clean checkpoint (${i}/${reviews.length} attempted, ${state.processed.length} succeeded). Remaining reviews will be picked up next run.`);
        break;
      }

      const review = reviews[i];

      // BRO-2691: defense in depth — never spend on a review outside SHOW_FILTER.
      if (!isInShowScope(showIdOfReviewId(review.reviewId), CONFIG.showFilterSet, CONFIG.showFilter)) {
        console.log(`  ⏭ Skipping ${review.reviewId} — outside SHOW_FILTER`);
        continue;
      }

      // BRO-3024: findReviewsToProcess() only excludes reviews already
      // failed/processed as of when it built the queue — a defensive re-check
      // here catches anything recorded as attempted since then (this loop is
      // the only place that pushes to state.failed/state.processed), so a
      // paid fetch is never repeated for the same reviewId within one run.
      if (shouldSkipAlreadyAttempted(state, review.reviewId, CONFIG.retryFailed)) {
        console.log(`  ⏭ Skipping ${review.reviewId} — already attempted this session`);
        continue;
      }

      // Hard timeout per review - prevents hung Playwright from killing entire run
      let result;
      try {
        review._reviewStartedAt = Date.now(); // BRO-4334: fetchReviewText's partial-text deadline
        result = await withTimeout(processReview(review), CONFIG.reviewTimeout, 'REVIEW_TIMEOUT');
      } catch (e) {
        if (e.message === 'REVIEW_TIMEOUT') {
          console.log(`  ✗ TIMEOUT: Review took >${CONFIG.reviewTimeout/1000}s - skipping (${review.outlet} - ${review.critic})`);
          timedOutReviews.push({ reviewId: review.reviewId, url: review.url });
          // Kill and restart browser to clear hung state. Bounded — a hung
          // browser.close()/launch() (zombie process, exhausted resources after
          // many restarts) otherwise stalls the whole run indefinitely with 0%
          // CPU (observed 2026-07-15: TB recovery run stuck 7+ hours on this
          // exact path after a REVIEW_TIMEOUT with no further progress).
          try { await withTimeout(closeBrowser(), 30000, 'closeBrowser'); } catch(_) {}
          try { await withTimeout(setupBrowser(), 60000, 'setupBrowser'); } catch(_) {}
        }
        result = { success: false, error: e.message };
      }

      if (result.success) {
        state.processed.push(review.reviewId);
        runProcessed.push(review.reviewId);
      } else {
        state.failed.push(review.reviewId);
        runFailed.push(review.reviewId);
      }

      state.lastProcessed = review.reviewId;
      batchCount++;

      // Save state and commit after each batch
      if (batchCount >= CONFIG.batchSize) {
        saveState();
        commitChanges(state.processed.length);
        console.log(`\n─── Batch complete, state saved (${state.processed.length} processed) ───`);
        batchCount = 0;
      }

      // Delay between reviews
      if (i < reviews.length - 1) {
        await sleep(CONFIG.requestDelay);
      }
    }

    // Final state save and commit (force push to ensure all data lands)
    saveState();
    commitChanges(state.processed.length, true);

    // BRO-4273: record "loop finished, final checkpoint attempted" BEFORE
    // browser cleanup — runs 36493405907/36503960657 got this far, then hung
    // until the step's 12-min kill, and the pipeline verifier read that as a
    // crash. The poller's "Commit collected texts" step does the durable
    // push; this marker only says the collection work itself completed.
    if (timedOutReviews.length > 0) {
      console.log(`\n⏭ ${timedOutReviews.length} URL(s) skipped after the ${CONFIG.reviewTimeout / 1000}s per-URL timeout (retried next run):`);
      for (const r of timedOutReviews) console.log(`    - ${r.url || r.reviewId}`);
    }
    try {
      if (writeCollectSummary(process.env.COLLECT_SUMMARY_FILE, buildCollectSummary({
        processed: state.processed.length,
        failed: state.failed.length,
        timedOut: timedOutReviews,
      }))) {
        console.log(`  ✓ Collect summary written to ${process.env.COLLECT_SUMMARY_FILE}`);
      }
    } catch (e) {
      console.log(`  ⚠ Could not write collect summary: ${e.message}`);
    }

  } finally {
    collectorShuttingDown = true;
    // Bounded like every other closeBrowser() call site (BRO-4273).
    try { await withTimeout(closeBrowser(), 30000, 'closeBrowser'); } catch (_) {}
  }

  // Generate report
  generateReport();
}

/**
 * BRO-4273: once main() is done, node should exit by itself. If a stray
 * handle (an abandoned processReview() from a REVIEW_TIMEOUT, a Browserbase
 * CDP socket) keeps the event loop alive, exit anyway after a short grace
 * instead of idling until the CI step's timeout kills it. unref()'d, so it
 * never delays a clean exit. Every write in main() is synchronous, so
 * nothing in flight is lost.
 */
function exitIfStuckAfterMain(graceMs = 20000) {
  const t = setTimeout(() => {
    let handles = '';
    try { handles = ` (active: ${process.getActiveResourcesInfo().join(', ')})`; } catch (_) {}
    console.log(`\n⚠ Collection finished but open handles kept node alive ${graceMs / 1000}s — forcing exit${handles}`);
    process.exit(0);
  }, graceMs);
  t.unref();
}

module.exports = {
  reviewTimeoutMs, pushReviewTextsCheckpoint, commitChanges, extractTextFromHtml, findReviewsToProcess, dropLeasedReviews, updateReviewJson };

// Run (guarded so scripts/collect-review-texts.test.mjs can require() this
// file for pushReviewTextsCheckpoint() without kicking off a real collection
// run — see CLAUDE.md rule 15, test extraction pattern).
if (require.main === module) {
  main().then(() => exitIfStuckAfterMain()).catch(error => {
    console.error('Fatal error:', error);
    withTimeout(closeBrowser(), 30000, 'closeBrowser').catch(() => {}).finally(() => process.exit(1));
  });
}
