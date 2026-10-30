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
const { classifyTimeoutPage, isTimeoutUrl } = require('./lib/timeout-capsule');
const { applyExplicitCriticToUnknown } = require('./lib/explicit-critic-rename');
const { isBlockedReviewUrl } = require('./lib/domain-filters');
const { loadBlocklist, findBlockedEntry } = require('./lib/poller-blocklist');
const { isolateMultiShowSection, normSectionText, isolatedSectionWriteFields } = require('./lib/multi-show-section-extract');
const { findCrossShowOwners } = require('./lib/url-ownership');
const { extractArticleTextFromUrl, extractLsaByline } = require('./lib/article-extractor');
const { classifyReviewUrl } = require('./lib/non-review-url-patterns');
const { isUnresolvableRedirectUrl } = require('./lib/unresolvable-url');
const { recoverScoreFromHtml, existingHasScoreSignal, existingRatingCleared } = require('./lib/ingest-html-score');
const { INGEST_REFUSED_URL_REASONS } = require('./lib/non-review-url-patterns');
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
const { resolveCritic, nameFromAuthorUrl } = require('./lib/resolve-critic');
const { pageMentionsShowTitle } = require('./lib/submission-show-match');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');

const args = process.argv.slice(2);
function getArg(name) {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : null;
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

const showId = getArg('show');
// A WordPress photo-attachment url is ingested as its parent article (BRO-6486),
// here at the entry point so the fetch, blocklist, lookup and stale-merge check
// all see the url the writer will store.
const rawUrl = getArg('url');
const url = (rawUrl && require('./lib/non-review-url-patterns').wordpressAttachmentParentUrl(rawUrl)) || rawUrl;
if (url !== rawUrl) console.log(`↪ ${rawUrl} is a WordPress attachment page; ingesting its article ${url}`);
const outletArg = getArg('outlet');
const criticArg = nameFromAuthorUrl(getArg('critic'));
// Extra heading spelling for a multi-show post whose section heading misspells
// the title (interestedbystander's "Toera" for Torera, BRO-4658).
const sectionTitleArg = getArg('section-title');
const publishDateArg = getArg('publish-date');
// --date-window=YYYY-MM-DD,YYYY-MM-DD (BRO-4656): skip, before any write, a page
// whose publish date is missing or outside the window. Tour-stop discovery
// passes the engagement window so a review of an earlier visit, another
// production or the film never lands in the tour folder.
const dateWindow = (getArg('date-window') || '').split(',').filter(Boolean);
// --require-publish-date (BRO-5627): skip, before any write, a page with no
// resolvable publish date. The gap audit passes it when the show has an
// earlier-dated citation: an undated file bypasses the date-plausibility guard,
// so a revival's folder could hold (and later score) the prior run's review.
const requirePublishDate = hasFlag('require-publish-date');
// --caller=<slug> (or INGEST_CALLER): the pipeline that ran this ingest, stored
// as ingestSource so a bad file can be traced to its caller (BRO-6588: twelve
// A Few Good Men news pages all read source 'submit-review-form').
const callerArg = (() => {
  const raw = getArg('caller') || process.env.INGEST_CALLER || '';
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(raw) ? raw : null;
})();
const dryRun = hasFlag('dry-run');
// --data-dir: override the review-texts root, same flag block-review.js already
// exposes ("Override data/review-texts root (for tests)"). Flows to BOTH the
// blocklist lookup below and the writer, so a test can exercise the real script
// against a temp corpus instead of the live one.
const dataDirArg = getArg('data-dir');
// BRO-5874: read and write the review-texts git CHECKOUT, not a copy of it.
// data/review-texts IS the checkout on CI and in most worktrees — there
// resolveReviewTextsDir() returns exactly that path and nothing changes. On the
// owner's Mac it is a plain gitignored COPY and the clone is
// ~/broadway-review-texts, so a hardcoded join meant `git add` ran inside the
// Broadwayscore repo where that path is gitignored: every Mac-local --land
// failed its push with "paths are ignored by one of your .gitignore files" and,
// because landIngestedReviews() skips the dispatch on a failed push, the review
// sat local-only and unscored behind one warning line.
//
// Writing INTO the checkout (rather than writing to the copy and mirroring
// across) is deliberate. The copy on the Mac lags the clone badly — 1002 of
// 1857 sampled shared files differ, in llmScore, assignedScore, fullText,
// wrongProduction, duplicateOf and humanReviewScore — so copying from it would
// roll those back and resurrect upstream-deleted reviews, which is worse than
// the push failure being fixed. It also means the merge, dedup and collision
// guards now read the FRESH corpus instead of the stale snapshot.
//
// Trade-off: on the Mac data/review-texts does not receive the new file, so
// local audits reading it will not see it until ./scripts/setup-local-data.sh
// re-syncs. That copy is already 54% divergent, so this changes nothing about
// how much it can be trusted.
const reviewTextsDir = dataDirArg || resolveReviewTextsDir();
// unknownShowFolderRefused() (review-file-writer.js:299) stands its guard down
// for any dir that is not the hardcoded default, so pass the ids explicitly or
// moving off that default would silently allow a folder for an unknown show id.
const knownShowIds = () => showsData.shows.map((s) => s.id);
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
// --html-file=PATH: use HTML a caller already fetched (a browser session for a site the
// scraper chain cannot reach, e.g. talkinbroadway.com) instead of calling fetchPage.
const htmlFileArg = getArg('html-file');
// --archive-snapshot=YYYYMMDDHHMMSS (BRO-5874): read an EXISTING Wayback snapshot of --url through
// fetchPage for a site that blocks CI runners; the row keeps the original url. Never requests a new capture.
const archiveSnapshotArg = getArg('archive-snapshot');
// Exit code for "the page could not be read" (fetch error, no HTML, empty
// extraction). Refusals (blocked/non-review URL, blocklist, wrong show,
// write-guard) keep exit 1, so the workflow retries only what a retry can fix.
const EXIT_FETCH_FAILED = 3;

const { hasHelpFlag } = require('./lib/cli-help.js');

// --help must print usage and exit BEFORE any side effect (BRO-1711).
if (require.main === module && hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/ingest-review-from-url.js --show=ID --url=URL [--outlet=ID] [--critic=NAME] [--publish-date=YYYY-MM-DD] [--date-window=FROM,TO] [--require-publish-date] [--dry-run] [--data-dir=PATH] [--allow-non-review-url] [--section-title=HEADING] [--html-file=PATH] [--caller=SLUG] [--land]');
  process.exit(0);
}

if (!showId || !url) {
  console.error('Usage: node scripts/ingest-review-from-url.js --show=ID --url=URL [--outlet=ID] [--critic=NAME] [--publish-date=YYYY-MM-DD] [--date-window=FROM,TO] [--require-publish-date] [--dry-run] [--data-dir=PATH] [--allow-non-review-url] [--section-title=HEADING] [--html-file=PATH] [--caller=SLUG] [--land]');
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
  // BRO-4478: a Google /goto?url=CAE... redirect stub (or AMP/cache wrapper)
  // has no fetchable article; without this every fetch tier burned credits
  // and the run exited "fetch failed" with no actionable message. The writer
  // (BRO-4458) already refuses to file such a URL, so stop before fetching.
  if (isUnresolvableRedirectUrl(url)) {
    console.error(`Refusing to ingest — ${url.slice(0, 80)} is an unresolvable redirect/cache/non-http URL, not an article. Find the real article URL (search the outlet) and re-run with it.`);
    process.exit(1);
  }

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
    if (htmlFileArg) {
      html = fs.readFileSync(htmlFileArg, 'utf8');
    } else {
      let fetchUrl = url;
      if (archiveSnapshotArg) {
        fetchUrl = require('./lib/archive-snapshot-url').archiveSnapshotFetchUrl(url, archiveSnapshotArg);
        if (!fetchUrl) { console.error('--archive-snapshot needs a 14-digit YYYYMMDDHHMMSS timestamp and an http(s) --url'); process.exit(1); }
      }
      const r = await fetchPage(fetchUrl, { source: 'process-review-submission' });
      html = (r && (r.content || r.html || r.body)) || (typeof r === 'string' ? r : null);
    }
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

  // Time Out serves listing capsules at the same URL shape as its reviews; the
  // collector refuses them (BRO-5222), so this path must too (BRO-5134: the gap
  // audit ingested Midnight's capsule as a "review" and re-alerted hourly).
  if (!fetchFailure && isTimeoutUrl(url)) {
    const showYearM = String(showId || '').match(/-(\d{4})$/);
    const tp = classifyTimeoutPage({ html, critic: criticArg, showYear: showYearM ? Number(showYearM[1]) : null });
    if (tp.verdict === 'listing_capsule' || tp.verdict === 'wrong_critic') {
      console.log(`⚠️  Skipped: timeout-listing-capsule — ${tp.reason} — ${url}`);
      process.exit(0);
    }
  }

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
    // An unfetched page has no date to check; an undated stub is the very file
    // --require-publish-date exists to prevent.
    if (requirePublishDate && !publishDateArg) {
      // Expected, not a failure: exiting non-zero here would re-alarm every hourly audit run.
      console.log(`⚠️  Skipped: publish-date-unresolved — fetch failed (${reason}); no retry stub under --require-publish-date — ${url}`);
      process.exit(0);
    }
    const { buildRetryStubFields } = require('./lib/submission-retry-stub');
    const stubResult = createOrMergeReviewFile(showId, {
      outletId,
      outlet: outletName,
      criticName: criticArg || 'Unknown',
      url,
      source: 'submit-review-form',
      fields: { ...buildRetryStubFields(reason, { publishDate: publishDateArg }), ...(callerArg ? { ingestSource: callerArg } : {}) },
    }, { dryRun, reviewTextsDir, knownShowIds: knownShowIds() });
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
  const iso = isolateMultiShowSection(url, text, show.title, sectionTitleArg ? [sectionTitleArg] : []);
  if (iso.action === 'refuse') {
    console.error(`Refusing ingest: could not isolate a "${show.title}" section in multi-show post ${url}. Ingest manually or pass --section-title=<heading as the post spells it>.`);
    process.exit(1);
  }
  // A wrong --section-title would isolate another show's section; that section
  // must still name this show in its body.
  if (sectionTitleArg && iso.action === 'isolated' && !normSectionText(iso.text).includes(normSectionText(show.title))) {
    console.error(`Refusing ingest: the "${sectionTitleArg}" section of ${url} never mentions "${show.title}".`);
    process.exit(1);
  }
  text = iso.text;
  // A registration wall rendered into the body is not the review: drop the text so
  // the star-rating fallback below (or the extraction-failed exit) decides, instead of
  // scoring the stub (Telegraph Cinderella stub scored 86, BRO-6183).
  if (require('./lib/paywall-detector').hasRegistrationWallTail(text)) {
    console.error('Extracted body ends in a registration wall (sign-up form text); discarding it');
    text = '';
  }
  // Star-rating fallback: UK star outlets (The Stage, Telegraph, Times, …)
  // serve recent articles as a registration wall with the review body absent
  // from server HTML — but the page's own StarRating block is still present.
  // For these outlets the star IS the score (policy: 177/177 thestage reviews
  // scored from stars), so an empty text extraction with a recoverable star
  // is a score-only ingest, not a failure. Card 3b5637c5 (NYSM Live).
  // An archived page that yields only a meta description (< 1000 chars) is not the review: refuse
  // before any write so the 313-char stub is not re-stored as if recovered (BRO-5874).
  if (archiveSnapshotArg && (!text || text.length < 1000)) {
    console.error(`Archive snapshot ${archiveSnapshotArg} holds no review body (${text ? text.length : 0} chars extracted); refusing to write`);
    process.exit(EXIT_FETCH_FAILED);
  }
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
  // BRO-6588: then the byline date in the article text, as the collector does.
  const resolvedDate = require('./lib/ingest-publish-date').resolveIngestPublishDate({
    publishDateArg, html, url, text: hasBody ? text : null, stagePublishDate: stageMeta && stageMeta.publishDate,
  });
  const publishDate = resolvedDate.publishDate;
  if (resolvedDate.from === 'page' || resolvedDate.from === 'stage') {
    console.log(`  → Extracted publishDate from page metadata: ${publishDate}`);
  } else if (resolvedDate.from === 'text') {
    console.log(`  → Extracted publishDate from the byline text: ${publishDate}`);
  } else if (resolvedDate.reason === 'body-url-conflict') {
    console.log('  → Byline date disagrees with the URL path date: publishDate left empty for the rebuild backfill (BRO-5351)');
  }

  if (requirePublishDate && !publishDate) {
    // `Skipped: <reason>` is the ingest-skip-classify contract (expected rejection).
    console.log(`⚠️  Skipped: publish-date-unresolved — no publish date on the page and --require-publish-date is set — ${url}`);
    process.exit(0);
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
  if (resolvedDate.dateSource) fields.dateSource = resolvedDate.dateSource;
  // Which pipeline asked for this ingest (BRO-6588). The source stays
  // 'submit-review-form' because the writer's submission guards key on it.
  if (callerArg) fields.ingestSource = callerArg;
  // Human override for review-file-writer's submitted-non-review-url guard
  // (a real review on a ticket/listing host). Persists on the file as a
  // record of the override.
  if (allowNonReviewUrl) fields.allowNonReviewUrl = true;
  Object.assign(fields, isolatedSectionWriteFields(iso, show.title,
    findCrossShowOwners(url, showId, reviewTextsDir).filter((o) => o.blocking).map((o) => o.showId)));
  if (stageMeta && stageMeta.standfirst && stageMeta.standfirst.length >= 25) {
    fields.outletStandfirst = stageMeta.standfirst;
  }
  // BRO-4764: on the with-body path, never merge a freshly recovered rating onto
  // a file that already has a score signal (field-by-field merge would pair the
  // old score with the new normalized value/source).
  if (recoveredScore && !recoveredFromHtmlWithBody && existingRatingCleared(preExisting && preExisting.data)) {
    console.error(`Refusing score-only ingest: the existing file's rating was deliberately cleared (originalScoreCleared), and this page yields no article body to re-score from. Re-ingest with the article body, or un-clear the rating first.`);
    process.exit(1);
  }
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
  }, { dryRun, reviewTextsDir, knownShowIds: knownShowIds() });

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
    // BRO-5166: the merge never writes criticName, so an explicit --critic onto
    // an --unknown file always failed the check below. Name it through the
    // writer's guarded rename; a refusal still fails the check as before.
    if (criticArg) {
      const named = applyExplicitCriticToUnknown(result.filepath, landed, { showId, criticName: critic, url, pageText: text });
      if (named.applied) {
        console.log(`  ↑ Byline (--critic): ${path.basename(result.filepath)} → ${path.basename(named.newPath)}`);
        result.renamedFrom = result.filepath;
        result.filepath = named.newPath;
        result.action = 'updated';
        landed = JSON.parse(fs.readFileSync(result.filepath, 'utf8'));
      } else if (!['not-unknown-file', 'already-named', 'url-not-landed'].includes(named.reason)) {
        console.warn(`  ⚠ --critic not applied to ${path.basename(result.filepath)}: ${named.reason}`);
      }
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

  // BRO-4042: a merge into an existing file that leaves a body with no score
  // signal, which the scorer will also skip, must be visible, not silent
  // (see auditMergedReviewWithoutScore).
  if (!dryRun && result.action === 'updated' && result.filepath) {
    try {
      const { auditMergedReviewWithoutScore } = require('./lib/ingest-html-score');
      auditMergedReviewWithoutScore(JSON.parse(fs.readFileSync(result.filepath, 'utf8')), result.filepath, { show, submittedUrl: url });
    } catch (e) {
      console.warn(`  ⚠ no-score audit skipped: ${e.message}`);
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
        // Only a child this run wrote: a skipped, held or refused one is not ours to push or score.
        const WROTE_CHILD = new Set(['create', 'fill']);
        for (const c of fan.children) {
          const childFile = path.join(reviewTextsDir, c.showId, path.basename(result.filepath));
          if (WROTE_CHILD.has(c.action) && fs.existsSync(childFile)) { landPaths.push(childFile); landShowIds.push(c.showId); }
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
      // reviewTextsDir IS the checkout (BRO-5874, see its definition), so the
      // files are already staged where git runs and a rename is a real git
      // rename. An explicit --data-dir still flows through here: a test
      // pointing at a temp corpus pushes nothing, because that dir is not a
      // git repo, rather than reaching the real private repo.
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
