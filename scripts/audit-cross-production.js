#!/usr/bin/env node
/**
 * Audit multi-production shows for cross-contamination.
 *
 * For each show with multiple productions that have review-text directories,
 * checks whether any review file's publish date is closer to a DIFFERENT
 * production's opening date than the one it's filed under.
 *
 * Also checks for duplicate files (same filename in multiple production dirs).
 */

const fs = require('fs');
const path = require('path');
const { urlYearFromPath } = require('./lib/review-guards');
const { GENERIC_VENUE_SLUGS } = require('./lib/venue-classification');

// ── CLI flags ────────────────────────────────────────────────────────────────
// --dry-run: additionally emit data/audit/same-title-confusion.json (the
// user-review gate artifact for the same-title-disambig plan, S1-T5/T6). The
// script is already read-only — this flag does NOT change that — it just adds
// a second output file with a curated schema. Existing
// data/audit/cross-production-audit.json is still written every run.
const DRY_RUN = process.argv.includes('--dry-run');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const showsData = require('../data/shows.json');
const shows = showsData.shows;

// Build title → [show objects] map
const byTitle = {};
shows.forEach(s => {
  const base = s.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  if (!byTitle[base]) byTitle[base] = [];
  byTitle[base].push(s);
});

// Find multi-production shows with review-texts in 2+ dirs
const multiProd = Object.entries(byTitle)
  .filter(([, arr]) => arr.length > 1)
  .map(([title, arr]) => {
    const withDirs = arr.filter(s => fs.existsSync(path.join(REVIEW_TEXTS_DIR, s.id)));
    return { title, shows: withDirs };
  })
  .filter(m => m.shows.length > 1);

/**
 * Convert a venue name to a URL-friendly slug fragment for substring matching.
 * Strips the trailing "Theatre"/"Theater" so we match the distinctive part of
 * the venue (e.g. "Ethel Barrymore Theatre" → "ethel-barrymore"). Returns null
 * for empty/short inputs (<4 chars) or for generic words that would over-match
 * arbitrary review URLs (e.g. "Broadway Theatre" → "broadway", which matches
 * every Broadway-related URL).
 *
 * @param {string|null|undefined} venue
 * @returns {string|null}
 */
// GENERIC_VENUE_SLUGS imported from ./lib/venue-classification — single source
// of truth shared with market-routing.js's same-title disambig branch. To add a
// new generic-overmatching venue, update venue-classification.js only.
function venueSlug(venue) {
  if (!venue || typeof venue !== 'string') return null;
  const cleaned = venue
    .toLowerCase()
    .replace(/\btheatre\b|\btheater\b/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned || cleaned.length < 5) return null;
  if (GENERIC_VENUE_SLUGS.has(cleaned)) return null;
  return cleaned;
}

/**
 * Year extracted from an opening-date string ("YYYY-MM-DD" → YYYY as number).
 * Returns null when missing/unparseable.
 */
function openingYear(dateLike) {
  if (!dateLike) return null;
  const d = new Date(dateLike);
  if (isNaN(d.getTime())) return null;
  return d.getUTCFullYear();
}

console.log(`Scanning ${multiProd.length} multi-production shows...\n`);

// Known WE-market URL patterns and outlet name fragments
const WE_URL_PATTERNS = [
  /timeout\.com\/london/i,
  /theguardian\.com\/stage/i,
  /westendwilma/i,
  /everything-theatre/i,
  /theatrecat/i,
  /londontheatre1/i,
  /whatsonstage/i,
  /thestage\.co\.uk/i,
  /broadwayworld\.com\/westend/i,
  /london-theatre/i,
  /theatre\.reviews/i,
  /stagedoor\.com/i,  // Stagedoor covers both, but filed-under market wins
];

const WE_OUTLET_FRAGMENTS = [
  'west-end-wilma', 'everything-theatre', 'theatrecat', 'londontheatre',
  'whatsonstage', 'london-theatre', 'the-stage', 'timeout-london',
];

function isWEShow(showId) {
  return showId.includes('west-end');
}

