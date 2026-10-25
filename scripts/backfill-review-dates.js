#!/usr/bin/env node
/**
 * backfill-review-dates.js — Fetch pages for undated reviews to extract publishDate.
 *
 * Lightweight alternative to collect-review-texts.js: only fetches the page to
 * extract datePublished from JSON-LD/meta tags. Does NOT re-collect full text.
 *
 * Usage:
 *   node scripts/backfill-review-dates.js [--limit=N] [--show=SHOW_ID] [--dry-run]
 *
 * Options:
 *   --limit=N            Max reviews to process (default: 50)
 *   --show=ID            Only process a specific show
 *   --dry-run            Show what would be updated without writing files
 *   --offset=N           Skip first N undated reviews (for batching)
 *   --domains=high-yield Only process reviews from high-yield domains (>70% date rate)
 *   --domains=a.com,b.com  Only process specific domains
 *   --prioritize         Sort high-yield domains first (even without --domains filter)
 *   --free-only          Only use free sources (cookies + Archive.org), no paid scrapers
 *   --retry-failed       Re-try reviews that previously failed (ignores dateBackfillAttempted marker)
 *   --recheck-dates      Instead of undated reviews, re-read the page date of reviews dated more than
 *                        2 days before opening night by a non-page source (needsOpeningWindowDateRecheck,
 *                        BRO-5674). Skips the URL and text pre-checks: only a page date replaces them.
 *
 * Source priority:
 *   1. URL pattern extraction (free, no fetch)
 *   2. Text regex from existing fullText (free, no fetch)
 *   3. Direct fetch with cookies (free, paywalled sites)
 *   4. Archive.org Wayback Machine (free)
 *   5. ScrapingBee/Bright Data (paid, only if --free-only NOT set)
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Load .env if available (launchd/cron/worktree runs don't inherit a login shell)
require('./lib/load-env').loadEnv();

const { fetchPage } = require('./lib/scraper');
const { safeWriteReview } = require('./lib/review-write-guard');
const { runPublishDateBackfillTriage } = require('./lib/publish-date-backfill-triage');
const { listShowDirs } = require('./lib/list-show-dirs');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `backfill-review-dates.js — Fetch pages for undated reviews to extract publishDate.

Usage:
  node scripts/backfill-review-dates.js [options]
  node scripts/backfill-review-dates.js --help, -h    print this usage and exit
`;
const args = process.argv.slice(2);
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '50');
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const dryRun = args.includes('--dry-run');
const offset = parseInt(args.find(a => a.startsWith('--offset='))?.split('=')[1] || '0');
const domainMode = args.find(a => a.startsWith('--domains='))?.split('=')[1]; // high-yield, custom list, or omit for all
const prioritize = args.includes('--prioritize'); // sort by high-yield domains first
const freeOnly = args.includes('--free-only'); // skip paid scrapers (Archive.org + direct fetch only)
const retryFailed = args.includes('--retry-failed'); // re-try reviews that previously failed backfill
const recheckDates = args.includes('--recheck-dates'); // BRO-5674: re-read early non-page dates
const { needsOpeningWindowDateRecheck, isDateRecheckCandidate, resolvePageDateReplacement } = require('./lib/publish-date-provenance');

// Rate limit Archive.org to ~6 req/min (CDX limit is ~15/min)
let lastArchiveRequest = 0;
const ARCHIVE_MIN_DELAY_MS = 1500;

// Domains with >70% existing date rate — HTML fetching works well on these
const HIGH_YIELD_DOMAINS = new Set([
  'hollywoodreporter.com', 'ew.com', 'nydailynews.com', 'vulture.com',
  'timeout.com', 'variety.com', 'theatermania.com', 'wsj.com', 'nypost.com',
  'deadline.com', 'observer.com', 'talkinbroadway.com', 'ny1.com',
  'telegraph.co.uk', 'newyorktheatreguide.com', 'standard.co.uk',
  'theaterlife.com', 'ft.com', 'whatsonstage.com', 'independent.co.uk',
  'thestage.co.uk', 'chicagotribune.com', 'nytimes.com', 'washingtonpost.com',
  'theguardian.com', 'npr.org', 'latimes.com', 'usatoday.com',
]);

// Domains that never/rarely have structured date metadata — skip to save API credits
const { SKIP_DOMAINS } = require('./lib/date-backfill-skip-domains');

// --- Date extraction from HTML: shared with collect-review-texts.js (BRO-5674) ---
const { extractPublishDateFromHtml, normalizeExtractedDate } = require('./lib/html-publish-date');

function extractDateFromText(text) {
  if (!text || text.length < 50) return null;
  const first500 = text.substring(0, 500);
  // Skip context words that indicate run dates, not publish dates
  const contextWords = /(?:running|runs|through|until|closes|closing|opened|opens|previews|performances)/i;

  const datePatterns = [
    /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}/gi,
    /\d{1,2}(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December),?\s+\d{4}/gi,
  ];

  const found = [];
  for (const pat of datePatterns) {
    let m;
    while ((m = pat.exec(first500)) !== null) {
      // Check surrounding context — reject if near run/closing date words
      const start = Math.max(0, m.index - 30);
      const context = first500.substring(start, m.index + m[0].length + 30);
      if (!contextWords.test(context)) {
        found.push(m[0]);
      }
    }
  }

  if (found.length === 1) {
    return normalizeExtractedDate(found[0]);
  }
  return null;
}

// Mark a review file as "attempted but failed" to skip on future runs.
// Writes dateBackfillAttempted + reason to avoid wasted re-processing.
function markAttempted(filePath, reason) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (recheckDates) {
      // A dated file keeps its date; record the recheck separately so the
      // undated sweep's marker means what it always meant.
      data.dateRecheckAttempted = new Date().toISOString();
      data.dateRecheckAttemptReason = reason;
      safeWriteReview(filePath, data);
      return;
    }
    data.dateBackfillAttempted = new Date().toISOString();
    data.dateBackfillAttemptReason = reason;
    safeWriteReview(filePath, data);
  } catch (e) { /* don't fail the whole run over this */ }
}

