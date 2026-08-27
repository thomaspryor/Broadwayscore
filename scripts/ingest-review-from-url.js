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
 * 1 on hard failure (fetch error, extraction empty, collision-blocked).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { fetchPage } = require('./lib/scraper');
const { extractArticleTextFromUrl, extractPublishDate, extractLsaByline } = require('./lib/article-extractor');
const { resolveCanonicalOutletId, _parseDomain, _buildDomainMap, provisionalOutletIdFromHost } = require('./lib/outlet-canonicalize');
const { getOutletDisplayName } = require('./lib/review-normalization');
const { createOrMergeReviewFile } = require('./lib/review-file-writer');
const { buildManualReviewFields, detectIngestCollision } = require('./lib/manual-review-fields');

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
const dryRun = hasFlag('dry-run');
const forceClearStale = hasFlag('force-clear-stale-flag');
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

if (!showId || !url) {
  console.error('Usage: node scripts/ingest-review-from-url.js --show=ID --url=URL [--outlet=ID] [--critic=NAME] [--publish-date=YYYY-MM-DD] [--dry-run]');
  process.exit(1);
}

// Verify show exists before doing any expensive work.
const showsData = require('../data/shows.json');
const show = showsData.shows.find((s) => s.id === showId);
if (!show) {
  console.error(`Show not found: ${showId}`);
  process.exit(1);
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&apos;|&lsquo;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function extractByline(html) {
  if (!html) return null;
  const candidates = [
    // OpenGraph / standard meta tags — most authoritative when present.
    /<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i,
    // class="author-name" / "author" / "byline" — common WordPress / blog patterns.
    // Run BEFORE rel="author" because Jetpack's "View all posts by X" link in the
    // footer also has rel="author" and pollutes the value.
    /<[a-z]+[^>]+class=["'][^"']*author-name[^"']*["'][^>]*>([^<]+)</i,
    /<span[^>]+class=["'][^"']*byline[^"']*["'][^>]*>(?:By\s+)?([^<]+)<\/span>/i,
    /<p[^>]+class=["'][^"']*byline[^"']*["'][^>]*>(?:By\s+)?([^<]+)<\/p>/i,
    // Inline "By Name" prose near top of article — FMJ-style "By Ross" right
    // after the headline. Capture follows the literal "By " token.
    />By\s+([A-Z][A-Za-z][A-Za-z .'-]{1,38})(?=\s+(?:[A-Z]|<|—))/,
    // <a rel="author"> — last because of the Jetpack footer issue above.
    /<a[^>]+rel=["']author["'][^>]*>([^<]+)<\/a>/i,
  ];
  for (const re of candidates) {
    const m = html.match(re);
    if (m && m[1]) {
      let name = decodeEntities(m[1]).trim();
      // Strip Jetpack-style "View all posts by X" prefix that leaks through
      // some <a rel=author> matches.
      name = name.replace(/^view\s+all\s+posts\s+by\s+/i, '');
      if (!name || name.length < 2 || name.length > 80 || !/[A-Za-z]/.test(name)) continue;
      // Capitalize lowercase author slugs from class="author-name" (e.g. "ross" → "Ross").
      if (/^[a-z][a-z\s.'-]*$/.test(name)) {
        name = name.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      }
      return name;
    }
  }
  return null;
}

(async () => {
  console.log(`Ingesting single review: ${showId} ${url}`);

  let html;
  try {
    const r = await fetchPage(url, { source: 'process-review-submission' });
    html = (r && (r.content || r.html || r.body)) || (typeof r === 'string' ? r : null);
  } catch (e) {
    console.error(`Fetch failed: ${e.message}`);
    process.exit(1);
  }
  if (!html || typeof html !== 'string' || html.length < 500) {
    console.error(`Fetch returned no usable HTML (got ${html ? html.length : 0} chars)`);
    process.exit(1);
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
    const domain = _parseDomain(url);
    const { domainToOutlet, ambiguous } = _buildDomainMap();
    if (domain && !ambiguous.has(domain) && domainToOutlet[domain]) {
      outletId = domainToOutlet[domain];
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

  const text = extractArticleTextFromUrl(html, url, criticArg);
  // Star-rating fallback: UK star outlets (The Stage, Telegraph, Times, …)
  // serve recent articles as a registration wall with the review body absent
  // from server HTML — but the page's own StarRating block is still present.
  // For these outlets the star IS the score (policy: 177/177 thestage reviews
  // scored from stars), so an empty text extraction with a recoverable star
  // is a score-only ingest, not a failure. Card 3b5637c5 (NYSM Live).
  let recoveredScore = null;
  if (!text || text.length < 200) {
    const { extractScore, OUTLET_EXTRACTORS } = require('./lib/score-extractors');
    if (OUTLET_EXTRACTORS[outletId]) {
      recoveredScore = extractScore(html, '', outletId, show.title) || null;
    }
    // With no body there is no content-based wrong-show signal left for the
    // rebuild guards to scan, so require the show's title to appear somewhere
    // in the raw page HTML (normalized: punctuation-insensitive) before
    // accepting a score-only ingest — this path is reachable from the public
    // /submit-review form and automated SERP ingest.
    if (recoveredScore) {
      const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!norm(html).includes(norm(show.title))) {
        console.error(`Score-only fallback refused: show title "${show.title}" not found in page HTML — cannot verify this is the right show without body text.`);
        process.exit(1);
      }
    }
    if (!recoveredScore) {
      console.error(`Article extraction returned ${text ? text.length : 0} chars — pattern may be missing for this outlet. Add an entry to scripts/lib/article-extractor.js PATTERNS.`);
      process.exit(1);
    }
    console.log(`  → Body extraction empty (${text ? text.length : 0} chars) — recovered explicit rating from page HTML: ${recoveredScore.originalScore} (${recoveredScore.normalizedScore}/100) [${recoveredScore.source}]`);
  }
  const hasBody = !!(text && text.length >= 200);

  // For LSA, prefer the in-body "--Name" sign-off over the publisher meta tag.
  const lsaCritic = hasBody && /lightingandsoundamerica\.com/i.test(url) ? extractLsaByline(text) : null;
  const critic = criticArg || lsaCritic || extractByline(html) || 'Unknown';

  // Page-date extraction: when --publish-date wasn't supplied, pull it from
  // standard CMS metadata (article:published_time / JSON-LD / <time>). Without
  // this the review lands with publishDate:undefined, which fails-open through
  // the anticipatory-pre-opening gate and weakens temporal wrong-production
  // detection. (1minutecritic HR + Maids incident, 2026-05-28.)
  const publishDate = publishDateArg || extractPublishDate(html, url) || null;
  if (!publishDateArg && publishDate) {
    console.log(`  → Extracted publishDate from page metadata: ${publishDate}`);
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
  const showDir = path.join(__dirname, '..', 'data', 'review-texts', showId);
  const collision = detectIngestCollision({
    showDir,
    outletId,
    criticName: critic,
    url,
    publishDate: publishDate,
    // Revival/returning-production carve-out: a fresh review in this show's opening
    // window must not be blocked by a prior-production file (2026-07-04 WE fix).
    openingDate: show.openingDate,
    forceClearStale,
  });
  if (!collision.ok) {
    console.error(`\n❌ Refusing to ingest — collision with ${collision.file}`);
    console.error(`   reason: ${collision.reason}`);
    console.error(`   detail: ${JSON.stringify(collision.detail, null, 2)}`);
    console.error(`\nManual remediation required: rename or clear the existing file.`);
    process.exit(1);
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
  }, { dryRun });

  if (result.action === 'new') {
    console.log(`✅ Created: ${result.filepath}`);
  } else if (result.action === 'updated') {
    console.log(`✅ Updated: ${result.filepath}`);
  } else {
    console.log(`⚠️  Skipped: ${result.reason || result.action}`);
    if (!dryRun && result.action !== 'updated' && result.action !== 'new') {
      // Genuine no-op (already exists with this content) is acceptable.
    }
  }

  console.log('Done.');
})().catch((e) => {
  console.error('Ingest failed:', e.stack || e.message);
  process.exit(1);
});
