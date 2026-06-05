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
const { extractArticleTextFromUrl, extractPublishDate } = require('./lib/article-extractor');
const { resolveCanonicalOutletId, _parseDomain, _buildDomainMap } = require('./lib/outlet-canonicalize');
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
const provisional = hasFlag('provisional');

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

  const text = extractArticleTextFromUrl(html, url);
  if (!text || text.length < 200) {
    console.error(`Article extraction returned ${text ? text.length : 0} chars — pattern may be missing for this outlet. Add an entry to scripts/lib/article-extractor.js PATTERNS.`);
    process.exit(1);
  }

  const critic = criticArg || extractByline(html) || 'Unknown';

  // Page-date extraction: when --publish-date wasn't supplied, pull it from
  // standard CMS metadata (article:published_time / JSON-LD / <time>). Without
  // this the review lands with publishDate:undefined, which fails-open through
  // the anticipatory-pre-opening gate and weakens temporal wrong-production
  // detection. (1minutecritic HR + Maids incident, 2026-05-28.)
  const publishDate = publishDateArg || extractPublishDate(html) || null;
  if (!publishDateArg && publishDate) {
    console.log(`  → Extracted publishDate from page metadata: ${publishDate}`);
  }

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
    } else {
      console.error(`Could not resolve outlet from URL ${url} (domain="${domain}"). Pass --outlet=ID explicitly.`);
      process.exit(1);
    }
  }

  console.log(`╔══════════════════════════════════════════════════╗`);
  console.log(`║  Show:    ${show.title} (${showId})`);
  console.log(`║  Outlet:  ${outletName} (${outletId})`);
  console.log(`║  Critic:  ${critic}${criticArg ? '' : ' (extracted)'}`);
  console.log(`║  URL:     ${url}`);
  console.log(`║  Text:    ${text.length} chars`);
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
    forceClearStale,
  });
  if (!collision.ok) {
    console.error(`\n❌ Refusing to ingest — collision with ${collision.file}`);
    console.error(`   reason: ${collision.reason}`);
    console.error(`   detail: ${JSON.stringify(collision.detail, null, 2)}`);
    console.error(`\nManual remediation required: rename or clear the existing file.`);
    process.exit(1);
  }

  const fields = buildManualReviewFields({
    humanScore: null,
    provisional: false,
    fullText: text,
    originalScore: null,
    originalScoreSource: null,
    publishDate: publishDate,
  });

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
