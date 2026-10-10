#!/usr/bin/env node
/**
 * ingest-review-from-url.js — Single-URL ingest for review submissions.
 *
 * Used by process-review-submission.yml after validate-review-submission.js
 * approves a /submit-review form entry. Replaces the previous
 * `collect-review-texts-v2.js --show=X --url=Y` invocation, which silently
 * ignored both flags and scanned the full backlog (cancelled at 15-min
 * timeout for issue #309).
 *
 * Pipeline:
 *   1. fetchPage(url) via the shared scraper (Bright Data → ScrapingBee →
 *      Playwright fallback chain).
 *   2. extractArticleTextFromUrl() to pull main body via outlet-specific
 *      patterns + generic fallbacks.
 *   3. Best-effort byline extraction from common <meta>/<a rel=author>/
 *      class=author markers — defaults to 'Unknown' so backfill-unknown-
 *      critics.js (every 6h via enrich-reviews.yml) can fill it in later.
 *   4. resolveCanonicalOutletId() to derive outletId from URL domain when
 *      not supplied by the caller.
 *   5. detectIngestCollision() + createOrMergeReviewFile() — same write
 *      path as scripts/ingest-manual-review.js, so collisions with stale
 *      wrongProduction files are surfaced rather than silently merged.
 *
 * Usage:
 *   node scripts/ingest-review-from-url.js \
 *     --show=schmigadoon-2026 \
 *     --url=https://frontmezzjunkies.com/.../schmigadoon-kicks-its-way-into-joy/ \
 *     [--outlet=frontmezzjunkies] \
 *     [--critic="Ross"] \
 *     [--publish-date=2026-05-01] \
 *     [--dry-run]
 *
 * Exit codes: 0 on success or skip (review already exists, no-op merge),
 * 3 when the page could not be read (fetch error, no HTML, empty extraction;
 * with --stub-on-failure a retry stub is written and it exits 0 instead),
 * 1 on hard failure (fetch error, extraction empty, collision-blocked, the
 * write-guard silently refusing/redirecting an update — BRO-3182 — or a
 * merge-into-existing that reported "Updated" without actually landing the
 * intended url/fullText/criticName — BRO-3790).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { fetchPage } = require('./lib/scraper');
const { isBlockedReviewUrl } = require('./lib/domain-filters');
const { loadBlocklist, findBlockedEntry } = require('./lib/poller-blocklist');
const { isolateMultiShowSection } = require('./lib/multi-show-section-extract');
const { extractArticleTextFromUrl, extractPublishDate, extractLsaByline } = require('./lib/article-extractor');
const { classifyReviewUrl } = require('./lib/non-review-url-patterns');
const { recoverScoreFromHtml, existingHasScoreSignal } = require('./lib/ingest-html-score');
// classifyReviewUrl reasons that never occur on a scored review in the corpus
// (checked 2026-09-28); see the refusal below.
const INGEST_REFUSED_URL_REASONS = new Set([
  'ticketing-reseller', 'ticketing-listing', 'venue-production-page',
  'production-database-listing', 'access-listings-page', 'talent-agency-credit-page',
  'institutional-press-release', 'pr-firm-press-release', 'ugc-platform',
]);
const { stripTrailingJunk } = require('./lib/text-cleaning');
const { resolveCanonicalOutletId, _parseDomain, _buildDomainMap, provisionalOutletIdFromHost, lookupOutletForHost } = require('./lib/outlet-canonicalize');
const { getOutletDisplayName, findExistingReviewFile, normalizeCritic, resolveOutletFromUrlIfPathInformed } = require('./lib/review-normalization');
const { createOrMergeReviewFile, WRITE_GUARD_REFUSED_REASONS } = require('./lib/review-file-writer');
const { findStaleMergeFields, isPreExistingContentBad } = require('./lib/stale-merge-check');
const { buildManualReviewFields, detectIngestCollision } = require('./lib/manual-review-fields');
const { safeWriteReview } = require('./lib/review-write-guard');
const { applyMultiShowFanoutToFile } = require('./lib/multi-show-review-fanout');
const { isStalePublishDate } = require('./lib/stale-publish-date');
const { extractByline } = require('./lib/byline-extraction');
const { resolveCritic } = require('./lib/resolve-critic');
const { pageMentionsShowTitle } = require('./lib/submission-show-match');

const args = process.argv.slice(2);
function getArg(name) {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : null;
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

const showId = getArg('show');
const url = getArg('url');
const outletArg = getArg('outlet');
const criticArg = getArg('critic');
const publishDateArg = getArg('publish-date');
// --date-window=YYYY-MM-DD,YYYY-MM-DD (BRO-4656): skip, before any write, a page
// whose publish date is missing or outside the window. Tour-stop discovery
// passes the engagement window so a review of an earlier visit, another
// production or the film never lands in the tour folder.
const dateWindow = (getArg('date-window') || '').split(',').filter(Boolean);
const dryRun = hasFlag('dry-run');
// --data-dir: override the review-texts root, same flag block-review.js already
// exposes ("Override data/review-texts root (for tests)"). Flows to BOTH the
// blocklist lookup below and the writer, so a test can exercise the real script
// against a temp corpus instead of the live one.
const reviewTextsDir = getArg('data-dir')
  || path.join(__dirname, '..', 'data', 'review-texts');
const forceClearStale = hasFlag('force-clear-stale-flag');
const allowNonReviewUrl = hasFlag('allow-non-review-url');
// Provisional onboarding: use --outlet verbatim as a slug WITHOUT fuzzy alias
// resolution. For aggregator-cited outlets not yet in the registry (the ctvoice /
// New York Notebook class, girl-interrupted 2026-06-05), normalizeOutlet() can
// mis-resolve a free-form name to a wrong registered canonical (e.g.
// "new-york-notebook" -> "vulture" via a fuzzy New York Magazine match), which then
// trips the domain-mismatch guard and drops the review. With --provisional the
// caller has already derived a domain-safe slug and wants it written as-is.
// `let`, not const: the no---outlet branch below auto-derives a provisional id
// for an unregistered domain and flips this on, so the write path stamps the
// record as provisional exactly as an explicit --provisional call would.
let provisional = hasFlag('provisional');
// BRO-4431: on a fetch/extraction failure, save a URL-only stub queued for
// automatic retry (collector cadence, T1/T2 silent-gap audit, paywall rating
// salvage, aggregator star relay) instead of exiting 1 and dropping the
// review. process-review-submission.yml passes this on its final attempt.
const stubOnFailure = hasFlag('stub-on-failure');
// BRO-4908: --land pushes the written file to the review-texts repo and dispatches
// per-show scoring. Without it the file is only on local disk: CI scores from a
// fresh clone, so the review sits unscored until a later rebuild self-heals.
const land = hasFlag('land');
// Exit code for "the page could not be read" (fetch error, no HTML, empty
// extraction). Refusals (blocked/non-review URL, blocklist, wrong show,
// write-guard) keep exit 1, so the workflow retries only what a retry can fix.
const EXIT_FETCH_FAILED = 3;

const { hasHelpFlag } = require('./lib/cli-help.js');

// --help must print usage and exit BEFORE any side effect (BRO-1711).
if (require.main === module && hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/ingest-review-from-url.js --show=ID --url=URL [--outlet=ID] [--critic=NAME] [--publish-date=YYYY-MM-DD] [--date-window=FROM,TO] [--dry-run] [--data-dir=PATH] [--allow-non-review-url] [--land]');
  process.exit(0);
}

if (!showId || !url) {
  console.error('Usage: node scripts/ingest-review-from-url.js --show=ID --url=URL [--outlet=ID] [--critic=NAME] [--publish-date=YYYY-MM-DD] [--date-window=FROM,TO] [--dry-run] [--data-dir=PATH] [--allow-non-review-url] [--land]');
  process.exit(1);
}

// Verify show exists before doing any expensive work.
const showsData = require('../data/shows.json');
const show = showsData.shows.find((s) => s.id === showId);
if (!show) {
  console.error(`Show not found: ${showId}`);
  process.exit(1);
}

(async () => {
  console.log(`Ingesting single review: ${showId} ${url}`);

  // Refuse known non-review domains (ticket/listing/social/reference/venue/
  // PR-firm — domain-filters.js's isBlockedReviewUrl) BEFORE fetching. This is
  // the /submit-review path's only line of defense against a classification
  // miss by validate-review-submission.js's LLM gate — BRO-2712: a venue
  // "what's on" page (southbank.london) and a PR firm's press release
  // (spincyclenyc.com) both got an "approve" verdict from that LLM and landed
  // here with no other guard in the way. Excluding them later at scoring time
  // (isBlockedReviewUrl is also the rebuild's canonical exclusion check) still
  // leaves a written-but-unscored review file and an approval email sent to
  // the submitter; refusing at ingest is the cheaper, earlier stop.
  if (isBlockedReviewUrl(url)) {
    console.error(`Refusing to ingest — ${url} matches a known non-review domain (ticket/listing/social/reference/venue/PR-firm). See scripts/lib/domain-filters.js.`);
    process.exit(1);
  }

  // Listing / ticketing / venue pages the shared URL classifier recognizes
  // (BRO-4185 G: ~100 such files were written through /submit-review and the
  // census, e.g. tickpick, ents24, lovetheatre, westend.com/shows). Only these
  // reasons refuse: the classifier's broader candidate-filter reasons
  // (non-review-host, aggregator-internal-nav) also match 300+ scored real
  // reviews (WNYC, 4Columns, BroadwayWorld review articles), so they stay out.
  {
    const verdict = classifyReviewUrl(url);
    if (!verdict.ok && INGEST_REFUSED_URL_REASONS.has(verdict.reason)) {
      console.error(`Refusing to ingest — ${url} is a ${verdict.reason} page, not a review (scripts/lib/non-review-url-patterns.js classifyReviewUrl).`);
      process.exit(1);
    }
  }

  // Per-show blocklist — honor _blocklist.json, the sidecar whose WHOLE PURPOSE
  // is making an operator's deletion stick (scripts/lib/poller-blocklist.js).
  // gather-reviews.js has honored it since the Rocky Horror 2026-04-23 incident,
  // but THIS path never did — and this is the path audit-aggregator-gap's
  // auto-recovery drives (audit-t1-silent-gaps.js recoverFromOwnUrl execs this
  // script) as well as the public /submit-review form. BRO-3247: a
  // wrong-production Lighting & Sound America review of a DIFFERENT "Safe House"
  // (the 2025 Enda Walsh production at St. Ann's Warehouse) was deleted from
  // safe-house-off-broadway-2026 on 2026-09-14 and re-ingested here within
  // hours, twice, because deleting a file leaves nothing behind that this
  // entry point consults. Refuse before fetching so a blocked URL also stops
  // burning scraper credit on every audit cycle.
  const _blocked = findBlockedEntry(loadBlocklist(path.join(reviewTextsDir, showId)), url);
  if (_blocked) {
    console.error(`Refusing to ingest — ${url} is blocklisted for ${showId}: ${_blocked.reason || 'no reason recorded'}. See ${path.join(reviewTextsDir, showId, '_blocklist.json')} (scripts/block-review.js manages it).`);
    process.exit(1);
  }

  let html;
  let fetchFailure = null;
  try {
    const r = await fetchPage(url, { source: 'process-review-submission' });
    html = (r && (r.content || r.html || r.body)) || (typeof r === 'string' ? r : null);
  } catch (e) {
    console.error(`Fetch failed: ${e.message}`);
    if (!stubOnFailure) process.exit(EXIT_FETCH_FAILED);
    fetchFailure = `fetch failed: ${e.message}`;
  }
  if (!fetchFailure && (!html || typeof html !== 'string' || html.length < 500)) {
    console.error(`Fetch returned no usable HTML (got ${html ? html.length : 0} chars)`);
    if (!stubOnFailure) process.exit(EXIT_FETCH_FAILED);
    fetchFailure = `no usable HTML (${html ? html.length : 0} chars)`;
  }
  if (fetchFailure) html = '';

  // Outlet resolution runs BEFORE the text-extraction gate: the star-rating
  // fallback below needs outletId to pick an extractor, and none of this
  // block depends on the extracted text.
  let outletId;
  let outletName;
  if (outletArg && provisional) {
    // Provisional onboarding — trust the caller's domain-derived slug as-is.
    // The domain-mismatch guard (validateUrlDomain) passes because an
    // unregistered slug has no expected domain to mismatch (url-discovery.js:841).
    // Do NOT call getOutletDisplayName here — it fuzzy-normalizes the slug and can
    // resolve a provisional id to a wrong registered display (e.g. "newyorknotebook"
    // -> "Vulture"). Humanize the slug directly; the human onboarding step sets the
    // canonical display name when the outlet is added to the registry.
    outletId = outletArg;
    outletName = outletArg
      .split('-')
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    console.warn(`⚠️  provisional outlet "${outletId}" (not in registry) — onboard to outlet-registry.json after review.`);
  } else if (outletArg) {
    const resolved = resolveCanonicalOutletId({ outletArg, url });
    if (resolved.warning) console.warn(`⚠️  ${resolved.warning}`);
    outletId = resolved.outletId;
    outletName = resolved.displayName;
  } else {
    // No --outlet supplied — derive from URL domain via the registry's
    // domain map. This is the common path for /submit-review where the
    // user provided a free-form outlet name we don't pass through.
    // Path-informed edition splits (timeout.com/london vs /newyork) first:
    // the domain map below can only ever call a shared host "ambiguous" and
    // bail, which used to mean a bare timeout.com submission with no
    // --outlet needlessly refused instead of resolving by path (BRO-4153).
    const pathResolved = resolveOutletFromUrlIfPathInformed(url);
    const domain = _parseDomain(url);
    const { ambiguous } = _buildDomainMap();
    // Parent-domain aware: newspaper.dailymail.com -> daily-mail (issue #908).
    const registeredOutlet = pathResolved ? pathResolved.outletId : (domain ? lookupOutletForHost(domain) : null);
    if (registeredOutlet) {
      outletId = registeredOutlet;
      outletName = getOutletDisplayName(outletId) || outletId;
    } else if (!ambiguous.has(domain)) {
      // Unregistered domain — derive a provisional outlet instead of bailing.
      // Scope note (corrected after review, 2026-08-09): the gap audit does NOT
      // reach this branch — it always passes --outlet=<provId> --provisional
      // itself (audit-show-review-gap.js ingestMissingUrl). This branch serves
      // the callers that DON'T pre-resolve an outlet: /submit-review and manual
      // CLI runs, which previously exited 1 and dropped the review entirely.
      // Owner rule 2026-08-09: "1minutecritic is a real theater review site.
      // The others probably are too. All should be collected. We tier weight
      // them so you don't get to omit them just because they're hard." Tier
      // weighting is the correct defence against a low-quality outlet;
      // refusing to collect it is not.
      // Ambiguous domains still bail: a shared host (multi-outlet CMS) would
      // attach the review to a guessed outlet, which is a misattribution, not a
      // coverage win.
      const provisionalId = provisionalOutletIdFromHost(domain);
      if (!provisionalId) {
        console.error(`Could not resolve or derive an outlet from URL ${url} (domain="${domain}"). Pass --outlet=ID explicitly.`);
        process.exit(1);
      }
      outletId = provisionalId;
      outletName = provisionalId
        .split('-')
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      provisional = true;
      console.warn(`⚠️  provisional outlet "${outletId}" auto-derived from ${domain} (not in registry) — onboard to outlet-registry.json after review.`);
    } else {
      console.error(`Could not resolve outlet from URL ${url} (domain="${domain}" is ambiguous — shared by multiple registered outlets). Pass --outlet=ID explicitly.`);
      process.exit(1);
    }
  }

  // stripTrailingJunk (newsletter promos, login prompts, site footers) runs
  // in every other collection/recovery path (collect-review-texts.js,
  // recover-serp-text.js, recover-wayback-reviews.js, recover-wsj-*.js) but
  // was missing here — this is the one entry point the public /submit-review
  // form and the >24h stuck-review backstop (audit-t1-silent-gaps.js
  // recoverFromOwnUrl) both drive, so site chrome landed unstripped in
  // fullText and fed straight into the LLM scoring prompt (BRO-2605 ship-check
  // finding).
  // BRO-4431 retry stub: written after outlet resolution (which needs no
  // HTML) so the stub is filed under the right outlet.
  const writeRetryStubAndExit = (reason) => {
    // A windowed ingest (tour-stop discovery) cannot check an unfetched page's
    // date, so it never files an undated stub; the caller retries the URL.
    if (dateWindow.length === 2) {
      console.error(`❌ Fetch failed (${reason}); no retry stub under --date-window — ${url}`);
      process.exit(3);
    }
    const { buildRetryStubFields } = require('./lib/submission-retry-stub');
    const stubResult = createOrMergeReviewFile(showId, {
      outletId,
      outlet: outletName,
      criticName: criticArg || 'Unknown',
      url,
      source: 'submit-review-form',
      fields: buildRetryStubFields(reason, { publishDate: publishDateArg }),
    }, { dryRun, reviewTextsDir });
    if (stubResult.guardRefused === true || WRITE_GUARD_REFUSED_REASONS.has(stubResult.reason)) {
      console.error(`\n❌ Retry stub refused by the write guard (${stubResult.reason})`);
      process.exit(1);
    }
    console.log(`⏳ Queued for retry (${reason}): ${stubResult.filepath || stubResult.reason || stubResult.action}`);
    process.exit(0);
  };
  if (fetchFailure) writeRetryStubAndExit(fetchFailure);

  let text = stripTrailingJunk(extractArticleTextFromUrl(html, url, criticArg));
  // Multi-show blog posts (interestedbystander): keep only THIS show's section,
  // and refuse rather than score other shows' paragraphs into the file (BRO-4387).
  const iso = isolateMultiShowSection(url, text, show.title);
  if (iso.action === 'refuse') {
    console.error(`Refusing ingest: could not isolate a "${show.title}" section in multi-show post ${url}. Ingest manually or pass the correct show title.`);
    process.exit(1);
  }
  text = iso.text;
  // Star-rating fallback: UK star outlets (The Stage, Telegraph, Times, …)
  // serve recent articles as a registration wall with the review body absent
  // from server HTML — but the page's own StarRating block is still present.
  // For these outlets the star IS the score (policy: 177/177 thestage reviews
  // scored from stars), so an empty text extraction with a recoverable star
  // is a score-only ingest, not a failure. Card 3b5637c5 (NYSM Live).
  let recoveredScore = null;
  if (!text || text.length < 200) {
    recoveredScore = recoverScoreFromHtml(html, '', outletId, show.title);
    // With no body there is no content-based wrong-show signal left for the
    // rebuild guards to scan, so require the show's title to appear somewhere
    // in the raw page HTML (normalized: punctuation-insensitive) before
    // accepting a score-only ingest — this path is reachable from the public
    // /submit-review form and automated SERP ingest.
    if (recoveredScore) {
      if (!pageMentionsShowTitle(html, show.title)) {
        console.error(`Score-only fallback refused: show title "${show.title}" not found in page HTML — cannot verify this is the right show without body text.`);
        process.exit(1);
      }
    }
    if (!recoveredScore) {
      console.error(`Article extraction returned ${text ? text.length : 0} chars — pattern may be missing for this outlet. Add an entry to scripts/lib/article-extractor.js PATTERNS.`);
      if (stubOnFailure) writeRetryStubAndExit(`extraction returned ${text ? text.length : 0} chars (paywall/bot wall or missing pattern)`);
      process.exit(EXIT_FETCH_FAILED);
    }
    console.log(`  → Body extraction empty (${text ? text.length : 0} chars) — recovered explicit rating from page HTML: ${recoveredScore.originalScore} (${recoveredScore.normalizedScore}/100) [${recoveredScore.source}]`);
  }
  const hasBody = !!(text && text.length >= 200);
  // BRO-4764: a normal ingest used to skip the outlet extractors, so a rating
  // that lives only in the HTML (1minutecritic's alt="4 star review") was never
  // recorded and the review missed its star band. The routing block below
  // handles the result exactly like the score-only path above.
  // Same show-title check the no-body path applies, since the extractors read
  // the whole page (related-post widgets, sidebar star images).
  let recoveredFromHtmlWithBody = false;
  if (hasBody && !recoveredScore && pageMentionsShowTitle(html, show.title)) {
    recoveredScore = recoverScoreFromHtml(html, text, outletId, show.title);
    recoveredFromHtmlWithBody = !!recoveredScore;
  }

  // For LSA, prefer the in-body "--Name" sign-off over the publisher meta tag.
  const lsaCritic = hasBody && /lightingandsoundamerica\.com/i.test(url) ? extractLsaByline(text) : null;
  // The Stage's walled page has no generic byline/date metadata, but its own
  // markup carries byline, date and standfirst above the registration wall
  // (walled-page-meta.js). Without this, Stage submissions landed as
  // 'Unknown' with no date or quote (Deep Heat Rivalry, 2026-09-23).
  const { extractTheStageArticleMeta, isTheStageUrl } = require('./lib/walled-page-meta');
  const stageMeta = isTheStageUrl(url) ? extractTheStageArticleMeta(html) : null;
  const critic = resolveCritic({
    criticArg,
    lsaCritic,
    byline: extractByline(html),
    stageCritic: stageMeta && stageMeta.criticName,
    outletEntry: (require('../data/outlet-registry.json').outlets || {})[outletId],
  });

  // Page-date extraction: when --publish-date wasn't supplied, pull it from
  // standard CMS metadata (article:published_time / JSON-LD / <time>). Without
  // this the review lands with publishDate:undefined, which fails-open through
  // the anticipatory-pre-opening gate and weakens temporal wrong-production
  // detection. (1minutecritic HR + Maids incident, 2026-05-28.)
  const publishDate = publishDateArg || extractPublishDate(html, url) || (stageMeta && stageMeta.publishDate) || null;
  if (!publishDateArg && publishDate) {
    console.log(`  → Extracted publishDate from page metadata: ${publishDate}`);
  }

  if (dateWindow.length === 2) {
    const d = publishDate ? String(publishDate).slice(0, 10) : null;
    if (!d || d < dateWindow[0] || d > dateWindow[1]) {
      console.log(`⏭  Skipped: publish date ${d || 'unknown'} outside --date-window ${dateWindow[0]}..${dateWindow[1]} — ${url}`);
      process.exit(0);
    }
  }

  console.log(`╔══════════════════════════════════════════════════╗`);
  console.log(`║  Show:    ${show.title} (${showId})`);
  console.log(`║  Outlet:  ${outletName} (${outletId})`);
  console.log(`║  Critic:  ${critic}${criticArg ? '' : ' (extracted)'}`);
  console.log(`║  URL:     ${url}`);
  console.log(`║  Text:    ${hasBody ? `${text.length} chars` : `none — score-only (${recoveredScore.originalScore})`}`);
  if (publishDate) console.log(`║  Pub:     ${publishDate}`);
  console.log(`╚══════════════════════════════════════════════════╝`);

  // Same collision pre-check as ingest-manual-review.js. Stale wrongProduction
  // file at the same outletId+criticName slug is the failure that bit issue
  // #309 (April 4 preview blocked May 1 review). Surface it here rather than
  // silently merging the new URL into the wrongProduction file.
  // Honors --data-dir like every other corpus access in this script, so a test
  // run against a temp corpus cannot force-write live review metadata.
  const showDir = path.join(reviewTextsDir, showId);

  const collision = detectIngestCollision({
    showDir,
    outletId,
    criticName: critic,
    url,
    publishDate: publishDate,
    // Revival/returning-production carve-out: a fresh review in this show's opening
    // window must not be blocked by a prior-production file (2026-07-04 WE fix).
    openingDate: show.openingDate,
    // Other-production carve-out (BRO-4271): a flagged prior-production file
    // under a different filename no longer blocks this show's own review.
    show,
    forceClearStale,
  });
  if (!collision.ok) {
    console.error(`\n❌ Refusing to ingest — collision with ${collision.file}`);
    console.error(`   reason: ${collision.reason}`);
    console.error(`   detail: ${JSON.stringify(collision.detail, null, 2)}`);
    console.error(`\nManual remediation required: rename or clear the existing file.`);
    process.exit(1);
  }

  // Stale publishDate self-heal (BRO-462): this exact URL was just re-fetched
  // and confirmed to be the show's own review page (title-matched for the
  // score-only path above; wrong-show/wrong-production guards cover the
  // full-text path downstream), and the collision check above already passed
  // — this ingest is going ahead, so it's safe to also correct the existing
  // file's metadata. findExistingReviewFile returns { path, filename, data },
  // not a path string.
  //
  // An OLD publishDate already on file may be a leftover from a since-
  // corrected URL (a prior production's review page) — provably too early
  // for this show's run. review-guards.js's explainExclusion() mirror doesn't
  // model rebuild-all-reviews.js's date guard, so a stale date like this
  // silently excludes the file from every future rebuild with no canonical
  // predicate ever flagging it. Two cases:
  //   - a fresh publishDate WAS recovered this run: correct the file directly
  //     rather than relying on the normal merge below, which only fills BLANK
  //     fields and would never overwrite a stale-but-truthy value (review-
  //     file-writer.js _mergeIntoExisting's `!existing[key]` guard) — so a
  //     successful re-scrape could never actually fix this on its own.
  //   - no fresh date was recovered: clear the stale value rather than leave
  //     a provably-wrong date in place for a human to rediscover the gap.
  // Shared with the post-write stale-merge verification below (BRO-3790) —
  // one lookup, same identity, same file: this is the pre-write snapshot of
  // whatever createOrMergeReviewFile is about to merge into (or null, if
  // this ingest will create a new file).
  const preExisting = findExistingReviewFile(showDir, outletId, critic, url);
  if (
    preExisting &&
    preExisting.data.publishDate &&
    !preExisting.data.allowEarlyDate &&
    isStalePublishDate({ existingPublishDate: preExisting.data.publishDate, show })
  ) {
    const correctedValue = publishDate || null;
    console.warn(`  ⚠️  Existing publishDate "${preExisting.data.publishDate}" fails the date guard for this show's window — ${correctedValue ? `correcting to "${correctedValue}"` : 'clearing (no fresh date recovered)'}`);
    if (!dryRun) {
      const updated = {
        ...preExisting.data,
        publishDate: correctedValue,
        previousPublishDate: preExisting.data.publishDate,
        stalePublishDateClearedAt: new Date().toISOString(),
        stalePublishDateClearedBy: 'ingest-review-from-url.js',
      };
      safeWriteReview(preExisting.path, updated, { force: true });
    }
  }

  // operatorTrust:false — a URL ingest (automated audit-aggregator-gap, or the
  // public submit-review-form) is NOT an operator vouching for the review. It must
  // stay subject to wrong-production / cross-market / date guards. Stamping the
  // operator override set here made machine-ingested aggregator URLs immune to
  // every guard (2026-06-21 contamination; Notion 386637c5). Genuine operator
  // entry with a typed score goes through ingest-manual-review.js (operatorTrust
  // default true).
  const fields = buildManualReviewFields({
    humanScore: null,
    provisional: false,
    fullText: hasBody ? text : null,
    originalScore: null,
    originalScoreSource: null,
    publishDate: publishDate,
    operatorTrust: false,
  });
  // Human override for review-file-writer's submitted-non-review-url guard
  // (a real review on a ticket/listing host). Persists on the file as a
  // record of the override.
  if (allowNonReviewUrl) fields.allowNonReviewUrl = true;
  if (stageMeta && stageMeta.standfirst && stageMeta.standfirst.length >= 25) {
    fields.outletStandfirst = stageMeta.standfirst;
  }
  // BRO-4764: on the with-body path, never merge a freshly recovered rating onto
  // a file that already has a score signal (field-by-field merge would pair the
  // old score with the new normalized value/source).
  if (recoveredFromHtmlWithBody && existingHasScoreSignal(preExisting && preExisting.data)) {
    console.log(`  → Existing file already has a score signal — not merging the HTML-recovered rating (${recoveredScore.originalScore})`);
    recoveredScore = null;
  } else if (recoveredFromHtmlWithBody) {
    console.log(`  → Recovered explicit rating from page HTML: ${recoveredScore.originalScore} (${recoveredScore.normalizedScore}/100) [${recoveredScore.source}]`);
  }
  if (recoveredScore) {
    // Route through setExtractedScore, never hand-set originalScore: an
    // extractor whose source is an aggregator tag (e.g. lbo-css-stars) must
    // land in aggregatorStars, not originalScore — the contamination guards
    // downstream key on scoreSource and would miss a hand-set field.
    const { setExtractedScore } = require('./lib/score-routing');
    const routed = setExtractedScore(fields, {
      value: recoveredScore.originalScore,
      normalizedValue: recoveredScore.normalizedScore,
      source: recoveredScore.source,
    });
    fields.scoreExtractedFrom = 'scraped-html';
    fields.scoreRecoveredAt = new Date().toISOString();
    console.log(`  → Score routed to ${routed.field}`);
  }

  const result = createOrMergeReviewFile(showId, {
    outletId,
    outlet: outletName,
    criticName: critic,
    url,
    source: 'submit-review-form',
    fields,
    // BRO-4431: this is one explicit url, so a longer copy of the same
    // article may replace a truncated stored body (issue 908).
    replaceBadBody: true,
  }, { dryRun, reviewTextsDir });

  // BRO-3790: createOrMergeReviewFile's merge-into-existing path only fills
  // BLANK fields (review-file-writer.js _mergeIntoExisting) — a merge onto a
  // file whose url/criticName/fullText is already non-blank silently keeps
  // the old value, whether the writer reports 'updated' (something else
  // changed, e.g. sources[]) or 'skipped: no-changes' (nothing did) — both
  // exit 0 today with no signal that the intended correction never landed.
  // Verify it, whenever a file was touched/matched and the write wasn't
  // already refused by a guard (that already exits 1 below on its own, more
  // specific, terms).
  //
  //   - url: always checked. It's an exact-identity field with no extraction
  //     non-determinism risk, and the writer's own maybeUpgradeUrl already
  //     refuses to swap it onto a file with good content BY DESIGN — the
  //     same "needs a human" situation audit-show-review-gap.js's
  //     STALE-SLUG comment documents — so flagging that refusal here is
  //     correct, not a false positive.
  //   - fullText: only checked when the file actually needed fixing BEFORE
  //     this write (preBadContent, mirroring maybeUpgradeUrl's own
  //     badContent gate exactly). A fresh re-extraction of an
  //     ALREADY-complete file can differ in incidental ways (site chrome,
  //     rotating ad copy) without the stored body being wrong — that's a
  //     legitimate preserved value, not staleness, and flagging it would be
  //     a false positive with nothing to correct.
  //   - criticName: only checked when the caller passed --critic explicitly
  //     (an auto-extracted byline is best-effort, not an assertion the
  //     caller is making), compared via normalizeCritic so a case/whitespace
  //     difference on the SAME critic never false-flags. criticName is
  //     never merged by the writer at all — it's an identity key, not a
  //     mergeable field (review-file-writer.js never assigns
  //     existing.criticName on merge) — so this explicit-ask path is the
  //     only way a stale byline can ever be caught.
  if (result.action !== 'new' && result.filepath && !dryRun
      && !(result.guardRefused === true || WRITE_GUARD_REFUSED_REASONS.has(result.reason))) {
    const preBadContent = isPreExistingContentBad(preExisting);
    const intended = { url };
    if (hasBody && preBadContent) intended.fullText = text;
    let landed;
    try {
      landed = JSON.parse(fs.readFileSync(result.filepath, 'utf8'));
    } catch (e) {
      console.error(`\n❌ Could not re-read ${result.filepath} to verify the write landed: ${e.message}`);
      process.exit(1);
    }
    if (criticArg) {
      intended.criticName = normalizeCritic(criticArg);
      landed = { ...landed, criticName: normalizeCritic(landed.criticName) };
    }
    const staleFields = findStaleMergeFields(intended, landed);
    if (staleFields.length > 0) {
      console.error(`\n❌ Stale merge: ${staleFields.join(', ')} still hold a pre-existing value at ${result.filepath} that does not match this ingest — merge-into-existing only fills blank fields, it does not correct a non-blank-but-wrong one. Manual field correction needed.`);
      process.exit(1);
    }
  }

  // BRO-4431: a multi-show article (Vulture/New Yorker double reviews,
  // Theatrely capsule round-ups) is filed under every show it reviews, not
  // only the one it was submitted for.
  const landPaths = result.filepath ? [result.filepath] : [];
  const landShowIds = [];
  if (result.renamedFrom) landPaths.push(result.renamedFrom, path.dirname(result.filepath));
  if (!dryRun && result.filepath && (result.action === 'new' || result.action === 'updated')) {
    try {
      const fan = applyMultiShowFanoutToFile(result.filepath, { reviewTextsDir });
      if (fan.applied) {
        for (const c of fan.children) {
          const childFile = path.join(reviewTextsDir, c.showId, path.basename(result.filepath));
          if (fs.existsSync(childFile)) { landPaths.push(childFile); landShowIds.push(c.showId); }
        }
        console.log(`  ↔ Multi-show article (${fan.strategy}): own section kept, ${fan.children.map((c) => `${c.showId}=${c.action}`).join(', ')}`);
      }
    } catch (e) {
      console.warn(`  ⚠ multi-show fan-out failed: ${e.message}`);
    }
  }

  if (result.action === 'new') {
    console.log(`✅ Created: ${result.filepath}`);
  } else if (result.action === 'updated') {
    console.log(`✅ Updated: ${result.filepath}`);
  } else {
    console.log(`⚠️  Skipped: ${result.reason || result.action}`);
    // BRO-3182: 'no-changes'/'onMerge-aborted' are genuine no-ops (nothing
    // new to write). But when createOrMergeReviewFile's own write-guard
    // refused or redirected the write (date-implausible/cross-market
    // quarantine, a flagged-file collision), nothing landed on disk despite
    // an operator-visible ingest request — that must fail loudly, not report
    // success by omission. `guardRefused` is the authoritative signal (a
    // caller checking it needn't track every possible `reason` string as the
    // guard's set of refusal reasons grows); WRITE_GUARD_REFUSED_REASONS is
    // kept as a documented enumeration/fallback for older-shaped results.
    if (!dryRun && (result.guardRefused === true || WRITE_GUARD_REFUSED_REASONS.has(result.reason))) {
      console.error(`\n❌ Write-guard refused the write — nothing changed on disk (${result.reason})${result.quarantinedPath ? `\n   quarantined to: ${result.quarantinedPath}` : ''}`);
      process.exit(1);
    }
  }

  if (!dryRun && result.filepath && (result.action === 'new' || result.action === 'updated')) {
    if (land) {
      console.log('\nLanding (push review-texts, then dispatch scoring)...');
      const { landIngestedReviews } = require('./lib/land-ingested-reviews');
      const landed = landIngestedReviews({
        showId, extraShowIds: landShowIds, reviewTextsDir, touchedPaths: landPaths, newReviews: 1,
        message: `ingest-review-from-url: 1 review for ${showId}`,
        only: ['llm-ensemble-score.yml'],
      });
      if (!landed.push.pushed || landed.dispatched.some((d) => !d.ok)) {
        console.error('❌ --land did not complete: review is NOT pushed/queued for scoring.');
        process.exit(1);
      }
    } else if (!process.env.CI) {
      console.log(`⚠️  Not scored yet: file is local only. Re-run with --land, or push review-texts and run: gh workflow run llm-ensemble-score.yml -f show_id=${showId}`);
    }
  }

  console.log('Done.');
})().catch((e) => {
  console.error('Ingest failed:', e.stack || e.message);
  process.exit(1);
});