function isLikelyWEReview(review, outletFilename) {
  const url = (review.url || '').toLowerCase();
  if (WE_URL_PATTERNS.some(p => p.test(url))) return true;
  const outletPart = outletFilename.split('--')[0].toLowerCase();
  if (WE_OUTLET_FRAGMENTS.some(f => outletPart.includes(f))) return true;
  return false;
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(d1, d2) {
  return Math.abs((d1 - d2) / (1000 * 60 * 60 * 24));
}

/**
 * Evergreen / listing / tickets pages are NOT dated critic reviews — their
 * publishDate is a re-scrape/listing timestamp, so the date-proximity heuristic
 * mis-fires and points the review at whichever production happens to be opening
 * near the scrape date. (e.g. britishtheatre.com/.../titanique-musical-tickets
 * scraped 2026 → mis-attributed to the 2026 Broadway run while the text plainly
 * describes the West End Criterion staging it is correctly filed under.)
 * These are skipped for cross-production attribution entirely.
 *
 * @param {string|null|undefined} url
 * @returns {boolean}
 */
function isEvergreenListingUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  return (
    /(?:^|[\/-])tickets(?:[\/?#-]|$)/.test(u) ||  // .../titanique-musical-tickets, /tickets/
    /\/buy-tickets?\b/.test(u) ||
    /\/box-office\b/.test(u) ||
    /\/whats-on\//.test(u) ||
    /\/listings?\//.test(u) ||                     // nymag.com/listings/theater/...
    /\/shows?\/[^\/?#]*-tickets\b/.test(u)
  );
}

/**
 * True when the review BODY clearly names the venue of the production it is
 * filed under. When the prose says "...sails into the Criterion Theatre..." and
 * that IS the filed-under production's venue, the review is correctly filed
 * regardless of any date-proximity to another production — so we must never flag
 * it as cross-production. Uses the same slug normalisation as venueSlug() so
 * "Criterion Theatre" → "criterion" matches "...the Criterion Theatre...".
 *
 * IMPORTANT: matches fullText ONLY — never review.venue. The venue metadata
 * field is auto-populated from the filed-under show at ingestion, so including
 * it would make this a tautology that suppresses EVERY review (incl. genuine
 * cross-production misfiles whose body never mentions the venue). Verified
 * 2026-06-21: 2019 NY Post Broadway reviews misfiled under beetlejuice-west-end
 * -2026 carry venue="Prince Edward Theatre" but their bodies don't — body-only
 * preserves those legitimate detections.
 *
 * @param {object} review - parsed review-text JSON
 * @param {string|null} ownVenueSlug - venueSlug(prod.venue)
 * @returns {boolean}
 */
function contentMatchesFiledUnderVenue(review, ownVenueSlug) {
  if (!ownVenueSlug) return false;
  const hay = String(review.fullText || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  return hay.includes(ownVenueSlug);
}

const issues = [];
let totalFilesScanned = 0;
let totalDuplicates = 0;
let totalWrongProd = 0;
let totalAlreadyFlagged = 0;
let totalNullDateFallback = 0;
let totalNullDateAmbiguous = 0;
let totalSkippedEvergreen = 0;
let totalSkippedVenueConfirmed = 0;

for (const group of multiProd) {
  const productions = group.shows.map(s => ({
    id: s.id,
    openingDate: parseDate(s.openingDate),
    openingYear: openingYear(s.openingDate),
    closingDate: parseDate(s.closingDate),
    market: s.market,
    venue: s.venue || null,
    venueSlug: venueSlug(s.venue),
    dir: path.join(REVIEW_TEXTS_DIR, s.id)
  }));

  // Check for duplicate filenames across productions
  const filesByName = {};
  for (const prod of productions) {
    const files = fs.readdirSync(prod.dir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      if (!filesByName[f]) filesByName[f] = [];
      filesByName[f].push(prod.id);
    }
  }

  const dupes = Object.entries(filesByName).filter(([, ids]) => ids.length > 1);
  if (dupes.length > 0) {
    totalDuplicates += dupes.length;
  }

  // For each production, check if reviews belong to a different production
  for (const prod of productions) {
    const otherProds = productions.filter(p => p.id !== prod.id);
    if (!prod.openingDate) continue;

    const files = fs.readdirSync(prod.dir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      totalFilesScanned++;
      const filePath = path.join(prod.dir, file);
      let review;
      try {
        review = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch { continue; }

      // Skip already flagged or wrong-show (date proximity is meaningless for
      // files whose content doesn't match the current show at all).
      if (review.wrongProduction || review.wrongShow) {
        totalAlreadyFlagged++;
        continue;
      }

      // FP guard 1: evergreen/listing/tickets pages have an unreliable scrape
      // date — never claim cross-production for them. (titanique FP, 2026-06-21.)
      if (isEvergreenListingUrl(review.url)) {
        totalSkippedEvergreen++;
        continue;
      }

      // FP guard 2: the body clearly names the filed-under production's venue —
      // it is correctly filed regardless of date proximity to another run.
      if (contentMatchesFiledUnderVenue(review, prod.venueSlug)) {
        totalSkippedVenueConfirmed++;
        continue;
      }

      const pubDate = parseDate(review.publishDate);

      if (pubDate) {
        // Existing date-based path — unchanged.
        // Check if this review's publish date is closer to another production
        const distToOwn = daysBetween(pubDate, prod.openingDate);

        for (const other of otherProds) {
          if (!other.openingDate) continue;
          const distToOther = daysBetween(pubDate, other.openingDate);

          // Flag if review date is much closer to another production
          // AND is within 180 days of other's opening (to catch legitimate reviews)
          // AND is more than 365 days from own opening
          if (distToOther < distToOwn && distToOwn > 365 && distToOther < 180) {
            // Market-awareness: skip if this is a WE review correctly filed under a WE show
            // (the "closer" production is in a different market)
            if (isWEShow(prod.id) && !isWEShow(other.id) && isLikelyWEReview(review, file)) {
              continue;
            }
            totalWrongProd++;
            const issue = {
              file: `${prod.id}/${file}`,
              publishDate: review.publishDate,
              filedUnder: prod.id,
              filedUnderOpening: prod.openingDate.toISOString().split('T')[0],
              daysFromOwn: Math.round(distToOwn),
              closerTo: other.id,
              closerToOpening: other.openingDate.toISOString().split('T')[0],
              daysFromCloser: Math.round(distToOther),
              url: (review.url || '').substring(0, 80),
              hasDupeInCorrectDir: fs.existsSync(path.join(REVIEW_TEXTS_DIR, other.id, file)),
              matchReason: 'publish-date',
              confidence: 'high'
            };
            issues.push(issue);
          }
        }
        continue;
      }

      // ── Fallback path (S1-T4): publishDate is null/unparseable ───────────
      // Use the URL year (when present) and venue substring match to classify.
      // This catches the BWW-excerpt / aggregator class where reviews are
      // ingested without a parseable publishDate but the source URL still
      // encodes the publication year.
      const url = typeof review.url === 'string' ? review.url : '';
      if (!url) continue;
      const lowerUrl = url.toLowerCase();
      const urlYear = urlYearFromPath(url);

      // Try year match against productions: own opening year ± 1 wins (no flag).
      const ownYear = prod.openingYear;
      const ownYearMatches = urlYear != null && ownYear != null && Math.abs(urlYear - ownYear) <= 1;
      const ownVenueMatches = !!(prod.venueSlug && lowerUrl.includes(prod.venueSlug));
      // If url clearly points to the production it's filed under, leave alone.
      if (ownYearMatches || ownVenueMatches) continue;

      // Look for a different production that the URL more plausibly belongs to.
      let bestOther = null;
      let bestReason = null;
      let bestConfidence = null;
      for (const other of otherProds) {
        const otherYear = other.openingYear;
        const yearMatch = urlYear != null && otherYear != null && Math.abs(urlYear - otherYear) <= 1;
        const venueMatch = !!(other.venueSlug && lowerUrl.includes(other.venueSlug));
        // Market-awareness: skip if this is a WE review correctly filed under
        // a WE show but the candidate "other" is non-WE.
        if (isWEShow(prod.id) && !isWEShow(other.id) && isLikelyWEReview(review, file)) {
          continue;
        }
        if (yearMatch && venueMatch) {
          bestOther = other; bestReason = 'url-year+venue'; bestConfidence = 'high'; break;
        }
        if (yearMatch) {
          if (bestConfidence !== 'high') { bestOther = other; bestReason = 'url-year'; bestConfidence = 'high'; }
        } else if (venueMatch) {
          if (!bestConfidence) { bestOther = other; bestReason = 'venue'; bestConfidence = 'medium'; }
        }
      }

      if (bestOther) {
        totalNullDateFallback++;
        const issue = {
          file: `${prod.id}/${file}`,
          publishDate: null,
          filedUnder: prod.id,
          filedUnderOpening: prod.openingDate
            ? prod.openingDate.toISOString().split('T')[0]
            : null,
          closerTo: bestOther.id,
          closerToOpening: bestOther.openingDate
            ? bestOther.openingDate.toISOString().split('T')[0]
            : null,
          urlYear: urlYear,
          url: url.substring(0, 80),
          hasDupeInCorrectDir: fs.existsSync(path.join(REVIEW_TEXTS_DIR, bestOther.id, file)),
          matchReason: bestReason,
          confidence: bestConfidence
        };
        issues.push(issue);
      } else if (urlYear != null || lowerUrl) {
        // No year match, no venue match — ambiguous. Record but don't claim.
        totalNullDateAmbiguous++;
        issues.push({
          file: `${prod.id}/${file}`,
          publishDate: null,
          filedUnder: prod.id,
          filedUnderOpening: prod.openingDate
            ? prod.openingDate.toISOString().split('T')[0]
            : null,
          closerTo: null,
          closerToOpening: null,
          urlYear: urlYear,
          url: url.substring(0, 80),
          hasDupeInCorrectDir: false,
          matchReason: 'ambiguous',
          confidence: 'low'
        });
      }
    }
  }
}

// Sort issues by show title for readability
issues.sort((a, b) => a.filedUnder.localeCompare(b.filedUnder));

console.log(`Files scanned: ${totalFilesScanned}`);
console.log(`Already flagged (wrongProduction/wrongShow): ${totalAlreadyFlagged}`);
console.log(`Cross-production duplicates (same filename): ${totalDuplicates}`);
console.log(`Likely wrong-production reviews (date-based): ${totalWrongProd}`);
console.log(`Null-date fallback cross-prod candidates: ${totalNullDateFallback}`);
console.log(`Null-date ambiguous (no year/venue match): ${totalNullDateAmbiguous}`);
console.log(`Skipped — evergreen/listing/tickets URL: ${totalSkippedEvergreen}`);
console.log(`Skipped — body names filed-under venue: ${totalSkippedVenueConfirmed}`);
console.log('');

const dateIssues = issues.filter(i => i.matchReason === 'publish-date');
const fallbackIssues = issues.filter(i => i.matchReason === 'url-year+venue' || i.matchReason === 'url-year' || i.matchReason === 'venue');
const ambiguousIssues = issues.filter(i => i.matchReason === 'ambiguous');

if (dateIssues.length === 0 && fallbackIssues.length === 0 && ambiguousIssues.length === 0) {
  console.log('✅ No unflagged wrong-production reviews found!');
} else {
  if (dateIssues.length > 0) {
    console.log('⚠️  Likely wrong-production reviews (publish-date based):\n');
    for (const i of dateIssues) {
      console.log(`  ${i.file}`);
      console.log(`    Published: ${i.publishDate} (${i.daysFromOwn}d from ${i.filedUnder} opening ${i.filedUnderOpening})`);
      console.log(`    Closer to: ${i.closerTo} (${i.daysFromCloser}d from opening ${i.closerToOpening})`);
      console.log(`    Dupe in correct dir: ${i.hasDupeInCorrectDir ? 'YES' : 'no'}`);
      console.log(`    URL: ${i.url}`);
      console.log('');
    }
  }
  if (fallbackIssues.length > 0) {
    console.log(`⚠️  Null-date fallback candidates (URL year/venue heuristic):\n`);
    for (const i of fallbackIssues) {
      console.log(`  ${i.file}  [${i.confidence}/${i.matchReason}]`);
      console.log(`    URL year: ${i.urlYear ?? 'n/a'} | filed under ${i.filedUnder} (opened ${i.filedUnderOpening})`);
      console.log(`    Closer to: ${i.closerTo} (opened ${i.closerToOpening})`);
      console.log(`    Dupe in correct dir: ${i.hasDupeInCorrectDir ? 'YES' : 'no'}`);
      console.log(`    URL: ${i.url}`);
      console.log('');
    }
  }
  if (ambiguousIssues.length > 0) {
    console.log(`ℹ️  Null-date ambiguous (review with no parseable publishDate, no URL-year or venue hit) — ${ambiguousIssues.length} entries; see JSON output for detail.\n`);
  }
}

// Write machine-readable output
const output = {
  timestamp: new Date().toISOString(),
  totalScanned: totalFilesScanned,
  alreadyFlagged: totalAlreadyFlagged,
  crossProductionDupes: totalDuplicates,
  likelyWrongProduction: totalWrongProd,
  nullDateFallback: totalNullDateFallback,
  nullDateAmbiguous: totalNullDateAmbiguous,
  skippedEvergreenUrl: totalSkippedEvergreen,
  skippedVenueConfirmed: totalSkippedVenueConfirmed,
  issues
};
fs.writeFileSync(
  path.join(__dirname, '..', 'data', 'audit', 'cross-production-audit.json'),
  JSON.stringify(output, null, 2) + '\n'
);
console.log('Wrote data/audit/cross-production-audit.json');

// ── --dry-run: additional curated output for user-review gate (S1-T5) ───────
// Only includes entries with a positive signal (publish-date mismatch OR
// URL-year/venue fallback hit). Excludes the noisy "ambiguous" bucket.
if (DRY_RUN) {
  const reasonToSignals = (i) => {
    const signals = [];
    if (i.matchReason === 'publish-date') {
      signals.push('publish-date-mismatch');
      if (typeof i.daysFromOwn === 'number') signals.push(`days-from-own:${i.daysFromOwn}`);
      if (typeof i.daysFromCloser === 'number') signals.push(`days-from-closer:${i.daysFromCloser}`);
    }
    if (i.matchReason === 'url-year+venue') signals.push('url-year-match', 'venue-slug-match');
    if (i.matchReason === 'url-year') signals.push('url-year-match');
    if (i.matchReason === 'venue') signals.push('venue-slug-match');
    if (i.hasDupeInCorrectDir) signals.push('duplicate-in-suggested-dir');
    if (i.urlYear != null) signals.push(`url-year:${i.urlYear}`);
    return signals;
  };

  const positive = issues.filter(i => i.matchReason !== 'ambiguous' && i.closerTo);
  const findings = positive.map(i => ({
    currentShowId: i.filedUnder,
    suggestedShowId: i.closerTo,
    confidence: i.confidence,
    signals: reasonToSignals(i),
    reviewFile: path.join('data', 'review-texts', i.file),
    url: i.url,
    reason: i.matchReason,
  }));

  // Sort: high → medium → low, then by currentShowId for stable output
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => {
    const c = (order[a.confidence] ?? 9) - (order[b.confidence] ?? 9);
    if (c !== 0) return c;
    return a.currentShowId.localeCompare(b.currentShowId);
  });

  const dryRunOutput = {
    generatedAt: new Date().toISOString(),
    totalFindings: findings.length,
    findings,
  };
  fs.writeFileSync(
    path.join(__dirname, '..', 'data', 'audit', 'same-title-confusion.json'),
    JSON.stringify(dryRunOutput, null, 2) + '\n'
  );
  console.log(`Wrote data/audit/same-title-confusion.json (${findings.length} findings; --dry-run, no review-texts modified)`);
}