// --- Free fetchers (no API credits) ---

/**
 * Fetch HTML from Archive.org Wayback Machine. Free, no credits.
 * Uses the availability API to find the closest snapshot.
 */
async function fetchFromArchiveOrg(url) {
  // Rate limit
  const elapsed = Date.now() - lastArchiveRequest;
  if (elapsed < ARCHIVE_MIN_DELAY_MS) {
    await new Promise(r => setTimeout(r, ARCHIVE_MIN_DELAY_MS - elapsed));
  }
  lastArchiveRequest = Date.now();

  // Check availability
  const availUrl = `http://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
  const avail = await axios.get(availUrl, { timeout: 15000 });
  const snapshot = avail.data?.archived_snapshots?.closest;
  if (!snapshot || !snapshot.url) {
    throw new Error('No archive snapshot');
  }

  // Fetch the archived page
  const resp = await axios.get(snapshot.url, {
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    maxRedirects: 5,
  });
  return { html: resp.data, archiveTimestamp: snapshot.timestamp };
}

/**
 * Fetch HTML directly with cookies (for paywalled domains where we have cookies).
 * Free, no credits — uses local axios + cookie jar.
 */
async function fetchWithCookies(url) {
  const { loadCookiesForDomain } = require('./lib/cookie-loader');
  const domain = new URL(url).hostname.replace(/^www\./, '');
  const cookies = loadCookiesForDomain(domain);
  if (!cookies || cookies.length === 0) {
    throw new Error(`No cookies for ${domain}`);
  }

  // Build Cookie header
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  const resp = await axios.get(url, {
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      'Cookie': cookieHeader,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    maxRedirects: 5,
  });
  return { html: resp.data };
}

// --- Main ---

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const baseDir = path.join(__dirname, '..', 'data', 'review-texts');
  if (!fs.existsSync(baseDir)) {
    console.error('ERROR: data/review-texts/ not found');
    process.exit(1);
  }

  // Find all undated reviews with URLs
  const shows = listShowDirs(baseDir);

  let showById = new Map();
  if (recheckDates) {
    try {
      const sj = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
      showById = new Map((sj.shows || sj).map(s => [s.id, s]));
    } catch (e) {
      console.error('ERROR: --recheck-dates needs data/shows.json');
      process.exit(1);
    }
  }

  const candidates = [];
  let skippedDomain = 0;
  let skippedAttempted = 0;
  for (const show of shows) {
    if (showFilter && show !== showFilter) continue;
    const dir = path.join(baseDir, show);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        const wanted = recheckDates
          ? isDateRecheckCandidate(data, showById.get(show))
          : !data.publishDate;
        if (wanted && data.url && !data.wrongProduction && !data.wrongShow) {
          // Skip previously-attempted files unless --retry-failed is set
          const attempted = recheckDates ? data.dateRecheckAttempted : data.dateBackfillAttempted;
          if (attempted && !retryFailed) { skippedAttempted++; continue; }

          let domain;
          try { domain = new URL(data.url).hostname.replace(/^www\./, ''); } catch { continue; }

          // Skip known-zero-yield domains
          if (SKIP_DOMAINS.has(domain)) { skippedDomain++; continue; }

          // Domain filter: only include specified domains
          if (domainMode === 'high-yield' && !HIGH_YIELD_DOMAINS.has(domain)) continue;
          if (domainMode && domainMode !== 'high-yield') {
            // Custom comma-separated domain list
            const customDomains = new Set(domainMode.split(',').map(d => d.trim()));
            if (!customDomains.has(domain)) continue;
          }

          const isHighYield = HIGH_YIELD_DOMAINS.has(domain);
          candidates.push({ show, file, url: data.url, filePath: path.join(dir, file), domain, isHighYield });
        }
      } catch (e) { /* skip invalid JSON */ }
    }
  }

  // Sort: high-yield domains first (when --prioritize or --domains=high-yield)
  if (prioritize || domainMode === 'high-yield') {
    candidates.sort((a, b) => {
      if (a.isHighYield && !b.isHighYield) return -1;
      if (!a.isHighYield && b.isHighYield) return 1;
      return 0;
    });
  }

  console.log(`Found ${candidates.length} ${recheckDates ? 'early-dated reviews to recheck' : 'undated reviews'} with URLs`);
  if (skippedDomain > 0) console.log(`Skipped ${skippedDomain} reviews from zero-yield domains`);
  if (skippedAttempted > 0) console.log(`Skipped ${skippedAttempted} reviews already attempted (use --retry-failed to retry)`);
  console.log(`Domain filter: ${domainMode || 'all (no filter)'}`);
  if (offset > 0) console.log(`Skipping first ${offset}`);

  const batch = candidates.slice(offset, offset + limit);
  console.log(`Processing batch of ${batch.length} (limit=${limit}, offset=${offset})`);
  if (dryRun) console.log('DRY RUN — no files will be modified');

  let extracted = 0, failed = 0, errors = 0;
  const touchedFiles = new Set();

  for (let i = 0; i < batch.length; i++) {
    const { show, file, url, filePath } = batch[i];
    console.log(`\n[${i + 1}/${batch.length}] ${show}/${file}`);
    console.log(`  URL: ${url.substring(0, 100)}`);

    try {
      // A date parsed from the URL is never stored as publishDate (BRO-5614, CLAUDE.md
      // rule 3). The page's own date, found below, is the only source; a dateless
      // file is dated at rebuild time by resolveBackfillPublishDate.

      // Pre-check: try text-based extraction from existing fullText (free)
      {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (data.fullText && !recheckDates) {
          const textDate = extractDateFromText(data.fullText);
          if (textDate) {
            console.log(`  ✓ Date from text regex (no fetch needed): ${textDate}`);
            if (!dryRun) {
              data.publishDate = textDate;
              data.dateSource = 'text-regex-backfill';
              const result = safeWriteReview(filePath, data);
              if (result && result.wrote === false) { failed++; continue; }
              touchedFiles.add(path.relative(baseDir, filePath));
            }
            extracted++;
            continue;
          }
        }
      }

      // Try free sources first (no API credits). --recheck-dates tries the
      // live page (paid chain) before archive.org: an archived copy is only a
      // fallback there (dateSource html-archive-org is not trusted, BRO-5674).
      let html = null;
      let dateSource = null;

      const tryCookies = async () => {
        try {
          const result = await fetchWithCookies(url);
          if (result.html && result.html.length > 500) {
            html = result.html;
            dateSource = 'html-cookies';
            console.log('  → Got HTML via cookies (free)');
          }
        } catch (e) { /* try next */ }
      };
      const tryArchive = async () => {
        try {
          const result = await fetchFromArchiveOrg(url);
          if (result.html && result.html.length > 500) {
            html = result.html;
            dateSource = 'html-archive-org';
            console.log(`  → Got HTML via Archive.org (free, snapshot=${result.archiveTimestamp})`);
          }
        } catch (e) { /* try next */ }
      };
      const tryPaid = async () => {
        if (freeOnly) return;
        try {
          const result = await fetchPage(url, { timeout: 15000 });
          html = typeof result === 'string' ? result : (result?.html || result?.content || '');
          if (html && html.length > 100) {
            dateSource = 'html-paid';
            console.log('  → Got HTML via paid scraper');
          } else {
            html = null;
          }
        } catch (e) { /* fall through */ }
      };
      for (const step of recheckDates ? [tryCookies, tryPaid, tryArchive] : [tryCookies, tryArchive, tryPaid]) {
        if (html) break;
        await step();
      }

      if (!html) {
        console.log(freeOnly ? '  ✗ No free source available' : '  ✗ All sources failed');
        failed++;
        // BRO-5769: without a marker the scheduled free-only sweep re-picks the same unreachable files every
        // week and starves the rest. Recheck mode only; --retry-failed retries them (e.g. with paid scrapers).
        if (recheckDates && !dryRun) markAttempted(filePath, freeOnly ? 'no-free-source' : 'all-sources-failed');
        continue;
      }

      const date = extractPublishDateFromHtml(html, url);

      if (date) {
        console.log(`  ✓ Extracted date: ${date} (${dateSource})`);
        extracted++;
        const current = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        // BRO-5674: a page date more than 7 days from the stored one replaces it
        // only when the stored date is already in doubt (early, non-page).
        const decision = resolvePageDateReplacement({
          storedDate: recheckDates ? current.publishDate : null,
          pageDate: date,
          allowDivergent: recheckDates && needsOpeningWindowDateRecheck(current, showById.get(show)),
        });
        if (!decision.replace) {
          console.log(`  ✗ Page date ${date} is ${decision.divergentDays} days from stored ${current.publishDate}: kept as pageDateCandidate`);
          extracted--;
          failed++;
          if (!dryRun) {
            current.pageDateCandidate = date;
            current.pageDateCandidateSource = dateSource;
            current.needsDateRecheck = true;
            current.dateRecheckAttempted = new Date().toISOString();
            current.dateRecheckAttemptReason = 'page-date-diverges';
            safeWriteReview(filePath, current);
          }
        } else if (!dryRun) {
          const data = current;
          if (recheckDates && data.publishDate !== date) console.log(`  → replaces ${data.publishDate} (${data.dateSource || 'no dateSource'})`);
          delete data.pageDateCandidate;
          delete data.pageDateCandidateSource;
          data.publishDate = date;
          data.dateSource = dateSource;
          delete data.dateBackfillAttempted; // clear failed marker on success
          delete data.dateRecheckAttempted;
          // A live-page date is trusted; an archived copy keeps the file marked (BRO-5674).
          // Marked attempted too, so the next sweep does not refetch the same snapshot (--retry-failed does).
          if (dateSource === 'html-archive-org' && recheckDates) {
            data.needsDateRecheck = true;
            data.dateRecheckAttempted = new Date().toISOString();
            data.dateRecheckAttemptReason = 'archive-copy-only';
          } else {
            delete data.needsDateRecheck;
          }
          const result = safeWriteReview(filePath, data, { force: true });
          if (result && result.wrote === false) {
            extracted--;
            failed++;
          } else {
            touchedFiles.add(path.relative(baseDir, filePath));
          }
        }
      } else {
        console.log('  ✗ No date in HTML metadata');
        failed++;
        if (!dryRun) markAttempted(filePath, 'no-date-in-html');
      }
    } catch (e) {
      console.log(`  ✗ Error: ${e.message}`);
      errors++;
      if (!dryRun) markAttempted(filePath, `error:${e.message.substring(0, 50)}`);
    }

    // Rate limiting: 2 seconds between fetches
    if (i < batch.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  runPublishDateBackfillTriage({ touchedFiles, dryRun, repoRoot: path.resolve(__dirname, '..') });

  console.log(`\n=== SUMMARY ===`);
  console.log(`Processed: ${batch.length}`);
  console.log(`Dates extracted: ${extracted} (${(extracted / batch.length * 100).toFixed(0)}%)`);
  console.log(`No date found: ${failed}`);
  console.log(`Errors: ${errors}`);
  console.log(`Remaining undated: ${candidates.length - offset - extracted}`);

  process.exit(0);
}

// Never run on require() (BRO-5261 S11: a load test wrote corpus files).
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
