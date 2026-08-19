#!/usr/bin/env node
/**
 * backfill-network-tier-dates.js — BRO-70 network-tier publishDate backfill.
 *
 * Scoped (unlike backfill-review-dates.js, which sweeps the WHOLE review-texts
 * corpus including non-scored garbage/listing pages) to the set of reviews
 * that are already live in reviews.json (i.e. passed every inclusion guard)
 * and only missing a publishDate. That avoids stamping plausible-looking wrong
 * dates onto ticket-vendor / listing pages that happen to sit in review-texts
 * but never made it into the scored corpus (see BRO-70 session notes).
 *
 * Tier order per candidate: URL pattern -> text regex on fullText -> cookies
 * (free) -> archive.org (free) -> fetchPage() paid chain (Scrapingdog ->
 * Bright Data -> ScrapingBee -> Playwright -> Browserbase) -> HTML metadata
 * extraction. Concurrent workers (default 6) since fully-sequential 2s/item
 * throttling can't clear ~2000 candidates in a single session.
 *
 * Usage:
 *   node scripts/backfill-network-tier-dates.js [--limit=N] [--concurrency=N]
 *     [--free-only] [--dry-run] [--show=ID]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { loadEnv } = require('./lib/load-env');
loadEnv();

const { fetchPage, verifyFetchedUrl } = require('./lib/scraper');
const { extractDateFromUrl } = require('./lib/rebuild-helpers');
const { safeWriteReview } = require('./lib/review-write-guard');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `backfill-network-tier-dates.js — BRO-70 scoped network-tier publishDate backfill.

Usage:
  node scripts/backfill-network-tier-dates.js [options]
  node scripts/backfill-network-tier-dates.js --help, -h    print this usage and exit
`;

const args = process.argv.slice(2);
if (hasHelpFlag(args)) { console.log(USAGE); process.exit(0); }

const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '100000', 10);
const concurrency = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '6', 10);
const freeOnly = args.includes('--free-only');
const dryRun = args.includes('--dry-run');
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];

const REPO_ROOT = path.resolve(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(REPO_ROOT, 'data', 'review-texts');
const PROGRESS_PATH = path.join(REPO_ROOT, 'data', 'audit', 'bro70-network-tier-progress.json');

const SKIP_DOMAINS = new Set([
  'cititour.com', 'nytheatre.com', 'stagedoor.com', 'lightingandsoundamerica.com',
]);

// ---- HTML date extraction (mirrors backfill-review-dates.js) ----
function normalizeExtractedDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  try {
    const m = dateStr.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) {
      const year = parseInt(m[1], 10), month = parseInt(m[2], 10), day = parseInt(m[3], 10);
      if (year < 1970 || year > 2030) return null;
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    const year = d.getFullYear();
    if (year < 1970 || year > 2030) return null;
    return `${year}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch (e) { return null; }
}

function extractPublishDateFromHtml(html) {
  if (!html || html.length < 100) return null;

  const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1].trim());
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        const date = item.datePublished || item.dateCreated;
        if (date) {
          const normalized = normalizeExtractedDate(date);
          if (normalized) return normalized;
        }
      }
    } catch (e) { /* invalid JSON-LD, skip */ }
  }

  const metaSelectors = [
    /meta[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i,
    /meta[^>]*content=["']([^"']+)["'][^>]*property=["']article:published_time["']/i,
    /meta[^>]*property=["']og:article:published_time["'][^>]*content=["']([^"']+)["']/i,
    /meta[^>]*name=["']date["'][^>]*content=["']([^"']+)["']/i,
    /meta[^>]*name=["']DC\.date\.issued["'][^>]*content=["']([^"']+)["']/i,
  ];
  for (const regex of metaSelectors) {
    const m = html.match(regex);
    if (m && m[1]) {
      const normalized = normalizeExtractedDate(m[1]);
      if (normalized) return normalized;
    }
  }

  const timeMatch = html.match(/<time[^>]*datetime=["']([^"']+)["'][^>]*>/i);
  if (timeMatch && timeMatch[1]) {
    const normalized = normalizeExtractedDate(timeMatch[1]);
    if (normalized) return normalized;
  }

  const stageMatch = html.match(/aos-ArticleDate[^>]*>((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s*\d{4})/i);
  if (stageMatch && stageMatch[1]) {
    const normalized = normalizeExtractedDate(stageMatch[1]);
    if (normalized) return normalized;
  }

  return null;
}

const RUN_DATE_WORDS = /\b(through|until|closing|effective|expires|ends|extended|running|booking|playing|performances?|opens|opening|previews?)\b/i;
function extractDateFromText(text) {
  if (!text || text.length < 50) return null;
  const first500 = text.substring(0, 500);
  const patterns = [
    /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}/gi,
    /\d{1,2}(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December),?\s+\d{4}/gi,
  ];
  const found = [];
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(first500)) !== null) {
      const start = Math.max(0, m.index - 30);
      const context = first500.substring(start, m.index + m[0].length + 30);
      if (!RUN_DATE_WORDS.test(context)) found.push(m[0]);
    }
  }
  if (found.length === 1) return normalizeExtractedDate(found[0]);
  return null;
}

function markAttempted(filePath, reason) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.dateBackfillAttempted = new Date().toISOString();
    data.dateBackfillAttemptReason = reason;
    safeWriteReview(filePath, data);
  } catch (e) { /* best-effort marker */ }
}

// ---- Free network fetchers ----
// Archive.org CDX limit is ~15/min. A per-call "check elapsed, then go" guard
// races under concurrency (N workers can all pass the check before any of
// them updates the timestamp), which is what actually happened in testing —
// concurrency=8 produced a wall of 429s and a 0% free-tier yield. Queue every
// archive.org call through one mutex chain so the delay is enforced serially.
let archiveQueue = Promise.resolve();
const ARCHIVE_MIN_DELAY_MS = 4500; // ~13/min, under the ~15/min CDX limit

function queueArchiveRequest(fn) {
  const run = archiveQueue.then(async () => {
    try {
      return await fn();
    } finally {
      // Delay must fire on failure too — "no snapshot" (the common case for
      // old dead links) rejects fast, and without this the queue would fire
      // rapid-fire lookups and 429 exactly like the un-queued version did.
      await new Promise(r => setTimeout(r, ARCHIVE_MIN_DELAY_MS));
    }
  });
  archiveQueue = run.catch(() => {});
  return run;
}

async function fetchFromArchiveOrg(url) {
  return queueArchiveRequest(() => fetchFromArchiveOrgOnce(url));
}

async function fetchFromArchiveOrgOnce(url) {
  const availUrl = `http://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
  const avail = await axios.get(availUrl, { timeout: 15000 });
  const snapshot = avail.data?.archived_snapshots?.closest;
  if (!snapshot || !snapshot.url) throw new Error('No archive snapshot');
  const resp = await axios.get(snapshot.url, {
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    maxRedirects: 5,
  });
  return { html: resp.data, archiveTimestamp: snapshot.timestamp };
}

// Plain unauthenticated GET — no cookies, no proxy. Free, no rate limit
// beyond normal HTTP concurrency. Many small theater blogs / WordPress sites
// serve to any UA; this only helps where fetchWithCookies doesn't apply
// (non-paywalled), so it's tried first and costs nothing on failure (403s /
// blocks fall straight through to archive.org).
// A dead article commonly 30x-redirects to a homepage/search/not-found page
// that still serves 200 with ITS OWN metadata. verifyFetchedUrl() (canonical
// tag comparison) misses this when the bounce page has no canonical tag at
// all — confirmed live (an EW dead-link redirect produced a "2025-11-02"
// date on a 2010 review with no canonical to catch it). Cross-checking the
// axios-reported final URL after redirects closes that gap independent of
// page content.
function isRedirectBounce(responseUrl, requestedUrl) {
  if (!responseUrl) return false;
  try {
    const req = new URL(requestedUrl);
    const res = new URL(responseUrl);
    if (req.pathname.length > 1 && (res.pathname === '/' || res.pathname === '')) return true;
    const reqHost = req.hostname.replace(/^www\./, '');
    const resHost = res.hostname.replace(/^www\./, '');
    // Confirmed live: a dead newyork.timeout.com article 301'd to
    // timeout.com/newyork (their NYC section homepage, not the article) with
    // a wildly wrong date, and passed both a naive hostname-suffix check
    // (every subdomain "ends with" its parent domain) and a bare pathname
    // !== '/' check. Require the response path to retain the request's own
    // distinguishing slug/ID whenever the path actually changed — same-host
    // bounces to a generic non-root page (search/section/404-with-200) are
    // just as wrong as cross-host ones.
    const segments = req.pathname.split('/').filter(Boolean);
    const lastSegment = segments[segments.length - 1] || '';
    const distinctive = lastSegment.replace(/\.\w+$/, ''); // drop .html etc
    if (distinctive.length >= 5 && req.pathname !== res.pathname && !res.pathname.includes(distinctive)) return true;
    if (reqHost !== resHost && !resHost.endsWith('.' + reqHost) && !reqHost.endsWith('.' + resHost)) return true;
  } catch (e) { /* can't parse, don't block on this signal */ }
  return false;
}

async function fetchPlain(url) {
  const resp = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  if (isRedirectBounce(resp.request?.res?.responseUrl, url)) throw new Error('redirect-bounce');
  return { html: resp.data };
}

async function fetchWithCookies(url) {
  const { loadCookiesForDomain } = require('./lib/cookie-loader');
  const domain = new URL(url).hostname.replace(/^www\./, '');
  const cookies = loadCookiesForDomain(domain);
  if (!cookies || cookies.length === 0) throw new Error(`No cookies for ${domain}`);
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
  if (isRedirectBounce(resp.request?.res?.responseUrl, url)) throw new Error('redirect-bounce');
  return { html: resp.data };
}

// Serializes fetchPage() calls (see comment at call site) without blocking
// the free tiers, which stay fully concurrent.
let fetchPageMutex = Promise.resolve();
function withFetchPageMutex(fn) {
  const run = fetchPageMutex.then(fn, fn);
  fetchPageMutex = run.catch(() => {});
  return run;
}

// ---- Candidate discovery: reviews.json undated ∩ review-texts file ----
function findCandidates() {
  const reviewsData = require(path.join(REPO_ROOT, 'data', 'reviews.json'));
  const list = reviewsData.reviews;
  const candidates = [];
  let noFile = 0, alreadyDated = 0, noUrl = 0;

  for (const r of list) {
    if (!r.url) { noUrl++; continue; }
    if (showFilter && r.showId !== showFilter) continue;
    if (r.publishDate) continue; // reviews.json snapshot may be stale vs a prior tier pass

    const showDir = path.join(REVIEW_TEXTS_DIR, r.showId);
    if (!fs.existsSync(showDir)) { noFile++; continue; }

    let found = null;
    for (const f of fs.readdirSync(showDir)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(showDir, f);
      let data;
      try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { continue; }
      if (data.url === r.url) { found = { filePath: fp, data }; break; }
    }
    if (!found) { noFile++; continue; }
    if (found.data.publishDate) { alreadyDated++; continue; }
    if (found.data.wrongProduction || found.data.wrongShow) continue;

    let domain;
    try { domain = new URL(r.url).hostname.replace(/^www\./, ''); } catch (e) { continue; }
    if (SKIP_DOMAINS.has(domain)) continue;

    candidates.push({ showId: r.showId, url: r.url, filePath: found.filePath, domain });
  }

  console.log(`Candidates: ${candidates.length} (noFile=${noFile}, alreadyDated=${alreadyDated}, noUrl=${noUrl})`);
  return candidates;
}

async function processOne(cand, stats) {
  const { filePath, url, showId } = cand;
  try {
    const urlDate = extractDateFromUrl(url);
    if (urlDate && urlDate.date) {
      if (!dryRun) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        data.publishDate = urlDate.date;
        data.dateSource = `url-backfill-${urlDate.source}`;
        safeWriteReview(filePath, data);
      }
      stats.extracted++; stats.touchedShows.add(showId);
      console.log(`  [url] ${showId}: ${urlDate.date}`);
      return;
    }

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (raw.fullText) {
      const textDate = extractDateFromText(raw.fullText);
      if (textDate) {
        if (!dryRun) {
          raw.publishDate = textDate;
          raw.dateSource = 'text-regex-backfill';
          safeWriteReview(filePath, raw);
        }
        stats.extracted++; stats.touchedShows.add(showId);
        console.log(`  [text] ${showId}: ${textDate}`);
        return;
      }
    }

    // A dead/moved article commonly 30x-redirects to a homepage or generic
    // "not found" page that still returns 200 with ITS OWN date metadata —
    // stamping that date onto this review would be silently, badly wrong
    // (BRO-70 incident class). verifyFetchedUrl() checks the returned page's
    // own canonical/og:url (and homepage-title heuristic) against the URL we
    // asked for; only fetchPage()'s paid tier does this natively, so every
    // free-tier fetch below is checked here before its HTML is trusted.
    // Wayback's playback proxy rewrites <link rel=canonical> to point at its
    // own wrapper URL ("http://web.archive.org/web/<ts>/<original>", or the
    // host-relative "/web/<ts>/<original>"), not the original article — so
    // verifyFetchedUrl's plain comparison always reports url_mismatch on
    // archive.org fetches. Unwrap and compare the real original URL instead.
    const WAYBACK_WRAPPER_RE = /^(?:https?:\/\/web\.archive\.org)?\/web\/\d+(?:[a-z_*]*)?\/(https?:\/\/.+)$/i;
    function unwrapWayback(actual) {
      const m = (actual || '').match(WAYBACK_WRAPPER_RE);
      return m ? m[1] : null;
    }
    function verifiedOrNull(result, label, { isArchive = false } = {}) {
      if (!result || !result.html || result.html.length <= 500) return null;
      const vr = verifyFetchedUrl(result.html, url);
      if (vr.verified) return result.html;
      if (isArchive && vr.reason === 'url_mismatch' && vr.actual) {
        const unwrapped = unwrapWayback(vr.actual);
        if (unwrapped && !isRedirectBounce(unwrapped, url)) return result.html;
      }
      console.log(`  [rejected:${vr.reason}] ${showId} (${label}) actual=${(vr.actual || '').slice(0, 80)}`);
      return null;
    }

    let html = null, dateSource = null;
    try {
      const result = await fetchPlain(url);
      const h = verifiedOrNull(result, 'html-plain');
      if (h) { html = h; dateSource = 'html-plain'; }
    } catch (e) { /* next */ }

    if (!html) {
      try {
        const result = await fetchWithCookies(url);
        const h = verifiedOrNull(result, 'html-cookies');
        if (h) { html = h; dateSource = 'html-cookies'; }
      } catch (e) { /* next */ }
    }

    if (!html) {
      try {
        const result = await fetchFromArchiveOrg(url);
        const h = verifiedOrNull(result, 'html-archive-org', { isArchive: true });
        if (h) { html = h; dateSource = 'html-archive-org'; }
      } catch (e) { /* next */ }
    }

    if (!html && !freeOnly) {
      try {
        // fetchPage()'s Playwright fallback uses a shared module-level browser
        // singleton (scripts/lib/scraper.js) that is not concurrency-safe — a
        // failing call closes+nulls it out from under an in-flight sibling
        // call ("Target page, context or browser has been closed"). Serialize
        // this tier only; free tiers above stay concurrent.
        const result = await withFetchPageMutex(() => fetchPage(url, { timeout: 15000 }));
        const h = typeof result === 'string' ? result : (result?.html || result?.content || '');
        if (h && h.length > 100) { html = h; dateSource = 'html-paid'; }
      } catch (e) { /* next */ }
    }

    if (!html) {
      stats.failed++;
      console.log(`  [miss] ${showId} ${url.slice(0, 70)}`);
      if (!dryRun) markAttempted(filePath, freeOnly ? 'no-free-source' : 'all-sources-failed');
      return;
    }

    const date = extractPublishDateFromHtml(html);
    if (date) {
      if (!dryRun) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        data.publishDate = date;
        data.dateSource = dateSource;
        delete data.dateBackfillAttempted;
        safeWriteReview(filePath, data, { force: true });
      }
      stats.extracted++; stats.touchedShows.add(showId);
      console.log(`  [${dateSource}] ${showId}: ${date}`);
    } else {
      stats.failed++;
      console.log(`  [no-date-in-html] ${showId} (${dateSource})`);
      if (!dryRun) markAttempted(filePath, 'no-date-in-html');
    }
  } catch (e) {
    stats.errors++;
    console.log(`  [error] ${showId}: ${e.message}`);
    if (!dryRun) markAttempted(filePath, `error:${e.message.substring(0, 50)}`);
  }
}

async function runPool(items, worker, size) {
  let idx = 0;
  let inFlight = 0;
  return new Promise((resolve) => {
    function next() {
      if (idx >= items.length && inFlight === 0) return resolve();
      while (inFlight < size && idx < items.length) {
        const item = items[idx++];
        inFlight++;
        worker(item).finally(() => {
          inFlight--;
          next();
        });
      }
    }
    next();
  });
}

async function main() {
  const candidates = findCandidates();
  const batch = candidates.slice(0, limit);
  console.log(`Processing ${batch.length} (concurrency=${concurrency}, freeOnly=${freeOnly}, dryRun=${dryRun})`);

  const stats = { extracted: 0, failed: 0, errors: 0, touchedShows: new Set() };
  const startedAt = Date.now();
  let processed = 0;

  await runPool(batch, async (cand) => {
    await processOne(cand, stats);
    processed++;
    if (processed % 25 === 0 || processed === batch.length) {
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(`\n--- progress ${processed}/${batch.length} extracted=${stats.extracted} failed=${stats.failed} errors=${stats.errors} elapsed=${elapsedSec}s ---\n`);
      if (!dryRun) {
        fs.mkdirSync(path.dirname(PROGRESS_PATH), { recursive: true });
        fs.writeFileSync(PROGRESS_PATH, JSON.stringify({
          processed, total: batch.length, extracted: stats.extracted, failed: stats.failed,
          errors: stats.errors, touchedShows: Array.from(stats.touchedShows), updatedAt: new Date().toISOString(),
        }, null, 2));
      }
    }
  }, concurrency);

  console.log(`\n=== SUMMARY ===`);
  console.log(`Processed: ${batch.length}`);
  console.log(`Extracted: ${stats.extracted}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(`Errors: ${stats.errors}`);
  console.log(`Touched shows: ${stats.touchedShows.size}`);
  if (!dryRun) {
    fs.mkdirSync(path.dirname(PROGRESS_PATH), { recursive: true });
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify({
      done: true, processed: batch.length, extracted: stats.extracted, failed: stats.failed,
      errors: stats.errors, touchedShows: Array.from(stats.touchedShows), updatedAt: new Date().toISOString(),
    }, null, 2));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
